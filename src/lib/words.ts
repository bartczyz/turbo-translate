/**
 * Your words, in the extension's own IndexedDB.
 * Only extension pages and the background can open it (content scripts live in the page's origin),
 * so content scripts go through background messages; the words page and popup use this module directly.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { browser } from 'wxt/browser';
import { wordId } from './languages';
import type { WordContext, WordInput, WordRecord, WordStatus } from './types';

interface WordsDB extends DBSchema {
  words: {
    key: string;
    value: WordRecord;
    indexes: { lastSeen: number };
  };
}

const MAX_CONTEXTS = 12;
/** Bumped after every write so open pages can refresh (storage.onChanged reaches every extension context). */
const VERSION_KEY = 'wordsVersion';
const LEGACY_DECK_KEY = 'deck';

let dbPromise: Promise<IDBPDatabase<WordsDB>> | null = null;

function db(): Promise<IDBPDatabase<WordsDB>> {
  dbPromise ??= openDB<WordsDB>('turbotranslate', 2, {
    async upgrade(database, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const store = database.createObjectStore('words', { keyPath: 'id' });
        store.createIndex('lastSeen', 'lastSeen');
        return;
      }
      if (oldVersion < 2) {
        // v1 was Spanish-only with bare ids ("hablar"); ids now carry the language ("es:hablar").
        const store = tx.objectStore('words');
        for (let cursor = await store.openCursor(); cursor; cursor = await cursor.continue()) {
          const old = cursor.value as Omit<WordRecord, 'lang'> & { lang?: WordRecord['lang'] };
          if (old.lang) continue;
          await cursor.delete();
          await store.put({ ...old, lang: 'es', id: wordId('es', old.id) });
        }
      }
    },
    // A newer version of the extension wants to upgrade the database: step aside and reconnect next time.
    blocking() {
      void dbPromise?.then((d) => d.close());
      dbPromise = null;
    },
  });
  return dbPromise;
}

async function changed(): Promise<void> {
  await browser.storage.local.set({ [VERSION_KEY]: Date.now() });
}

function addContext(contexts: WordContext[], ctx: WordContext): WordContext[] {
  const sentence = ctx.sentence.trim();
  // Same sentence on the same page: just refresh it.
  const rest = contexts.filter((c) => !(c.sentence === sentence && c.url === ctx.url));
  return [{ ...ctx, sentence }, ...rest].slice(0, MAX_CONTEXTS);
}

function fresh(input: WordInput, now: number): WordRecord {
  return {
    id: input.id,
    lang: input.lang,
    lemma: input.lemma,
    translation: input.translation,
    kind: input.kind,
    pos: input.pos,
    gender: input.gender,
    saved: false,
    status: 'new',
    lookups: 0,
    contexts: [],
    firstSeen: now,
    lastSeen: now,
  };
}

async function upsert(input: WordInput, change: (w: WordRecord) => void): Promise<WordRecord> {
  const database = await db();
  const tx = database.transaction('words', 'readwrite');
  const now = Date.now();
  const word = (await tx.store.get(input.id)) ?? fresh(input, now);
  change(word);
  word.lastSeen = now;
  word.contexts = addContext(word.contexts, input.context);
  // Fill gaps from the latest lookup without overwriting what you saved.
  word.translation ||= input.translation;
  word.pos ??= input.pos;
  word.gender ??= input.gender;
  await tx.store.put(word);
  await tx.done;
  await changed();
  return word;
}

/** Called when you actually read a translation (not for every word the pointer brushes past). */
export function recordLookup(input: WordInput): Promise<WordRecord> {
  return upsert(input, (w) => {
    w.lookups += 1;
  });
}

export function saveWord(input: WordInput): Promise<WordRecord> {
  return upsert(input, (w) => {
    if (!w.saved) {
      w.saved = true;
      w.savedAt = Date.now();
    }
    // Saving from a specific context means this meaning is the one you want to learn.
    if (input.translation) w.translation = input.translation;
  });
}

export async function getWord(id: string): Promise<WordRecord | null> {
  return (await (await db()).get('words', id)) ?? null;
}

/** Removes from "My words" but keeps the lookup history. */
export async function unsaveWords(ids: string[]): Promise<void> {
  await updateWords(ids, (w) => {
    w.saved = false;
    w.status = 'new';
    delete w.savedAt;
  });
}

export async function setStatus(ids: string[], status: WordStatus): Promise<void> {
  await updateWords(ids, (w) => {
    w.status = status;
    if (!w.saved) {
      w.saved = true;
      w.savedAt = Date.now();
    }
  });
}

export async function deleteWords(ids: string[]): Promise<void> {
  const tx = (await db()).transaction('words', 'readwrite');
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
  await changed();
}

async function updateWords(ids: string[], change: (w: WordRecord) => void): Promise<void> {
  const tx = (await db()).transaction('words', 'readwrite');
  for (const id of ids) {
    const w = await tx.store.get(id);
    if (!w) continue;
    change(w);
    await tx.store.put(w);
  }
  await tx.done;
  await changed();
}

export async function allWords(): Promise<WordRecord[]> {
  return (await db()).getAll('words');
}

export function watchWords(cb: () => void): () => void {
  const listener = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && VERSION_KEY in changes) cb();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export { isSuggested, SUGGEST_AFTER } from './suggest';

/** One-time move of the old chrome.storage "deck" into the database. Safe to call on every start. */
export async function migrateLegacyDeck(): Promise<number> {
  const stored = (await browser.storage.local.get(LEGACY_DECK_KEY))[LEGACY_DECK_KEY] as
    | Record<string, { id: string; word: string; lemma: string; translation: string; pos?: string; gender?: WordRecord['gender']; sentence?: string; url?: string; title?: string; createdAt: number }>
    | undefined;
  if (!stored) return 0;
  const cards = Object.values(stored);
  const tx = (await db()).transaction('words', 'readwrite');
  for (const c of cards) {
    const id = wordId('es', c.id);
    if (await tx.store.get(id)) continue;
    await tx.store.put({
      id,
      lang: 'es',
      lemma: c.lemma,
      translation: c.translation,
      kind: c.pos === 'phrase' ? 'phrase' : 'word',
      pos: c.pos,
      gender: c.gender,
      saved: true,
      status: 'new',
      lookups: 1,
      contexts: c.sentence ? [{ sentence: c.sentence, form: c.word, url: c.url ?? '', title: c.title ?? '', at: c.createdAt }] : [],
      firstSeen: c.createdAt,
      lastSeen: c.createdAt,
      savedAt: c.createdAt,
    });
  }
  await tx.done;
  await browser.storage.local.remove(LEGACY_DECK_KEY);
  await changed();
  return cards.length;
}

export function wordsToCsv(words: WordRecord[]): string {
  const esc = (s: string | number = '') => `"${String(s).replace(/"/g, '""')}"`;
  const rows = words.map((w) =>
    [w.lemma, w.lang, w.translation, w.pos ?? '', w.status, w.lookups, w.contexts[0]?.sentence ?? '', w.contexts[0]?.url ?? '', new Date(w.savedAt ?? w.firstSeen).toISOString().slice(0, 10)]
      .map(esc)
      .join(','),
  );
  return ['word,language,english,pos,status,lookups,example,source,added', ...rows].join('\n');
}
