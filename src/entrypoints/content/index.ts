import './popover.css';
import { autoUpdate, computePosition, flip, inline, offset, shift } from '@floating-ui/dom';
import { mount, unmount } from 'svelte';
import { browser } from 'wxt/browser';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { send } from '@/lib/messaging';
import { matchSense } from '@/lib/disambiguate';
import { applyContext, present } from '@/lib/present';
import { LANGUAGES, wordId, type Lang } from '@/lib/languages';
import { detectPageLanguage } from '@/lib/page-language';
import { getSettings, learns, pageStatus, watchSettings } from '@/lib/settings';
import { speak } from '@/lib/speech';
import { translate, translatorStatus } from '@/lib/translator';
import type { PageStatus, Settings, WordInput, WordRecord, WordStatus } from '@/lib/types';
import {
  countWords,
  pageContext,
  phraseWords,
  sameHit,
  selectionHit,
  sentenceAround,
  wordAtPoint,
  type PageContext,
  type WordHit,
} from '@/lib/word-at-point';
import Popover from './Popover.svelte';
import { actions, ui } from './state.svelte';

const HIDE_DELAY = 280;
/** How long a hover waits for on-device context translation before showing the card anyway. */
const CONTEXT_WAIT = 350;
const HIGHLIGHT = 'tt-active';
/** A hover counts as a lookup once the card has been open this long (a deliberate open counts sooner). */
const LOOKUP_DWELL = 1200;
const NEXT_STATUS: Record<WordStatus, WordStatus> = { new: 'learning', learning: 'known', known: 'new' };
/** Phrases up to this many words get a word-by-word breakdown. */
const BREAKDOWN_MAX_WORDS = 12;

/**
 * - hover:       pointer rested on a word
 * - select:      a deliberate request (double-click, Alt+select, the Translate button, a word chip) — always opens
 * - auto-select: a plain selection in "translate right away" mode — skipped when the text clearly isn't in your languages
 */
type Source = 'hover' | 'select' | 'auto-select';
type Point = { x: number; y: number };

/** Styles that must live in the page itself: the font face and the ::highlight() for the active word. */
function injectPageStyles(): HTMLStyleElement {
  const style = document.createElement('style');
  style.dataset.turbotranslate = '';
  (document.head ?? document.documentElement).append(style);
  return style;
}

function pageCss(accent: string): string {
  const font = browser.runtime.getURL('/fonts/fraunces.woff2' as '/');
  return `@font-face{font-family:'TT Fraunces';src:url('${font}') format('woff2');font-weight:100 900;font-display:swap}
::highlight(${HIGHLIGHT}){background-color:color-mix(in srgb,${accent} 24%,transparent)}`;
}

function setActiveHighlight(range: Range | null) {
  if (!('highlights' in CSS)) return;
  if (range) CSS.highlights.set(HIGHLIGHT, new Highlight(range));
  else CSS.highlights.delete(HIGHLIGHT);
}

const wordOptions = (lang: Lang) => ({ joinHyphens: lang === 'pt' });

/** Share of a text's words that the language's dictionary knows. */
async function dictionaryShare(text: string, lang: Lang): Promise<number> {
  const words = phraseWords(text, 8, wordOptions(lang));
  if (words.length < 2) return 1;
  const found = await Promise.all(
    words.map((w) =>
      send('lookup', { word: w, lang })
        .then((r) => !!r.matched)
        .catch(() => true),
    ),
  );
  return found.filter(Boolean).length / words.length;
}

/**
 * Which of your languages a piece of text is in; null when it clearly is none of them.
 * `page` is the page's language, the answer whenever the text is too short or unclear to judge.
 * `strict` (plain selections, often made just to copy text): short text isn't waved through, and an
 * unsure detection must be backed by the dictionary knowing most of the words.
 */
