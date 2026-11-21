/**
 * Chrome's built-in, on-device Translator API (Chrome 138+). Free, private, offline.
 * https://developer.chrome.com/docs/ai/translator-api
 */

import type { Lang } from './languages';

export type TranslatorStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

interface TranslatorInstance {
  translate(text: string): Promise<string>;
  destroy?(): void;
}

interface CreateMonitor {
  addEventListener(type: 'downloadprogress', cb: (e: { loaded: number }) => void): void;
}

interface TranslatorStatic {
  availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<Exclude<TranslatorStatus, 'unsupported'>>;
  create(opts: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: CreateMonitor) => void;
  }): Promise<TranslatorInstance>;
}

const pair = (lang: Lang) => ({ sourceLanguage: lang, targetLanguage: 'en' });

function api(): TranslatorStatic | null {
  return (globalThis as { Translator?: TranslatorStatic }).Translator ?? null;
}

const instances = new Map<Lang, Promise<TranslatorInstance>>();
/** Keyed "lang|text". */
const cache = new Map<string, string>();

export async function translatorStatus(lang: Lang): Promise<TranslatorStatus> {
  const t = api();
  if (!t) return 'unsupported';
  try {
    return await t.availability(pair(lang));
  } catch {
    return 'unsupported';
  }
}

/** Downloads the <lang>→English model. Must be called from a click (user activation). */
export async function downloadTranslator(lang: Lang, onProgress?: (fraction: number) => void): Promise<void> {
  const t = api();
  if (!t) throw new Error('This browser has no built-in translator.');
  const instance = t.create({
    ...pair(lang),
    monitor: (m) => m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded)),
  });
  instances.set(lang, instance);
  await instance;
}

/** Translate text on-device. Returns null if the model isn't installed yet. */
export async function translate(text: string, lang: Lang): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const key = `${lang}|${trimmed}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const t = api();
  if (!t) return null;
  let instance = instances.get(lang);
  if (!instance) {
    if ((await translatorStatus(lang)) !== 'available') return null;
    instance = t.create(pair(lang));
    instances.set(lang, instance);
  }
  try {
    const out = await (await instance).translate(trimmed);
    cache.set(key, out);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return out;
  } catch {
    instances.delete(lang);
    return null;
  }
}
