import { escapeRe } from './text';

/**
 * Picks the dictionary sense that fits the page, for free and offline:
 * translate the surrounding text on-device, then see which sense's English
 * wording actually shows up in that translation.
 *
 *   "Haga mucho más en su cuenta de Microsoft" → "Do much more in your Microsoft account"
 *   senses of "cuenta": count, tally · operation · bill · tab · account · …   → "account" ✓
 */

export interface SenseMatch {
  group: number;
  sense: number;
  /** The English term that matched, e.g. "account". */
  term: string;
}

const LEADING = /^(?:to|a|an|the|one's|oneself)\s+/;
const IGNORE = new Set([
  'be', 'do', 'go', 'get', 'have', 'make', 'take', 'put', 'give', 'say', 'one', 'thing', 'something', 'someone',
  'way', 'kind', 'type', 'person', 'used', 'use', 'very', 'more', 'most', 'also',
]);


/** "to tell (a story); narrate" → ["tell", "narrate"]; "tab (e.g. at a bar)" → ["tab"]. */
export function glossTerms(gloss: string): string[] {
  return gloss
    .replace(/^\(refl\.\)\s*/, '')
    .replace(/\([^)]*\)?/g, ' ')
    .replace(/…$/, '')
    .split(/[,;/:]|\bor\b/)
    .map((p) => p.trim().toLowerCase().replace(LEADING, '').replace(LEADING, '').trim())
    .filter((p) => p.length > 1 && p.split(' ').length <= 4 && !IGNORE.has(p));
}

/** Whole-word regex that tolerates simple English inflection (account → accounts, count → counted). */
export function termRegex(term: string, flags = 'iu'): RegExp {
  const words = term.split(/\s+/).map(escapeRe);
  const last = words.pop()!;
  const pattern = [...words, `${last.replace(/e$/, '')}(?:e|es|s|ed|d|ing)?`].join('\\s+');
  return new RegExp(`(?<![\\p{L}])(${pattern})(?![\\p{L}])`, flags);
}

export function containsTerm(text: string, term: string): boolean {
  return termRegex(term).test(text);
}

export function matchSense(groups: { senses: string[] }[], translations: (string | null | undefined)[]): SenseMatch | null {
  const text = translations.filter(Boolean).join('\n');
  if (!text) return null;

  let best: SenseMatch | null = null;
  let bestScore = 0;
  groups.forEach((g, gi) => {
    g.senses.forEach((sense, si) => {
      for (const term of glossTerms(sense)) {
        if (!containsTerm(text, term)) continue;
        // Multi-word terms are more specific; earlier senses and groups win ties.
        const score = 10 + term.split(' ').length * 3 - si * 0.1 - gi * 0.5;
        if (score > bestScore) {
          bestScore = score;
          best = { group: gi, sense: si, term };
        }
      }
    });
  });
  return best;
}
