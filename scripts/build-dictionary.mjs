#!/usr/bin/env node
/**
 * Builds the compact offline <language>→English dictionaries used by the extension.
 *
 * Input:  Wiktextract JSONL for the language (kaikki.org), downloaded and streamed (nothing stored),
 *         or read from a local file.
 * Output: public/dict/<lang>-en/<shard>.json — one small file per 3-letter prefix,
 *         so the extension only loads the shard it needs for a lookup, plus
 *         meta.json holding the shared table of inflection descriptions.
 *
 * Usage:
 *   pnpm build:dict                               (every language; Spanish is ~1 GB to stream, Portuguese ~600 MB)
 *   node scripts/build-dictionary.mjs pt          (one language)
 *   node scripts/build-dictionary.mjs pt --file local-file.jsonl
 *
 * Entry format (per lowercase word key → array of entries):
 *   { p: pos, g?: "m"|"f"|"mf", i?: ipa, s?: string[] senses,
 *     f?: [lemma, descriptionIndex][] form-of links, x?: [spanish, english] example }
 *   Reflexive verb senses are prefixed with "(refl.) ".
 *
 * Clitic combinations ("dámelo" = dame + lo) are dropped: the extension strips
 * clitic pronouns at lookup time instead, which saves ~130k entries.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

/** Keep in sync with src/lib/languages.ts. */
const LANGUAGES = {
  es: { kaikki: 'Spanish', reflexiveTags: ['reflexive'] },
  // Portuguese Wiktionary marks "levantar-se" senses as pronominal rather than reflexive, and spells the
  // verb before -lo/-la as its own word ("fazê" = apocopic form of fazer): link those to the real verb.
  pt: { kaikki: 'Portuguese', reflexiveTags: ['reflexive', 'pronominal'], altOfAsForm: true },
};
const DICT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'dict');
const MAX_SENSES = 10;
const MAX_GLOSS_LEN = 80;
const MAX_EXAMPLE_LEN = 140;

const SKIP_POS = new Set(['character', 'symbol', 'prefix', 'suffix', 'infix', 'interfix']);
const LOW_PRIORITY_TAGS = new Set(['obsolete', 'archaic', 'rare', 'dated', 'historical']);

/** Shard key: first three letters, diacritics stripped, non a–z → "_". Keep in sync with src/lib/dictionary.ts. */
export function shardOf(word) {
  const base = word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  let key = '';
  for (let i = 0; i < 3; i++) key += /[a-z]/.test(base[i] ?? '') ? base[i] : '_';
  return key;
}

