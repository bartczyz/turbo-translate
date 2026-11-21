import { browser } from 'wxt/browser';
import type { Lang } from './languages';
import type { DictEntry, Gender, LookupResult } from './types';

/** Raw entry as written by scripts/build-dictionary.mjs. */
interface RawEntry {
  p: string;
  g?: Gender;
  i?: string;
  s?: string[];
  f?: [lemma: string, descIndex: number][];
  x?: [string, string];
}
type Shard = Record<string, RawEntry[]>;

const dictPath = (lang: Lang) => `/dict/${lang}-en`;
const MAX_CACHED_SHARDS = 60;

/** Keyed "es/abc". */
const shardCache = new Map<string, Promise<Shard>>();
const formsTables = new Map<Lang, Promise<string[]>>();

const stripMarks = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
/** Removes only acute accents (á→a) — keeps ñ and ü, which change the word. */
const stripAcute = (s: string) => s.normalize('NFD').replace(/\u0301/g, '').normalize('NFC');
/** Removes acute and circumflex accents (fazê→faze) — Portuguese "fazê-lo" → "fazer". */
const stripStress = (s: string) => s.normalize('NFD').replace(/[\u0301\u0302]/g, '').normalize('NFC');

/** Keep in sync with shardOf() in scripts/build-dictionary.mjs. */
export function shardOf(word: string): string {
  const base = stripMarks(word.toLowerCase());
  let key = '';
  for (let i = 0; i < 3; i++) key += /[a-z]/.test(base[i] ?? '') ? base[i] : '_';
  return key;
}

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(browser.runtime.getURL(path as '/'));
    return res.ok ? ((await res.json()) as T) : fallback;
  } catch {
    return fallback;
  }
}

function loadShard(lang: Lang, shard: string): Promise<Shard> {
  const key = `${lang}/${shard}`;
  let p = shardCache.get(key);
  if (p) {
    // Refresh LRU position.
    shardCache.delete(key);
    shardCache.set(key, p);
    return p;
  }
  p = fetchJson<Shard>(`${dictPath(lang)}/${shard}.json`, {});
  shardCache.set(key, p);
  if (shardCache.size > MAX_CACHED_SHARDS) shardCache.delete(shardCache.keys().next().value!);
  return p;
}

function loadForms(lang: Lang): Promise<string[]> {
  let p = formsTables.get(lang);
  if (!p) {
    p = fetchJson<{ forms: string[] }>(`${dictPath(lang)}/meta.json`, { forms: [] }).then((m) => m.forms);
    formsTables.set(lang, p);
  }
  return p;
}

async function rawLookup(lang: Lang, word: string): Promise<RawEntry[] | undefined> {
  const shard = await loadShard(lang, shardOf(word));
  return Object.hasOwn(shard, word) ? shard[word] : undefined;
}

function decode(raw: RawEntry, forms: string[]): DictEntry {
  return {
    pos: raw.p,
    gender: raw.g,
    ipa: raw.i,
    senses: raw.s ?? [],
    example: raw.x,
    forms: (raw.f ?? []).map(([lemma, i]) => ({ lemma, description: forms[i] ?? '' })),
  };
}

type Candidate = { key: string; clitics: string[] };

