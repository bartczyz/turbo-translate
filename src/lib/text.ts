/** Small text helpers shared by the popover, the My words page and the lookups. */

/** Escapes a string for use inside a RegExp. */
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Splits text so occurrences of `word` can be emphasised. */
export function markWord(text: string, word: string): { t: string; hit: boolean }[] {
  if (!word) return [{ t: text, hit: false }];
  const lower = word.toLowerCase();
  return text
    .split(new RegExp(`(${escapeRe(word)})`, 'giu'))
    .filter(Boolean)
    .map((t) => ({ t, hit: t.toLowerCase() === lower }));
}