/** Shared table of inflection descriptions ("plural", "first-person singular preterite indicative", …). */
let descTable = [];
let descIndex = new Map();
function descId(desc) {
  let id = descIndex.get(desc);
  if (id === undefined) {
    id = descTable.length;
    descTable.push(desc);
    descIndex.set(desc, id);
  }
  return id;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function genderOf(entry) {
  const head = entry.head_templates?.[0]?.args ?? {};
  const g = head['1'];
  if (g === 'm' || g === 'f') return g;
  if (g === 'mf' || g === 'm-f' || g === 'mfbysense') return 'mf';
  const tags = new Set(entry.senses?.flatMap((s) => s.tags ?? []) ?? []);
  if (tags.has('masculine') && tags.has('feminine')) return 'mf';
  if (tags.has('masculine')) return 'm';
  if (tags.has('feminine')) return 'f';
  return undefined;
}

function ipaOf(entry) {
  const s = entry.sounds?.find((x) => x.ipa && x.ipa.startsWith('/'));
  return s?.ipa;
}

function convert(entry, lang) {
  if (entry.lang_code !== lang || SKIP_POS.has(entry.pos)) return null;
  const { reflexiveTags, altOfAsForm } = LANGUAGES[lang];
  const senses = [];
  const lowSenses = [];
  const reflexiveSenses = [];
  const formOf = [];
  let example;

  for (const s of entry.senses ?? []) {
    const tags = s.tags ?? [];
    const glosses = s.glosses ?? [];
    if (!glosses.length) continue;

    if (s.form_of?.length && tags.includes('form-of')) {
      const lemma = s.form_of[0].word;
      const desc = glosses[glosses.length - 1].replace(/:$/, '').replace(` of ${lemma}`, '').trim();
      if (!lemma || /combined with/.test(desc)) continue;
      const id = descId(desc);
      if (!formOf.some(([l, d]) => l === lemma && d === id)) formOf.push([lemma, id]);
      continue;
    }

    // "apocopic form of fazer", "eye dialect spelling of estar" → a link to the lemma, which has the meanings.
    const alt = s.alt_of?.[0]?.word;
    const altDesc = alt && glosses[glosses.length - 1].match(new RegExp(`^(.+?) of ${alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'u'))?.[1];
    if (altOfAsForm && altDesc && tags.includes('alt-of') && !tags.includes('contraction')) {
      const id = descId(altDesc);
      if (!formOf.some(([l, d]) => l === alt && d === id)) formOf.push([alt, id]);
      continue;
    }

    const reflexive = entry.pos === 'verb' && tags.some((t) => reflexiveTags.includes(t));
    const gloss = (reflexive ? '(refl.) ' : '') + clip(glosses[glosses.length - 1], MAX_GLOSS_LEN);
    const bucket = reflexive ? reflexiveSenses : tags.some((t) => LOW_PRIORITY_TAGS.has(t)) ? lowSenses : senses;
    if (!bucket.includes(gloss)) bucket.push(gloss);

    if (!example) {
      const ex = s.examples?.find((e) => e.text && (e.english || e.translation));
      if (ex && ex.text.length <= MAX_EXAMPLE_LEN) {
        example = [ex.text, clip(ex.english || ex.translation, MAX_EXAMPLE_LEN)];
      }
    }
  }

  // Up to two reflexive senses ("(refl.) to get up") ride along so "levantándose" can show them.
  const s = [...[...senses, ...lowSenses].slice(0, MAX_SENSES), ...reflexiveSenses.slice(0, 2)];
  if (!s.length && !formOf.length) return null;

  const out = { p: entry.pos };
  const g = genderOf(entry);
  if (g && entry.pos === 'noun') out.g = g;
  const i = ipaOf(entry);
  if (i && s.length) out.i = i;
  if (s.length) out.s = s;
  if (formOf.length) out.f = formOf.slice(0, 3);
  if (example) out.x = example;
  return out;
}

async function input(lang, file) {
  if (file) return createReadStream(file);
  const url = `https://kaikki.org/dictionary/${LANGUAGES[lang].kaikki}/kaikki.org-dictionary-${LANGUAGES[lang].kaikki}.jsonl`;
  console.error(`${lang}: streaming ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return Readable.fromWeb(res.body);
}

async function build(lang, file) {
  /** @type {Map<string, Record<string, object[]>>} */
  const shards = new Map();
  let lines = 0;
  let kept = 0;
  descTable = [];
  descIndex = new Map();
  const outDir = join(DICT_DIR, `${lang}-en`);

  const rl = createInterface({ input: await input(lang, file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const word = entry.word?.trim();
    if (!word || word.includes(' ') || word.length > 40) continue;
    const converted = convert(entry, lang);
    if (!converted) continue;

    const key = word.toLowerCase();
    const shard = shardOf(key);
    let bucket = shards.get(shard);
    if (!bucket) shards.set(shard, (bucket = Object.create(null)));
    (bucket[key] ??= []).push(converted);
    kept++;
    if (lines % 100000 === 0) process.stderr.write(`  …${lines.toLocaleString()} lines, ${kept.toLocaleString()} kept\n`);
  }

  if (kept === 0) throw new Error(`${lang}: no entries found in the input.`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  let bytes = 0;
  await writeFile(join(outDir, 'meta.json'), JSON.stringify({ version: 1, entries: kept, forms: descTable }));
  for (const [shard, data] of shards) {
    const json = JSON.stringify(data);
    bytes += json.length;
    await writeFile(join(outDir, `${shard}.json`), json);
  }
  console.error(
    `${lang}: ${lines.toLocaleString()} lines → ${kept.toLocaleString()} entries in ${shards.size} shards (${(bytes / 1e6).toFixed(1)} MB).`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const fileAt = args.indexOf('--file');
  const file = fileAt >= 0 ? args.splice(fileAt, 2)[1] : undefined;
  const langs = args.length ? args : Object.keys(LANGUAGES);
  const unknown = langs.filter((l) => !(l in LANGUAGES));
  if (unknown.length) throw new Error(`Unknown language: ${unknown.join(', ')}. Known: ${Object.keys(LANGUAGES).join(', ')}.`);
  if (file && langs.length !== 1) throw new Error('--file needs exactly one language.');
  for (const lang of langs) await build(lang, file);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
