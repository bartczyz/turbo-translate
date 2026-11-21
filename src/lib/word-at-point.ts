import { escapeRe } from './text';

export interface WordHit {
  text: string;
  node: Text;
  start: number;
  end: number;
  range: Range;
}

const wordSegmenter = new Intl.Segmenter('es', { granularity: 'word' });
const sentenceSegmenter = new Intl.Segmenter('es', { granularity: 'sentence' });

export interface WordOptions {
  /** Treat "dá-me", "levantar-se", "guarda-chuva" as one word (Portuguese). */
  joinHyphens?: boolean;
}

type Seg = { segment: string; index: number; isWordLike: boolean };
const HYPHEN = /^[-\u2010\u2011]$/;

/** Word segments, with hyphen-joined words merged when asked. */
function segments(text: string, opts: WordOptions = {}): Seg[] {
  const out: Seg[] = [];
  for (const s of wordSegmenter.segment(text)) {
    const seg = { segment: s.segment, index: s.index, isWordLike: !!s.isWordLike };
    const prev = out[out.length - 1];
    const hyphen = out[out.length - 2];
    // word "-" word → one word ("dá" "-" "me" → "dá-me")
    if (opts.joinHyphens && seg.isWordLike && prev && HYPHEN.test(prev.segment) && hyphen?.isWordLike) {
      out.length -= 1;
      hyphen.segment += prev.segment + seg.segment;
      continue;
    }
    out.push(seg);
  }
  return out;
}

const BREAKING_TAGS = new Set([
  'BR', 'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TD', 'TH', 'SECTION', 'ARTICLE',
  'HEADER', 'FOOTER', 'NAV', 'BLOCKQUOTE', 'DT', 'DD', 'FIGCAPTION', 'TABLE',
]);

const SKIP_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], script, style, noscript, svg';

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

function rectsContain(range: Range, x: number, y: number): boolean {
  for (const r of range.getClientRects()) {
    if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return true;
  }
  return false;
}

/** Find the word under the pointer, or null if the pointer isn't over a word. */
export function wordAtPoint(x: number, y: number, opts: WordOptions = {}): WordHit | null {
  const caret = caretFromPoint(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null;
  const node = caret.node as Text;
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP_SELECTOR) || parent.isContentEditable) return null;

  const text = node.data;
  const segs = wordSegmenter.segment(text);
  // The caret may sit just after the last letter; try one character back too.
  const seg = [caret.offset, caret.offset - 1]
    .filter((i) => i >= 0 && i < text.length)
    .map((i) => segs.containing(i))
    .find((s) => s?.isWordLike);
  if (!seg || !/\p{L}/u.test(seg.segment)) return null;

  let start = seg.index;
  let end = seg.index + seg.segment.length;
  if (opts.joinHyphens) {
    // Grow across hyphens in both directions: "levantar-se", "dar-te-ei".
    const wordAt = (i: number) => {
      const s = i >= 0 && i < text.length ? segs.containing(i) : undefined;
      return s?.isWordLike ? s : null;
    };
    for (let next = wordAt(end + 1); HYPHEN.test(text[end] ?? '') && next; next = wordAt(end + 1)) end = next.index + next.segment.length;
    for (let prev = wordAt(start - 2); HYPHEN.test(text[start - 1] ?? '') && prev; prev = wordAt(start - 2)) start = prev.index;
  }

  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  if (!rectsContain(range, x, y)) return null;

  return { text: text.slice(start, end), node, start, end, range };
}

export const MAX_SELECTION = 1200;

/** First text node inside a range, so selections that start on an element (triple-click, <b>…) still work. */
function firstTextNode(range: Range): { node: Text; offset: number } | null {
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const node = range.startContainer as Text;
    // A selection can start at the very end of a text node; step into the next one.
    if (range.startOffset < node.data.length) return { node, offset: range.startOffset };
  }
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root.nodeType === Node.TEXT_NODE ? root.parentNode! : root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (range.intersectsNode(n) && /\S/.test((n as Text).data)) {
      const node = n as Text;
      const offset = node === range.startContainer ? range.startOffset : 0;
      return { node, offset: offset + (node.data.slice(offset).length - node.data.slice(offset).trimStart().length) };
    }
  }
  return null;
}

