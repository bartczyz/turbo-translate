import type { Lang } from '@/lib/languages';
import type { Presented } from '@/lib/present';
import type { TranslatorStatus } from '@/lib/translator';
import type { Explanation, Theme, WordStatus } from '@/lib/types';

/** Reactive popover state. The content script writes it; Popover.svelte renders it. */
export const ui = $state({
  open: false,
  pinned: false,
  theme: 'system' as Theme,
  accent: '#ff5a4e',

  /** Language of the open card's text. */
  lang: 'es' as Lang,
  word: '',
  sentence: '',
  isPhrase: false,
  phase: 'loading' as 'loading' | 'ready' | 'error',
  error: '',

  data: null as Presented | null,
  clitics: [] as string[],
  /** On-device translation of the word/phrase, used when the dictionary has nothing. */
  wordMT: null as string | null,
  sentenceMT: null as string | null,
  /** Another place on the page that uses the word, with its translation — shown for lone labels. */
  snippet: null as { text: string; en: string } | null,
  /** English term that matched the page context, highlighted in the translation. */
  contextTerm: null as string | null,
  mtStatus: 'unsupported' as TranslatorStatus,

  /** Word-by-word glosses for a selected phrase, each chosen to fit the phrase. */
  breakdown: null as { word: string; gloss: string }[] | null,
  /** Set when viewing one word of a selected phrase; the header shows a way back. */
  backTo: null as string | null,
  /** Floating "Translate" button for a selection (selection mode "button"). */
  pill: null as { x: number; y: number } | null,

  saved: false,
  status: 'new' as WordStatus,
  /** How many times you've looked this word up (across pages). */
  lookups: 0,
  aiEnabled: false,
  ai: { status: 'idle' as 'idle' | 'loading' | 'ready' | 'error', data: null as Explanation | null, error: '' },
});

/** Filled in by the content script. */
export const actions = {
  speak: () => {},
  toggleSave: () => {},
  cycleStatus: () => {},
  explain: (_pin?: boolean) => {},
  close: () => {},
  openSettings: () => {},
  /** Open one word from a phrase's breakdown, or go back to the phrase. */
  openWord: (_word: string) => {},
  back: () => {},
  translateSelection: () => {},
};
