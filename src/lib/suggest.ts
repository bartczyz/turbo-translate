import type { WordRecord } from './types';

/** After this many lookups, an unsaved word is suggested for saving. */
export const SUGGEST_AFTER = 3;

/** Words you keep looking up but haven't saved. */
export const isSuggested = (w: WordRecord) => !w.saved && w.lookups >= SUGGEST_AFTER && w.kind === 'word';

/** Longer selections are sentences, not vocabulary, so they can't be saved. */
export const SAVE_MAX_CHARS = 80;