async function textLanguage(text: string, mine: Lang[], page: Lang, strict: boolean): Promise<Lang | null> {
  const declared = document.documentElement.lang.toLowerCase().slice(0, 2);
  if (mine.length === 1 && declared === page) return page;
  const telltale = mine.find((l) => LANGUAGES[l].telltale.test(text));
  if (strict && telltale) return telltale;
  if (!strict && text.length < 24) return page; // Too short to judge — give it the benefit of the doubt.
  try {
    const r = await browser.i18n.detectLanguage(text);
    const best = r.languages
      .filter((l) => l.percentage >= 30 && (mine as string[]).includes(l.language.slice(0, 2)))
      .sort((a, b) => b.percentage - a.percentage)[0];
    const found = best ? (best.language.slice(0, 2) as Lang) : null;
    if (r.isReliable) return found;
    if (!strict) return found ?? page;
  } catch {
    if (!strict) return page;
  }
  for (const lang of [page, ...mine.filter((l) => l !== page)]) {
    if ((await dictionaryShare(text, lang)) >= 0.6) return lang;
  }
  return null;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  cssInjectionMode: 'ui',

  async main(ctx) {
    let settings: Settings = await getSettings();
    const pageStyle = injectPageStyles();

    const shadowUi = await createShadowRootUi(ctx, {
      name: 'turbo-translate',
      position: 'inline',
      anchor: 'html',
      append: 'last',
      onMount: (container) => mount(Popover, { target: container }),
      onRemove: (app) => {
        if (app) void unmount(app);
      },
    });
    shadowUi.mount();
    const host = shadowUi.shadowHost;
    const card = () => shadowUi.shadow.querySelector<HTMLElement>('.tt-card');

    // ---------- Is this page in one of your languages? ----------

    let language: string | null = null;
    let status: PageStatus = pageStatus(settings, location.hostname, null);
    const isActive = () => status.state === 'active';

    let reported = '';
    function updateStatus() {
      status = pageStatus(settings, location.hostname, language);
      if (!isActive()) {
        close();
        hidePill();
      }
      // Tell the background (toolbar badge) whenever anything it shows changes, including the first time.
      const key = `${status.state}|${status.reason}|${status.lang}|${settings.accent}`;
      if (key !== reported) {
        reported = key;
        void send('pageStatus', status).catch(() => {});
      }
    }

    async function checkLanguage() {
      language = await detectPageLanguage(settings.languages);
      updateStatus();
    }

    /** Pages often fill in after load (apps, infinite feeds): look again a few times while not yet in your language. */
    function scheduleChecks() {
      for (const delay of [1500, 4000, 9000]) {
        ctx.setTimeout(() => {
          if (!learns(settings, language)) void checkLanguage();
        }, delay);
      }
    }

    function applySettings(s: Settings) {
      const languagesChanged = s.languages.join() !== settings.languages.join();
      settings = s;
      if (languagesChanged) void checkLanguage();
      ui.theme = s.theme;
      ui.accent = s.accent;
      ui.aiEnabled = s.ai.provider !== 'none';
      pageStyle.textContent = pageCss(s.accent);
      updateStatus();
    }

    // ---------- Positioning ----------

    let stopAutoUpdate: (() => void) | null = null;

    /** Anchor the card to a range. For multi-line selections, `point` picks the line the mouse was released on. */
    function place(range: Range, point?: Point) {
      const el = card();
      if (!el) return;
      const reference = {
        getBoundingClientRect: () => range.getBoundingClientRect(),
        getClientRects: () => range.getClientRects(),
        contextElement: range.startContainer.parentElement ?? undefined,
      };
      stopAutoUpdate?.();
      stopAutoUpdate = autoUpdate(reference, el, () => {
        void computePosition(reference, el, {
          strategy: 'fixed',
          placement: 'bottom-start',
          middleware: [inline(point), offset(10), flip({ padding: 12 }), shift({ padding: 12 })],
        }).then(({ x, y, placement }) => {
          el.style.left = `${Math.round(x)}px`;
          el.style.top = `${Math.round(y)}px`;
          el.dataset.side = placement.split('-')[0];
        });
      });
    }

    // ---------- Open / close ----------

    let current: WordHit | null = null;
    let currentPoint: Point | undefined;
    let currentContext: PageContext | null = null;
    /** The phrase a word view came from, so the back button can return to it. */
    let phrase: { hit: WordHit; point?: Point } | null = null;
    let pending: WordHit | null = null;
    let hoverTimer = 0;
    let hideTimer = 0;
    let seq = 0;

    function cancelHide() {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }

    function scheduleHide() {
      if (ui.pinned || hideTimer) return;
      hideTimer = window.setTimeout(close, HIDE_DELAY);
    }

    function close() {
      cancelHide();
      clearTimeout(hoverTimer);
      seq++;
      current = pending = phrase = null;
      ui.open = false;
      ui.pinned = false;
      setActiveHighlight(null);
      stopAutoUpdate?.();
      stopAutoUpdate = null;
    }

    async function show(hit: WordHit, source: Source, opts: { point?: Point; backTo?: string } = {}) {
      // A card you opened on purpose (a selection, a click) is never replaced by a passing hover.
      if (source === 'hover' && ui.open && ui.pinned) return;
      const id = ++seq;
      hidePill();
      const sentence = sentenceAround(hit);
      // Which dictionary: the text's own language when you learn several, else the page's.
      let lang = status.lang;
      if (source !== 'select' && (settings.matchLanguage || settings.languages.length > 1)) {
        const sample = source === 'auto-select' && countWords(hit.text, wordOptions(status.lang)) >= 3 ? hit.text : sentence;
        const found = await textLanguage(sample, settings.languages, status.lang, source === 'auto-select');
        if (!found && settings.matchLanguage) return;
        lang = found ?? status.lang;
      }
      if (id !== seq) return;

      const deliberate = source !== 'hover';
      const isPhrase = countWords(hit.text, wordOptions(lang)) > 1;
      const fresh = {
        lang,
        word: hit.text,
        sentence,
        isPhrase,
        phase: 'loading' as 'loading' | 'ready' | 'error',
        error: '',
        data: null as ReturnType<typeof present>,
        clitics: [] as string[],
        wordMT: null as string | null,
        sentenceMT: null as string | null,
        snippet: null as { text: string; en: string } | null,
        contextTerm: null as string | null,
        breakdown: null as { word: string; gloss: string }[] | null,
        backTo: opts.backTo ?? null,
        saved: false,
        status: 'new' as WordStatus,
        lookups: 0,
        ai: { status: 'idle' as const, data: null, error: '' },
        pinned: deliberate,
      };
      const open = () => {
        current = hit;
        currentPoint = opts.point;
        cancelHide();
        Object.assign(ui, fresh, { open: true });
        setActiveHighlight(hit.range);
        place(hit.range, opts.point);
      };

      // A selection is a deliberate request: open at once with a loading state.
      // A hover opens only once there is something to show, so stray text never flashes a popover,
      // and an already-open card swaps to the new word in one step.
      if (deliberate) open();
      const target = deliberate ? ui : fresh;

      // A phrase is its own context; a single word looks around the page (vital for lone labels like "Cuenta").
      const context = pageContext(hit, sentence, isPhrase ? 0 : 2);
      const sentenceIsNew = !!sentence && sentence !== hit.text && !hit.text.includes(sentence);
      const sentenceMT = sentenceIsNew ? translate(sentence, lang) : Promise.resolve(null);
      let contextDone = false;
      const contextMT = Promise.all([sentenceMT, ...context.snippets.map((s) => translate(s, lang))]).then((r) => {
        contextDone = true;
        return r;
      });
      ui.mtStatus = await translatorStatus(lang);

      try {
        let data: ReturnType<typeof present> = null;
        let clitics: string[] = [];
        let record: WordRecord | null = null;
        let wordMT: string | null = null;
        let breakdown: { word: string; gloss: string }[] | null = null;
        if (isPhrase) {
          // Translate the phrase, then gloss each word with the sense that fits that translation.
          const words = countWords(hit.text, wordOptions(lang)) <= BREAKDOWN_MAX_WORDS ? phraseWords(hit.text, 10, wordOptions(lang)) : [];
          const [mt, ...entries] = await Promise.all([
            translate(hit.text, lang),
            ...words.map((w) =>
              send('lookup', { word: w, lang })
                .then((r) => present(w, r))
                .catch(() => null),
            ),
          ]);
          wordMT = mt as string | null;
          breakdown = words
            .map((word, i) => {
              let p = entries[i] as ReturnType<typeof present>;
              if (!p) return { word, gloss: '' };
              const m = wordMT ? matchSense(p.groups, [wordMT]) : null;
              if (m) p = applyContext(p, m);
              return { word, gloss: p.primary };
            })
            .filter((b) => b.gloss);
          record = await send('getWord', { id: wordId(lang, hit.text) }).catch(() => null);
        } else {
          const result = await send('lookup', { word: hit.text, lang });
          data = present(hit.text, result);
          clitics = result.clitics;
          if (data) record = await send('getWord', { id: wordId(lang, data.lemma) }).catch(() => null);
          else wordMT = await translate(hit.text, lang);
        }
        if (id !== seq) return;
        if (source === 'hover' && !data && !wordMT) {
          if (ui.open) close();
          return;
        }
        Object.assign(target, { data, clitics, wordMT, breakdown, phase: 'ready' }, recordFields(record));
      } catch (err) {
        if (id !== seq) return;
        Object.assign(target, { phase: 'error', error: err instanceof Error ? err.message : String(err) });
      }

      // Pick the sense that fits the page. Give translation a moment so the card opens with it on top.
      type ContextTarget = Pick<typeof ui, 'sentenceMT' | 'snippet' | 'data' | 'contextTerm'>;
      const applyPageContext = (t: ContextTarget, [sMT, ...snippetMTs]: (string | null)[]) => {
        t.sentenceMT = sMT ?? null;
        const i = snippetMTs.findIndex(Boolean);
        t.snippet = i >= 0 ? { text: context.snippets[i]!, en: snippetMTs[i]! } : null;
        if (!t.data) return;
        // A full sentence is the best evidence; for a lone label, use the rest of the page.
        const informative = sentence.split(/\s+/).length >= 3;
        const match =
          (informative && matchSense(t.data.groups, [sMT])) ||
          matchSense(t.data.groups, snippetMTs) ||
          (!informative && sentence !== hit.text ? matchSense(t.data.groups, [sMT]) : null);
        if (match) {
          t.data = applyContext(t.data, match);
          t.contextTerm = match.term;
        }
      };

      if (source === 'hover') await Promise.race([contextMT, new Promise((r) => setTimeout(r, CONTEXT_WAIT))]);
      if (id !== seq) return;
      if (contextDone) applyPageContext(target, await contextMT);
      currentContext = context;
      if (source === 'hover') open();
      if (!isPhrase) scheduleLookup(id, deliberate ? 300 : LOOKUP_DWELL);
      if (!contextDone) {
        const r = await contextMT;
        if (id !== seq) return;
        applyPageContext(ui, r);
      }
      // Ask the AI when asked to always, or when a phrase has no translation otherwise.
      if (ui.aiEnabled && ui.phase === 'ready' && (settings.ai.auto || (isPhrase && !ui.wordMT))) void actions.explain(false);
    }

    // ---------- Your words ----------

    /** Words already counted on this page, so re-reading one paragraph doesn't inflate "seen 5×". */
    const countedHere = new Set<string>();

    function recordFields(r: WordRecord | null) {
      return { saved: r?.saved ?? false, status: r?.status ?? ('new' as WordStatus), lookups: r?.lookups ?? 0 };
    }

    /** The open card as a word to store: its dictionary form, the meaning that fit, and where you met it. */
    function wordInput(): WordInput | null {
      const context = { sentence: ui.sentence, form: ui.word, url: location.href, title: document.title, at: Date.now() };
      if (ui.isPhrase) {
        const translation = ui.wordMT || ui.ai.data?.sentenceTranslation || ui.ai.data?.meaning || '';
        return { id: wordId(ui.lang, ui.word), lang: ui.lang, lemma: ui.word, translation, kind: 'phrase', context };
      }
      const d = ui.data;
      if (!d && !ui.wordMT) return null;
      const lemma = d?.lemma ?? ui.word.toLowerCase();
      return {
        id: wordId(ui.lang, lemma),
        lang: ui.lang,
        lemma,
        translation: d?.primary || ui.wordMT || '',
        kind: 'word',
        pos: d?.pos,
        gender: d?.gender,
        context,
      };
    }

    function scheduleLookup(id: number, delay: number) {
      ctx.setTimeout(async () => {
        if (id !== seq || !ui.open || ui.isPhrase) return;
        const input = wordInput();
        if (!input || countedHere.has(input.id)) return;
        countedHere.add(input.id);
        const record = await send('recordLookup', input).catch(() => null);
        if (record && id === seq) Object.assign(ui, recordFields(record));
      }, delay);
    }

    // ---------- Translate button for selections ----------

    let pillHit: WordHit | null = null;
    let pillPoint: Point | undefined;

    function showPill(hit: WordHit, point: Point) {
      pillHit = hit;
      pillPoint = point;
      const below = point.y + 52 < innerHeight;
      ui.pill = {
        x: Math.min(Math.max(point.x - 16, 8), innerWidth - 120),
        y: below ? point.y + 16 : point.y - 48,
      };
    }

    function hidePill() {
      pillHit = null;
      ui.pill = null;
    }

    // ---------- Actions from the popover ----------

    actions.close = close;
    actions.speak = () =>
      speak(ui.isPhrase ? ui.word : (ui.data?.headword ?? ui.word), ui.lang, settings.speechRate, document.documentElement.lang);
    actions.openSettings = () => void send('openOptions', {});

    actions.translateSelection = () => {
      if (pillHit) void show(pillHit, 'select', { point: pillPoint });
    };

    actions.openWord = (word) => {
      if (!current) return;
      phrase = { hit: current, point: currentPoint };
      void show({ ...current, text: word }, 'select', { point: currentPoint, backTo: current.text });
    };

    actions.back = () => {
      if (phrase) void show(phrase.hit, 'select', { point: phrase.point });
    };

    actions.toggleSave = async () => {
      const input = wordInput();
      if (!input) return;
      if (ui.saved) {
        ui.saved = false;
        await send('unsaveWord', { id: input.id });
        return;
      }
      ui.saved = true;
      const id = seq;
      const record = await send('saveWord', input);
      if (id === seq) Object.assign(ui, recordFields(record));
    };

    actions.cycleStatus = async () => {
      const input = wordInput();
      if (!input || !ui.saved) return;
      const status = NEXT_STATUS[ui.status];
      ui.status = status;
      await send('setWordStatus', { id: input.id, status });
    };

    actions.explain = async (pin = true) => {
      const id = seq;
      if (pin) ui.pinned = true;
      ui.ai = { status: 'loading', data: null, error: '' };
      try {
        const context = currentContext
          ? { title: currentContext.title, site: currentContext.site, snippets: [...currentContext.snippets] }
          : undefined;
        const data = await send('explain', { word: ui.word, sentence: ui.sentence, lang: ui.lang, context });
        if (id === seq) ui.ai = { status: 'ready', data, error: '' };
      } catch (err) {
        if (id === seq) ui.ai = { status: 'error', data: null, error: err instanceof Error ? err.message : String(err) };
      }
    };

    applySettings(settings);
    const stopWatching = watchSettings(applySettings);
    void checkLanguage();
    scheduleChecks();

    // Single-page apps change content without reloading: re-check after each navigation.
    let lastUrl = location.href;
    ctx.setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      countedHere.clear();
      ctx.setTimeout(() => void checkLanguage(), 800);
      scheduleChecks();
    }, 1000);

    // The toolbar popup asks what's going on in this tab.
    const onPopupMessage = (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
      if ((msg as { type?: string })?.type !== 'getPageStatus') return false;
      sendResponse(status);
      return false;
    };
    browser.runtime.onMessage.addListener(onPopupMessage);

    // ---------- Pointer tracking ----------

    let last = { x: 0, y: 0, alt: false, overCard: false, buttons: 0 };
    let frame = 0;

    function evaluate(immediate = false) {
      frame = 0;
      if (!isActive() || settings.trigger === 'click') return;
      // Don't hover-translate while dragging a selection, or over a card you opened on purpose.
      if (last.buttons !== 0 || (ui.open && ui.pinned)) return;

      if (last.overCard) {
        cancelHide();
        clearTimeout(hoverTimer);
        pending = null;
        return;
      }

      const needsAlt = settings.trigger === 'hover-alt';
      const hit = !needsAlt || last.alt ? wordAtPoint(last.x, last.y, wordOptions(status.lang)) : null;

      if (ui.open && current && hit && sameHit(hit, current)) {
        cancelHide();
        return;
      }
      if (!hit) {
        clearTimeout(hoverTimer);
        pending = null;
        if (ui.open && !(current && pointInRange(current.range, last.x, last.y))) scheduleHide();
        return;
      }
      if (sameHit(hit, pending)) return;

      pending = hit;
      clearTimeout(hoverTimer);
      const delay = immediate ? 0 : ui.open ? Math.min(settings.hoverDelay, 180) : settings.hoverDelay;
      hoverTimer = window.setTimeout(() => {
        pending = null;
        void show(hit, 'hover');
      }, delay);
    }

    function pointInRange(range: Range, x: number, y: number) {
      for (const r of range.getClientRects()) {
        if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
      }
      return false;
    }

    ctx.addEventListener(
      document,
      'pointermove',
      (e: PointerEvent) => {
        if (e.pointerType === 'touch') return;
        last = { x: e.clientX, y: e.clientY, alt: e.altKey, overCard: e.composedPath().includes(host), buttons: e.buttons };
        if (!frame) frame = requestAnimationFrame(() => evaluate());
      },
      { passive: true },
    );

    ctx.addEventListener(document, 'pointerdown', (e: PointerEvent) => {
      // A press starts a click or a selection: a hover that was about to fire would only get in the way.
      clearTimeout(hoverTimer);
      pending = null;
      if (e.composedPath().includes(host)) {
        if (ui.open) ui.pinned = true;
        return;
      }
      if (ui.open) close();
      hidePill();
    });

    ctx.addEventListener(document, 'mouseup', (e: MouseEvent) => {
      if (e.button !== 0 || e.composedPath().includes(host) || !isActive()) return;
      const point = { x: e.clientX, y: e.clientY };
      // Double/triple-click and Alt+select are explicit; a plain drag-select follows the selection setting.
      const explicit = e.detail >= 2 || e.altKey;
      // Let the browser finish updating the selection first.
      setTimeout(() => {
        const hit = selectionHit();
        if (!hit || (ui.open && sameHit(hit, current))) return;
        if (explicit) void show(hit, 'select', { point });
        else if (settings.selection === 'instant') void show(hit, 'auto-select', { point });
        else if (settings.selection === 'button') showPill(hit, point);
      }, 0);
    });

    ctx.addEventListener(document, 'selectionchange', () => {
      if (ui.pill && window.getSelection()?.isCollapsed) hidePill();
    });

    ctx.addEventListener(window, 'scroll', () => ui.pill && hidePill(), { capture: true, passive: true });

    ctx.addEventListener(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (ui.open) close();
        hidePill();
      } else if (e.key === 'Alt' && settings.trigger === 'hover-alt') {
        last.alt = true;
        evaluate(true);
      }
    });

    ctx.addEventListener(document, 'keyup', (e: KeyboardEvent) => {
      if (e.key === 'Alt') last.alt = false;
    });

    // Not window "blur": on Windows, tapping Alt focuses Chrome's menu, which would close the popover.
    ctx.addEventListener(document, 'visibilitychange', () => {
      if (document.hidden) {
        close();
        hidePill();
      }
    });

    ctx.onInvalidated(() => {
      browser.runtime.onMessage.removeListener(onPopupMessage);
      close();
      stopWatching();
      pageStyle.remove();
    });
  },
});
