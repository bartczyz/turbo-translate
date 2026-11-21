import { LANGUAGES, type Lang } from './languages';

const cachedVoices = new Map<string, SpeechSynthesisVoice | null>();

/**
 * The best installed voice for a language. `region` (e.g. "pt-PT", from the page) wins over the default
 * preference, so European Portuguese pages are read with a European voice.
 */
function voiceFor(lang: Lang, region?: string): SpeechSynthesisVoice | null {
  const cacheKey = `${lang}|${region ?? ''}`;
  const cached = cachedVoices.get(cacheKey);
  if (cached !== undefined) return cached;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null; // Voices load async; try again next time.
  const prefs = [...(region ? [region.toLowerCase()] : []), ...LANGUAGES[lang].voices.map((v) => v.toLowerCase())];
  const ours = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const score = (v: SpeechSynthesisVoice) => {
    const at = prefs.indexOf(v.lang.toLowerCase().replace('_', '-'));
    return (/google|natural|neural|premium|enhanced/i.test(v.name) ? 2 : 0) + (at >= 0 ? (prefs.length - at) * 3 : 0);
  };
  const best = ours.sort((a, b) => score(b) - score(a))[0] ?? null;
  cachedVoices.set(cacheKey, best);
  return best;
}

/** `region`: a full language tag like "pt-PT" when the page declares one. */
export function speak(text: string, lang: Lang, rate = 0.9, region?: string): void {
  if (!('speechSynthesis' in globalThis)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const regional = region?.toLowerCase().startsWith(`${lang}-`) ? region : undefined;
  u.lang = regional ?? LANGUAGES[lang].voices[0]!;
  u.rate = rate;
  const voice = voiceFor(lang, regional);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  speechSynthesis.speak(u);
}
