/**
 * Languages you can learn with TurboTranslate (always into English).
 * Adding one: an entry here and in scripts/build-dictionary.mjs, its dictionary (`pnpm build:dict <code>`),
 * and its pronoun rules in dictionary.ts.
 */
export const LANGS = ['es', 'pt'] as const;
export type Lang = (typeof LANGS)[number];

export interface LanguageInfo {
  code: Lang;
  name: string;
  /** Toolbar badge where it's translating. */
  badge: string;
  /** Letters (or marks) that practically only this language uses — a cheap "it's ours" hint. */
  telltale: RegExp;
  /** Preferred voice regions, best first. */
  voices: string[];
  /** For the "Listen" button in Settings. */
  sample: string;
}

export const LANGUAGES: Record<Lang, LanguageInfo> = {
  es: { code: 'es', name: 'Spanish', badge: 'ES', telltale: /[ñ¿¡]/i, voices: ['es-ES', 'es-MX', 'es-US'], sample: '¿Dónde está la biblioteca?' },
  pt: { code: 'pt', name: 'Portuguese', badge: 'PT', telltale: /[ãõ]/i, voices: ['pt-BR', 'pt-PT'], sample: 'Onde fica a biblioteca?' },
};

export const isLang = (code: string | null | undefined): code is Lang => !!code && (LANGS as readonly string[]).includes(code);

/** Names for languages a page might be in (not only the ones you learn). */
const OTHER_NAMES: Record<string, string> = {
  en: 'English', fr: 'French', de: 'German', it: 'Italian', pl: 'Polish', nl: 'Dutch', ca: 'Catalan', gl: 'Galician',
};

export function languageName(code: string | null): string {
  if (!code) return 'unknown';
  return isLang(code) ? LANGUAGES[code].name : (OTHER_NAMES[code] ?? code.toUpperCase());
}

/** Word ids carry the language, so Spanish "a" and Portuguese "a" are different words. */
export function wordId(lang: Lang, lemma: string): string {
  return `${lang}:${lemma.normalize('NFC').toLowerCase()}`;
}