const clean = (word: string) => word.normalize('NFC').toLowerCase().replace(/^[¡¿"'«(]+|[!?"'»).,;:]+$/g, '');

const CLITIC = /(nos|los|las|les|me|te|se|lo|la|le|os)$/;

/**
 * Spanish: candidate dictionary keys for a word as it appears on the page, most specific first.
 * Handles attached clitic pronouns: "dámelo" → "dáme"/"dame" → "dá"/"da".
 */
function spanishCandidates(word: string): Candidate[] {
  const lower = clean(word);
  const out: Candidate[] = [{ key: lower, clitics: [] }];
  let stem = lower;
  const clitics: string[] = [];
  for (let i = 0; i < 2; i++) {
    const m = stem.match(CLITIC);
    if (!m || stem.length - m[0].length < 2) break;
    stem = stem.slice(0, -m[0].length);
    clitics.unshift(m[0]);
    out.push({ key: stem, clitics: [...clitics] });
    const plain = stripAcute(stem);
    if (plain !== stem) out.push({ key: plain, clitics: [...clitics] });
  }
  if (lower.includes('-')) out.push({ key: lower.split('-')[0]!, clitics: [] });
  return out;
}

const PT_CLITICS = new Set(
  'me te se lhe lhes nos vos o a os as lo la los las no na nas mo ma mos mas to ta tos tas lho lha lhos lhas'.split(' '),
);

/**
 * Portuguese: pronouns are joined with hyphens.
 * - enclisis:   "dá-me" → dá + me, "levantar-se" → levantar + se, "deu-lhe" → deu + lhe
 * - -lo/-la:    the verb loses its last letter: "fazê-lo" → fazer, "pô-lo" → pôr, "amamo-lo" → amamos, "fá-lo" → faz
 * - mesoclisis: "dar-te-ei" → darei + te, "far-se-á" → fará + se
 * A hyphenated word that isn't a pronoun form ("guarda-chuva") is looked up whole, then by its first part.
 */
function portugueseCandidates(word: string): Candidate[] {
  const lower = clean(word);
  const out: Candidate[] = [{ key: lower, clitics: [] }];
  const parts = lower.split('-').filter(Boolean);
  if (parts.length < 2) return out;

  if (parts.length === 3 && PT_CLITICS.has(parts[1]!) && /^(ei|ás|á|emos|eis|ão|ia|ias|íamos|íeis|iam)$/.test(parts[2]!)) {
    out.push({ key: parts[0]! + parts[2]!, clitics: [parts[1]!] });
  }

  const clitics: string[] = [];
  let rest = [...parts];
  while (rest.length > 1 && clitics.length < 2 && PT_CLITICS.has(rest[rest.length - 1]!)) {
    const clitic = rest.pop()!;
    clitics.unshift(clitic);
    const stem = rest.join('-');
    // Before -lo/-la the verb dropped its r/s/z; try the full forms first so "fazê" isn't preferred to "fazer".
    const base = stripStress(stem);
    const found = /^l(o|a|os|as)$/.test(clitic) ? [stem + 'r', base + 'r', stem, stem + 's', base + 'z'] : [stem];
    for (const key of new Set(found)) out.push({ key, clitics: [...clitics] });
  }
  out.push({ key: parts[0]!, clitics: [] });
  return out;
}

const CANDIDATES: Record<Lang, (word: string) => Candidate[]> = {
  es: spanishCandidates,
  pt: portugueseCandidates,
};

export async function lookup(word: string, lang: Lang = 'es'): Promise<LookupResult> {
  const forms = await loadForms(lang);
  const result: LookupResult = { query: word, matched: null, clitics: [], entries: [], lemmas: [] };

  for (const c of CANDIDATES[lang](word)) {
    const raw = await rawLookup(lang, c.key);
    if (!raw?.length) continue;
    result.matched = c.key;
    result.clitics = c.clitics;
    result.entries = raw.map((r) => decode(r, forms));
    if (c.clitics.length && lang === 'es') {
      // Clitic pronouns only attach to imperatives, infinitives and gerunds ("dámelo", "levantándose").
      const fits = (d: string) => /imperative|gerund|infinitive/.test(d);
      for (const e of result.entries) {
        if (e.forms.some((f) => fits(f.description))) e.forms = e.forms.filter((f) => fits(f.description));
      }
    }
    break;
  }

  // Pull in the base words ("hablar" for "hablaba") so the popover can show real meanings.
  const lemmaWords = [...new Set(result.entries.flatMap((e) => e.forms.map((f) => f.lemma)))]
    .filter((l) => l !== result.matched)
    .slice(0, 3);
  for (const lemma of lemmaWords) {
    const raw = await rawLookup(lang, lemma.toLowerCase());
    if (raw?.length) result.lemmas.push({ word: lemma, entries: raw.map((r) => decode(r, forms)) });
  }
  return result;
}
