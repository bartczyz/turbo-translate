import { browser } from 'wxt/browser';

const SAMPLE_CHARS = 3000;
const MIN_SAMPLE = 60;
/** Not prose: code, charts, scripts. Matched with closest(), so highlighted code (<pre><span>) counts too. */
const SKIP = 'script, style, noscript, template, code, pre, svg, textarea, kbd, samp';

/** Text from the page's main content (or body), enough to judge its language. */
function textSample(): string {
  const root = document.querySelector('main, article, [role="main"]') ?? document.body;
  if (!root) return '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let out = '';
  for (let n = walker.nextNode(); n && out.length < SAMPLE_CHARS; n = walker.nextNode()) {
    const t = (n as Text).data.trim();
    if (t.length > 1) out += t + ' ';
  }
  // Fall back to the whole body when <main> is mostly chrome (buttons, numbers).
  if (out.length < MIN_SAMPLE && root !== document.body && document.body) {
    return (document.body.innerText ?? '').slice(0, SAMPLE_CHARS);
  }
  return out;
}

/**
 * The page's language as a two-letter code ("es", "en", …), or null if there isn't enough text yet.
 * Reads the actual content, because many sites ship lang="en" templates around Spanish text (and vice versa).
 * `wanted`: your languages — on a mixed page, one of them wins if it's a solid share of the text.
 */
export async function detectPageLanguage(wanted: readonly string[]): Promise<string | null> {
  const declared = document.documentElement.lang.toLowerCase().slice(0, 2) || null;
  const sample = textSample();
  if (sample.replace(/\s+/g, '').length < MIN_SAMPLE) return declared;
  try {
    const r = await browser.i18n.detectLanguage(sample);
    const top = r.languages[0];
    // Mixed pages: count one of your languages if it's a solid share of the text.
    const mine = r.languages.find((l) => l.percentage >= 40 && wanted.includes(l.language.slice(0, 2)));
    if (mine) return mine.language.slice(0, 2);
    if (top && (r.isReliable || top.percentage >= 60)) return top.language.slice(0, 2);
  } catch {
    /* fall back to the declared language */
  }
  return declared;
}
