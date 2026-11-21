import { browser } from 'wxt/browser';
import { isLang, LANGS, type Lang } from './languages';
import type { AiProvider, ApiKeys, PageStatus, Settings } from './types';

export const DEFAULT_MODELS: Record<Exclude<AiProvider, 'none'>, string> = {
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-5-mini',
  gemini: 'gemini-2.5-flash',
};

export const ACCENTS = ['#ff5a4e', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'] as const;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  trigger: 'hover',
  selection: 'instant',
  hoverDelay: 320,
  theme: 'system',
  accent: ACCENTS[0],
  disabledSites: [],
  enabledSites: [],
  languages: ['es'],
  matchLanguage: true,
  speechRate: 0.9,
  ai: { provider: 'none', model: '', auto: false },
};

const SETTINGS_KEY = 'settings';
const KEYS_KEY = 'apiKeys';

// Settings sync across your Chrome profiles; API keys stay on this device only.
export async function getSettings(): Promise<Settings> {
  const stored = (await browser.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY] as
    | (Partial<Settings> & { spanishOnly?: boolean })
    | undefined;
  const { spanishOnly, ...rest } = stored ?? {};
  const languages = (rest.languages ?? []).filter(isLang);
  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    // Older versions were Spanish-only with a "spanishOnly" switch.
    matchLanguage: rest.matchLanguage ?? spanishOnly ?? DEFAULT_SETTINGS.matchLanguage,
    languages: languages.length ? [...new Set(languages)] : DEFAULT_SETTINGS.languages,
    ai: { ...DEFAULT_SETTINGS.ai, ...stored?.ai },
  };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

export function watchSettings(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'sync' && SETTINGS_KEY in changes) void getSettings().then(cb);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export async function getApiKeys(): Promise<ApiKeys> {
  return ((await browser.storage.local.get(KEYS_KEY))[KEYS_KEY] as ApiKeys | undefined) ?? {};
}

export async function setApiKey(provider: Exclude<AiProvider, 'none'>, key: string): Promise<void> {
  const keys = await getApiKeys();
  if (key) keys[provider] = key;
  else delete keys[provider];
  await browser.storage.local.set({ [KEYS_KEY]: keys });
}

export function modelFor(settings: Settings): string {
  const p = settings.ai.provider;
  if (p === 'none') return '';
  return settings.ai.model.trim() || DEFAULT_MODELS[p];
}

/** Is this (detected) language one you're learning? */
export function learns(settings: Settings, language: string | null): language is Lang {
  return isLang(language) && settings.languages.includes(language);
}

/** The single rule for whether a page is translated. `language` is the detected page language (null = unknown). */
export function pageStatus(settings: Settings, host: string, language: string | null): PageStatus {
  const lang: Lang = learns(settings, language) ? language : (settings.languages[0] ?? LANGS[0]);
  const base = { host, language, lang };
  if (!settings.enabled) return { ...base, state: 'off', reason: 'disabled' };
  if (settings.disabledSites.includes(host)) return { ...base, state: 'off', reason: 'site-off' };
  if (settings.enabledSites.includes(host)) return { ...base, state: 'active', reason: 'forced-on' };
  if (!settings.matchLanguage) return { ...base, state: 'active', reason: 'everywhere' };
  if (language === null) return { ...base, state: 'sleeping', reason: 'checking' };
  return learns(settings, language)
    ? { ...base, state: 'active', reason: 'match' }
    : { ...base, state: 'sleeping', reason: 'other-language' };
}

/** Site lists after the "On this site" switch is flipped, given what the page currently shows. */
export function toggleSite(settings: Settings, status: PageStatus): Pick<Settings, 'disabledSites' | 'enabledSites'> {
  const disabled = new Set(settings.disabledSites);
  const enabled = new Set(settings.enabledSites);
  const host = status.host;
  if (status.state === 'active') {
    // Turning off: drop a "force on" if that's what made it active, otherwise block the site.
    if (enabled.has(host)) enabled.delete(host);
    if (status.reason !== 'forced-on' || !settings.matchLanguage || learns(settings, status.language)) disabled.add(host);
  } else {
    // Turning on: lift a block, and force it on if the page wouldn't be active by itself.
    disabled.delete(host);
    const wouldBeActive = !settings.matchLanguage || learns(settings, status.language);
    if (!wouldBeActive) enabled.add(host);
  }
  return { disabledSites: [...disabled], enabledSites: [...enabled] };
}
