import type { Lang } from './languages';

/** How a lookup is triggered on the page. */
export type TriggerMode = 'hover' | 'hover-alt' | 'click';
/** What happens when you select text: translate it right away, offer a small button, or nothing. */
export type SelectionMode = 'instant' | 'button' | 'off';
export type Theme = 'system' | 'light' | 'dark';
export type AiProvider = 'none' | 'anthropic' | 'openai' | 'gemini';

export interface Settings {
  enabled: boolean;
  trigger: TriggerMode;
  selection: SelectionMode;
  /** Milliseconds the pointer must rest on a word before the popover opens. */
  hoverDelay: number;
  theme: Theme;
  accent: string;
  /** Hostnames where the extension is always off. */
  disabledSites: string[];
  /** Hostnames where the extension is always on, even if the page isn't in one of your languages. */
  enabledSites: string[];
  /** The languages you're learning; the first is used where a page's language can't tell. */
  languages: Lang[];
  /** Only wake up on pages written in one of your languages (and skip other text on them). */
  matchLanguage: boolean;
  speechRate: number;
  /** `auto`: fetch the AI explanation for every lookup instead of waiting for a click. */
  ai: { provider: AiProvider; model: string; auto: boolean };
}

export type ApiKeys = Partial<Record<Exclude<AiProvider, 'none'>, string>>;

export type Gender = 'm' | 'f' | 'mf';

export interface InflectionLink {
  lemma: string;
  description: string;
}

export interface DictEntry {
  pos: string;
  gender?: Gender;
  ipa?: string;
  senses: string[];
  example?: [original: string, english: string];
  forms: InflectionLink[];
}

export interface LookupResult {
  query: string;
  /** Dictionary key that matched; differs from `query` when clitics were stripped. */
  matched: string | null;
  /** Clitic pronouns removed to find the match, e.g. ["me", "lo"] for "dámelo". */
  clitics: string[];
  entries: DictEntry[];
  lemmas: { word: string; entries: DictEntry[] }[];
}

export interface Explanation {
  meaning: string;
  lemma: string;
  partOfSpeech: string;
  explanation: string;
  sentenceTranslation: string;
}

/** What the page says around the word, sent to the AI so it can tell "account" from "count". */
export interface ExplainContext {
  title: string;
  site: string;
  snippets: string[];
}

export type WordStatus = 'new' | 'learning' | 'known';

/** One place you met a word. */
export interface WordContext {
  sentence: string;
  /** The form on the page, e.g. "hablaba" for the word "hablar". */
  form: string;
  url: string;
  title: string;
  at: number;
}

/**
 * Everything known about one word (or saved phrase). Created on first lookup;
 * `saved` marks the ones in "My words". Unsaved records power "you keep looking this up".
 */
export interface WordRecord {
  /** "es:hablar" — language + lowercase lemma or phrase (see wordId()). */
  id: string;
  lang: Lang;
  lemma: string;
  translation: string;
  kind: 'word' | 'phrase';
  pos?: string;
  gender?: Gender;
  saved: boolean;
  status: WordStatus;
  lookups: number;
  /** Newest first, capped. */
  contexts: WordContext[];
  firstSeen: number;
  lastSeen: number;
  savedAt?: number;
}

/** What the content script reports when a word is looked up or saved. */
export interface WordInput {
  id: string;
  lang: Lang;
  lemma: string;
  translation: string;
  kind: 'word' | 'phrase';
  pos?: string;
  gender?: Gender;
  context: WordContext;
}

/**
 * Whether TurboTranslate is working on a page, and why.
 * active: translating · sleeping: page isn't in one of your languages · off: switched off (everywhere or for this site)
 */
export type PageState = 'active' | 'sleeping' | 'off';
export type PageReason = 'match' | 'other-language' | 'checking' | 'forced-on' | 'everywhere' | 'site-off' | 'disabled';
export interface PageStatus {
  state: PageState;
  reason: PageReason;
  host: string;
  /** Detected page language, e.g. "es", "en"; null while unknown. */
  language: string | null;
  /** The dictionary to use here: the page's language if you learn it, otherwise your first language. */
  lang: Lang;
}

/** Request/response pairs handled by the background service worker. */
export interface MessageMap {
  lookup: { req: { word: string; lang: Lang }; res: LookupResult };
  explain: { req: { word: string; sentence: string; lang: Lang; context?: ExplainContext }; res: Explanation };
  testAi: { req: Record<string, never>; res: Explanation };
  openOptions: { req: Record<string, never>; res: void };
  /** Content script → background: update the toolbar badge for this tab. */
  pageStatus: { req: PageStatus; res: void };
  /** Words live in the extension's own database, which content scripts reach through the background. */
  recordLookup: { req: WordInput; res: WordRecord };
  getWord: { req: { id: string }; res: WordRecord | null };
  saveWord: { req: WordInput; res: WordRecord };
  unsaveWord: { req: { id: string }; res: void };
  setWordStatus: { req: { id: string; status: WordStatus }; res: void };
}

export type MessageType = keyof MessageMap;

export type Envelope<T extends MessageType = MessageType> = { type: T; payload: MessageMap[T]['req'] };

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