/** Turn the current selection into a hit: a word, a phrase or a few sentences. */
export function selectionHit(maxLength = MAX_SELECTION): WordHit | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const text = sel.toString().trim().replace(/\s+/g, ' ');
  if (!text || text.length > maxLength || !/\p{L}/u.test(text)) return null;
  const first = firstTextNode(range);
  if (!first) return null;
  const parent = first.node.parentElement;
  if (!parent || parent.closest(SKIP_SELECTOR) || parent.isContentEditable) return null;
  return { text, node: first.node, start: first.offset, end: first.offset + text.length, range: range.cloneRange() };
}

/** Distinct words of a phrase, in order: "La cuenta, por favor" → ["La", "cuenta", "por", "favor"]. */
export function phraseWords(text: string, max = 10, opts: WordOptions = {}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of segments(text, opts)) {
    if (!s.isWordLike || !/\p{L}/u.test(s.segment)) continue;
    const key = s.segment.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.segment);
    if (out.length >= max) break;
  }
  return out;
}

export function countWords(text: string, opts: WordOptions = {}): number {
  let n = 0;
  for (const s of segments(text, opts)) if (s.isWordLike) n++;
  return n;
}

function closestBlock(el: Element | null): Element | null {
  let cur = el;
  for (let i = 0; cur && i < 8; i++) {
    const display = getComputedStyle(cur).display;
    if (!display.startsWith('inline') && display !== 'contents') return cur;
    cur = cur.parentElement;
  }
  return cur ?? el;
}

/** The sentence that contains the hit, using the surrounding block's text. */
export function sentenceAround(hit: Pick<WordHit, 'node' | 'start' | 'text'>, maxBlockChars = 4000): string {
  const block = closestBlock(hit.node.parentElement);
  if (!block) return hit.text;

  // Line breaks and block elements end a sentence even without punctuation ("…de Microsoft<br>53% usado").
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let full = '';
  let offset = -1;
  for (let n = walker.nextNode(); n && full.length < maxBlockChars; n = walker.nextNode()) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      if (BREAKING_TAGS.has((n as Element).tagName)) full += '\n';
      continue;
    }
    if (n === hit.node) offset = full.length + hit.start;
    full += (n as Text).data;
  }
  if (offset < 0) return hit.node.data.trim();

  const seg = sentenceSegmenter.segment(full).containing(offset);
  const sentence = (seg?.segment ?? full).replace(/\s+/g, ' ').trim();
  return sentence.length > 400 ? sentence.slice(0, 399) + '…' : sentence;
}

export function sameHit(a: WordHit | null, b: WordHit | null): boolean {
  return !!a && !!b && a.node === b.node && a.start === b.start && a.end === b.end;
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export interface PageContext {
  title: string;
  site: string;
  /** Other sentences on the page that use the same word — vital for lone labels like "Cuenta". */
  snippets: string[];
}

/**
 * Context beyond the sentence. When the hovered text is short (a heading, a menu item, a button),
 * the sentence alone can't tell "account" from "count", so look for the same word elsewhere on the page.
 * `max` 0 skips the search (a phrase is its own context).
 */
export function pageContext(hit: WordHit, sentence: string, max = 2): PageContext {
  const ctx: PageContext = { title: document.title.trim().slice(0, 200), site: location.hostname, snippets: [] };
  if (max <= 0 || wordCount(sentence) >= 6) return ctx;

  const re = new RegExp(`(^|[^\\p{L}])(${escapeRe(hit.text)})(?=$|[^\\p{L}])`, 'iu');
  const seen = new Set([sentence.toLowerCase()]);
  const add = (s: string) => {
    const key = s.toLowerCase();
    if (seen.has(key) || wordCount(s) < 2) return;
    seen.add(key);
    ctx.snippets.push(s);
  };

  const candidates: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let visited = 0;
  for (let n = walker.nextNode(); n && visited < 5000 && candidates.length < 8; n = walker.nextNode(), visited++) {
    const t = n as Text;
    if (t === hit.node) continue;
    const m = re.exec(t.data);
    if (!m) continue;
    const parent = t.parentElement;
    if (!parent || parent.closest(SKIP_SELECTOR) || !parent.checkVisibility?.()) continue;
    const s = sentenceAround({ node: t, start: m.index + m[1]!.length, text: m[2]! });
    if (wordCount(s) >= 3) candidates.push(s);
  }
  // Fuller sentences carry more meaning; keep the most informative ones.
  candidates.sort((a, b) => Math.min(wordCount(b), 25) - Math.min(wordCount(a), 25)).forEach(add);
  // The page title is a good topic hint ("Cuenta Microsoft"), but a full sentence explains more.
  if (re.test(ctx.title)) add(ctx.title);
  ctx.snippets = ctx.snippets.slice(0, max);
  return ctx;
}
