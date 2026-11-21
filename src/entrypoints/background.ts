import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { explain } from '@/lib/ai';
import { lookup } from '@/lib/dictionary';
import { LANGUAGES, languageName, type Lang } from '@/lib/languages';
import { getWord, migrateLegacyDeck, recordLookup, saveWord, setStatus, unsaveWords } from '@/lib/words';
import { handleMessages } from '@/lib/messaging';
import { getApiKeys, getSettings, modelFor, updateSettings, watchSettings } from '@/lib/settings';
import type { ExplainContext, Explanation, PageStatus, Settings } from '@/lib/types';

const explainCache = new Map<string, Explanation>();
const MAX_CACHE = 300;

async function runExplain(word: string, sentence: string, lang: Lang, context?: ExplainContext): Promise<Explanation> {
  const settings = await getSettings();
  const provider = settings.ai.provider;
  if (provider === 'none') throw new Error('No AI provider is set up. Add one in Settings.');
  const key = (await getApiKeys())[provider];
  if (!key) throw new Error('Add your API key in Settings to use explanations.');
  const model = modelFor(settings);

  const cacheKey = `${provider}|${model}|${lang}|${word}|${sentence}|${context?.title ?? ''}|${context?.snippets.join('|') ?? ''}`;
  const hit = explainCache.get(cacheKey);
  if (hit) return hit;

  const result = await explain(provider, key, model, word, sentence, lang, context);
  explainCache.set(cacheKey, result);
  if (explainCache.size > MAX_CACHE) explainCache.delete(explainCache.keys().next().value!);
  return result;
}

function updateBadge(settings: Settings) {
  void browser.action.setBadgeText({ text: settings.enabled ? '' : 'off' });
  void browser.action.setBadgeBackgroundColor({ color: '#6e6a78' });
}

/** Per-tab badge: "ES"/"PT" where it's translating, nothing where it's sleeping, "off" where it's switched off. */
async function updateTabBadge(tabId: number | undefined, status: PageStatus) {
  if (tabId === undefined) return;
  const settings = await getSettings();
  const text = status.state === 'active' ? LANGUAGES[status.lang].badge : status.state === 'off' ? 'off' : '';
  await browser.action.setBadgeText({ tabId, text });
  await browser.action.setBadgeBackgroundColor({ tabId, color: status.state === 'active' ? settings.accent : '#6e6a78' });
  await browser.action.setBadgeTextColor?.({ tabId, color: '#ffffff' });
  await browser.action.setTitle({
    tabId,
    title:
      status.state === 'active'
        ? `TurboTranslate — translating ${LANGUAGES[status.lang].name}`
        : status.state === 'off'
          ? 'TurboTranslate — off'
          : status.language
            ? `TurboTranslate — sleeping (this page is in ${languageName(status.language)})`
            : 'TurboTranslate — checking the page language',
  });
}

export default defineBackground(() => {
  handleMessages({
    lookup: ({ word, lang }) => lookup(word, lang),
    explain: ({ word, sentence, lang, context }) => runExplain(word, sentence, lang, context),
    testAi: () =>
      runExplain('Cuenta', 'Cuenta', 'es', {
        title: 'Cuenta Microsoft',
        site: 'account.microsoft.com',
        snippets: ['Haga mucho más en su cuenta de Microsoft.'],
      }),
    openOptions: () => browser.runtime.openOptionsPage(),
    pageStatus: (status, sender) => updateTabBadge(sender.tab?.id, status),
    recordLookup: (input) => recordLookup(input),
    getWord: ({ id }) => getWord(id),
    saveWord: (input) => saveWord(input),
    unsaveWord: ({ id }) => unsaveWords([id]),
    setWordStatus: ({ id, status }) => setStatus([id], status),
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-enabled') return;
    const settings = await getSettings();
    await updateSettings({ enabled: !settings.enabled });
  });

  void migrateLegacyDeck().catch((e) => console.error('TurboTranslate: could not move saved words', e));
  void getSettings().then(updateBadge);
  watchSettings(updateBadge);
});
