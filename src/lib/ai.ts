import Anthropic from '@anthropic-ai/sdk';
import { LANGUAGES, type Lang } from './languages';
import type { AiProvider, ExplainContext, Explanation } from './types';

const systemPrompt = (lang: Lang) => `You help an English-speaking learner read real ${LANGUAGES[lang].name} web pages.
Given a ${LANGUAGES[lang].name} word and where it appears, explain what the word means in THIS spot on THIS page.
The "sentence" is often just a heading, menu item or button label. Then use the page title, the site, and the
other places the word appears on the page to work out the intended meaning (e.g. Spanish "Cuenta" on a Microsoft
settings page is "Account", not "count").
Keep "meaning" to the 1–4 word English equivalent that fits here. For a selected phrase or sentence, put its full
natural translation in "sentenceTranslation".
Keep "explanation" to one or two short, friendly sentences: why this meaning fits, plus any useful note (tense, idiom, regional use, false friend). No preamble.`;

/** JSON schema shared by all providers. */
const SCHEMA = {
  type: 'object',
  properties: {
    meaning: { type: 'string', description: 'English equivalent of the word or phrase in this context, as short as possible.' },
    lemma: { type: 'string', description: 'Dictionary form of the word (infinitive for verbs, singular for nouns).' },
    partOfSpeech: { type: 'string', description: 'e.g. noun, verb, adjective, preposition.' },
    explanation: { type: 'string', description: 'One or two short sentences for the learner.' },
    sentenceTranslation: { type: 'string', description: 'Natural English translation of the whole sentence.' },
  },
  required: ['meaning', 'lemma', 'partOfSpeech', 'explanation', 'sentenceTranslation'],
  additionalProperties: false,
} as const;

function userPrompt(word: string, sentence: string, context?: ExplainContext): string {
  const label = /\s/.test(word.trim()) ? 'Phrase' : 'Word';
  const lines = [`${label}: ${word}`, `Sentence: ${sentence || word}`];
  if (context?.title || context?.site) lines.push(`Page: "${context.title}" (${context.site})`);
  if (context?.snippets.length) lines.push('The word elsewhere on the page:', ...context.snippets.map((s) => `- ${s}`));
  return lines.join('\n');
}

function parseExplanation(text: string | undefined | null): Explanation {
  if (!text) throw new Error('The AI returned an empty answer.');
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const data = JSON.parse(json) as Partial<Explanation>;
  if (!data.meaning) throw new Error('The AI answer was missing a meaning.');
  return {
    meaning: data.meaning,
    lemma: data.lemma ?? '',
    partOfSpeech: data.partOfSpeech ?? '',
    explanation: data.explanation ?? '',
    sentenceTranslation: data.sentenceTranslation ?? '',
  };
}

async function explainWithClaude(
  apiKey: string,
  model: string,
  word: string,
  sentence: string,
  lang: Lang,
  context?: ExplainContext,
): Promise<Explanation> {
  // This runs inside your own extension with your own key, so browser use is intended here.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: systemPrompt(lang),
      messages: [{ role: 'user', content: userPrompt(word, sentence, context) }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to answer this one.');
    if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try again.');
    const text = response.content.find((b) => b.type === 'text');
    return parseExplanation(text?.type === 'text' ? text.text : null);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new Error('Your Claude API key was rejected. Check it in Settings.');
    if (error instanceof Anthropic.NotFoundError) throw new Error(`Claude model "${model}" was not found. Check it in Settings.`);
    if (error instanceof Anthropic.RateLimitError) throw new Error('Claude rate limit reached. Try again in a moment.');
    if (error instanceof Anthropic.APIError) throw new Error(`Claude API error ${error.status ?? ''}: ${error.message}`);
    throw error;
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? res.statusText;
    if (res.status === 401 || res.status === 403) throw new Error(`Your API key was rejected (${msg}). Check it in Settings.`);
    throw new Error(`API error ${res.status}: ${msg}`);
  }
  return data;
}

async function explainWithOpenAI(
  apiKey: string,
  model: string,
  word: string,
  sentence: string,
  lang: Lang,
  context?: ExplainContext,
): Promise<Explanation> {
  const data = await postJson(
    'https://api.openai.com/v1/chat/completions',
    { authorization: `Bearer ${apiKey}` },
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt(lang) },
        { role: 'user', content: userPrompt(word, sentence, context) },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'explanation', strict: true, schema: SCHEMA } },
    },
  );
  return parseExplanation(data?.choices?.[0]?.message?.content);
}

async function explainWithGemini(
  apiKey: string,
  model: string,
  word: string,
  sentence: string,
  lang: Lang,
  context?: ExplainContext,
): Promise<Explanation> {
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': apiKey },
    {
      systemInstruction: {
        parts: [{ text: `${systemPrompt(lang)}\nReply with JSON only, with keys: ${SCHEMA.required.join(', ')}.` }],
      },
      contents: [{ role: 'user', parts: [{ text: userPrompt(word, sentence, context) }] }],
      generationConfig: { responseMimeType: 'application/json' },
    },
  );
  return parseExplanation(data?.candidates?.[0]?.content?.parts?.[0]?.text);
}

export async function explain(
  provider: AiProvider,
  apiKey: string,
  model: string,
  word: string,
  sentence: string,
  lang: Lang,
  context?: ExplainContext,
): Promise<Explanation> {
  switch (provider) {
    case 'anthropic':
      return explainWithClaude(apiKey, model, word, sentence, lang, context);
    case 'openai':
      return explainWithOpenAI(apiKey, model, word, sentence, lang, context);
    case 'gemini':
      return explainWithGemini(apiKey, model, word, sentence, lang, context);
    default:
      throw new Error('No AI provider is set up. Add one in Settings.');
  }
}
