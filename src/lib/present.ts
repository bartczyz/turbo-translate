import type { SenseMatch } from './disambiguate';
import type { DictEntry, Gender, LookupResult } from './types';

export interface SenseGroup {
  pos: string;
  gender?: Gender;
  senses: string[];
  example?: [string, string];
  /** Set when this group describes an inflected form, e.g. lemma "hablar". */
  lemma?: string;
  inflections: string[];
  /** True when the first sense was chosen from the page context. */
  contextual?: boolean;
}

export interface Presented {
  headword: string;
  ipa?: string;
  groups: SenseGroup[];
  /** Short translation used for saved cards, e.g. "bank". */
  primary: string;
  /** Dictionary form used as the card id, e.g. "hablar". */
  lemma: string;
  /** The dictionary key that matched the hovered word. */
  matched: string;
  pos?: string;
  gender?: Gender;
}

const POS_LABELS: Record<string, string> = {
  adj: 'adjective',
  adv: 'adverb',
  conj: 'conjunction',
  det: 'determiner',
  intj: 'interjection',
  num: 'number',
  prep: 'preposition',
  pron: 'pronoun',
  name: 'proper noun',
  prep_phrase: 'phrase',
};

export const REFL_PREFIX = '(refl.) ';
export const isReflexive = (sense: string) => sense.startsWith(REFL_PREFIX);

export const posLabel = (pos: string) => POS_LABELS[pos] ?? pos;

/** "bank (financial institution)" → "bank"; "to lift; to raise" → "to lift". */
export function shortGloss(gloss: string): string {
  return gloss
    .replace(REFL_PREFIX, '')
    .replace(/\s*\([^)]*\)?/g, '')
    .split(/[;,]/)[0]!
    .replace(/…$/, '')
    .trim();
}

function bestLemmaEntry(entries: DictEntry[] | undefined, pos: string): DictEntry | undefined {
  if (!entries) return undefined;
  return entries.find((e) => e.pos === pos && e.senses.length) ?? entries.find((e) => e.senses.length);
}

export function present(word: string, r: LookupResult): Presented | null {
  const groups: SenseGroup[] = [];

  for (const e of r.entries) {
    if (e.senses.length) {
      groups.push({ pos: e.pos, gender: e.gender, senses: e.senses, example: e.example, inflections: [] });
    }
    for (const f of e.forms) {
      const existing = groups.find((g) => g.lemma === f.lemma && g.pos === e.pos);
      if (existing) {
        if (!existing.inflections.includes(f.description)) existing.inflections.push(f.description);
        continue;
      }
      const base = bestLemmaEntry(r.lemmas.find((l) => l.word === f.lemma)?.entries, e.pos);
      groups.push({
        pos: e.pos,
        gender: base?.gender,
        senses: base?.senses ?? [],
        example: base?.example,
        lemma: f.lemma,
        inflections: [f.description],
      });
    }
  }

  // "levantándose", "sentarse": a lone attached "se" signals the reflexive verb, so put those meanings first.
  // ("dime", "dámelo" use me as "to me", so other pronouns don't count.)
  const reflexive = r.clitics.length === 1 && r.clitics[0] === 'se';
  for (const g of groups) {
    if (g.pos !== 'verb') continue;
    const refl = g.senses.filter(isReflexive);
    const plain = g.senses.filter((s) => !isReflexive(s));
    g.senses = reflexive && refl.length ? [...refl, ...plain] : [...plain, ...refl];
  }

  // Groups with real meanings first (and verbs, when a pronoun was attached: "chama-se" isn't "flame"); keep it compact.
  const rank = (g: SenseGroup) => (g.senses.length > 0 ? 2 : 0) + (r.clitics.length && g.pos === 'verb' ? 1 : 0);
  groups.sort((a, b) => rank(b) - rank(a));
  const shown = groups.slice(0, 3);
  const first = shown[0];
  if (!first) return null;

  return {
    headword: word,
    ipa: (r.clitics.length ? r.entries.find((e) => e.ipa && e.pos === 'verb') : undefined)?.ipa ?? r.entries.find((e) => e.ipa)?.ipa,
    groups: shown,
    primary: first.senses[0] ? shortGloss(first.senses[0]) : '',
    lemma: first.lemma ?? r.matched ?? word.toLowerCase(),
    matched: r.matched ?? word.toLowerCase(),
    pos: first.pos,
    gender: first.gender,
  };
}

/**
 * Moves the sense that fits the page to the top (and its group first),
 * so "cuenta" on a Microsoft account page reads "account", not "count, tally".
 */
export function applyContext(p: Presented, m: SenseMatch): Presented {
  const groups = p.groups.map((g) => ({ ...g, senses: [...g.senses], contextual: false }));
  const [group] = groups.splice(m.group, 1);
  if (!group) return p;
  const [sense] = group.senses.splice(m.sense, 1);
  if (sense === undefined) return p;
  group.senses.unshift(sense);
  group.contextual = true;
  groups.unshift(group);
  return {
    ...p,
    groups,
    // The term the page actually used reads best: "the", not "feminine singular definite article; the".
    primary: m.term || shortGloss(sense),
    lemma: group.lemma ?? p.matched,
    pos: group.pos,
    gender: group.gender,
  };
}
