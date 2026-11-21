<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import Logo from '@/assets/Logo.svelte';
  import { allWords, isSuggested, watchWords } from '@/lib/words';
  import { getSettings, pageStatus, toggleSite as nextSiteLists, updateSettings, watchSettings, DEFAULT_SETTINGS } from '@/lib/settings';
  import { downloadTranslator, translatorStatus, type TranslatorStatus } from '@/lib/translator';
  import { LANGUAGES, languageName, type Lang } from '@/lib/languages';
  import type { PageStatus, SelectionMode, Settings, TriggerMode, WordRecord } from '@/lib/types';

  let settings = $state<Settings>(DEFAULT_SETTINGS);
  let host = $state('');
  let words = $state<WordRecord[]>([]);
  let saved = $derived(words.filter((w) => w.saved));
  let counts = $derived({
    new: saved.filter((w) => w.status === 'new').length,
    learning: saved.filter((w) => w.status === 'learning').length,
    known: saved.filter((w) => w.status === 'known').length,
  });
  let suggestedCount = $derived(words.filter(isSuggested).length);
  let thisWeek = $derived(saved.filter((w) => (w.savedAt ?? 0) > Date.now() - 7 * 86_400_000).length);
  /** On-device translation model per language. */
  let mt = $state<Partial<Record<Lang, TranslatorStatus>>>({});
  let progress = $state<Partial<Record<Lang, number>>>({});
  let mtError = $state('');
  let mtLangs = $derived(settings.languages);
  let mtValues = $derived(mtLangs.map((l) => mt[l]));
  let mtSummary = $derived.by(() => {
    if (mtValues.some((v) => v === undefined)) return 'Checking…';
    if (mtValues.every((v) => v === 'unsupported' || v === 'unavailable')) return 'Not available in this browser. Dictionary still works.';
    if (mtValues.every((v) => v === 'available')) return 'Ready. Runs privately on your device.';
    if (mtValues.some((v) => v === 'downloading')) return 'Downloading…';
    return 'Built into Chrome, free. One-time download per language.';
  });

  const triggers: { value: TriggerMode; label: string }[] = [
    { value: 'hover', label: 'Hover' },
    { value: 'hover-alt', label: 'Alt + hover' },
    { value: 'click', label: 'Double-click' },
  ];
  const selections: { value: SelectionMode; label: string }[] = [
    { value: 'instant', label: 'Translate' },
    { value: 'button', label: 'Show button' },
    { value: 'off', label: 'Off' },
  ];

  /** What the content script reported for this tab; null if it isn't running there (yet). */
  let reported = $state<PageStatus | null>(null);
  let tabId = $state<number | undefined>();
  // Re-derive locally so the switch responds instantly; the language comes from the page.
  let page = $derived(reported ? pageStatus(settings, reported.host, reported.language) : null);

  let languageList = $derived(settings.languages.map((l) => LANGUAGES[l].name).join(', '));

  let pageNote = $derived.by(() => {
    if (!page) return host ? 'Reload this page to start.' : '';
    switch (page.reason) {
      case 'match':
        return `${languageName(page.language)} page · translating`;
      case 'other-language':
        return `${languageName(page.language)} page · sleeping`;
      case 'checking':
        return 'Checking the page language…';
      case 'forced-on':
        return 'Always on for this site';
      case 'everywhere':
        return 'On for every site';
      case 'site-off':
        return 'Turned off for this site';
      case 'disabled':
        return 'TurboTranslate is off';
    }
  });

  $effect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty('--accent', settings.accent);
  });

  onMount(() => {
    void getSettings().then((s) => (settings = s));
    const loadWords = () => void allWords().then((w) => (words = w));
    loadWords();
    void Promise.all(Object.keys(LANGUAGES).map(async (l) => [l, await translatorStatus(l as Lang)] as const)).then(
      (all) => (mt = Object.fromEntries(all)),
    );
    void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      try {
        const url = new URL(tab?.url ?? '');
        if (url.protocol.startsWith('http')) host = url.hostname;
      } catch {
        /* chrome:// pages etc. */
      }
      tabId = tab?.id;
      if (tabId !== undefined && host) {
        browser.tabs
          .sendMessage(tabId, { type: 'getPageStatus' })
          .then((s) => (reported = (s as PageStatus) ?? null))
          .catch(() => (reported = null)); // No content script: tab opened before install, or a restricted page.
      }
    });
    const a = watchSettings((s) => (settings = s));
    const b = watchWords(loadWords);
    return () => {
      a();
      b();
    };
  });

  async function patch(p: Partial<Settings>) {
    settings = await updateSettings(p);
  }

  function toggleSite() {
    if (page) void patch(nextSiteLists(settings, page));
  }

  async function download(lang: Lang) {
    mt[lang] = 'downloading';
    mtError = '';
    try {
      await downloadTranslator(lang, (f) => (progress[lang] = f));
    } catch (e) {
      mtError = e instanceof Error ? e.message : String(e);
    }
    mt[lang] = await translatorStatus(lang);
  }

  const openOptions = () => browser.runtime.openOptionsPage();
  const openWords = (filter?: string) =>
    browser.tabs.create({ url: browser.runtime.getURL(`/words.html${filter ? `#${filter}` : ''}` as '/') });
</script>

<main class="popup">
  <header class="row">
    <div class="brand">
      <Logo />
      <div>
        <div class="brand-name">TurboTranslate</div>
        <div class="brand-sub">{languageList} → English</div>
      </div>
    </div>
    <button
      class="switch"
      role="switch"
      aria-checked={settings.enabled}
      aria-label="Enable TurboTranslate"
      title="Alt+Shift+T"
      onclick={() => patch({ enabled: !settings.enabled })}
    ></button>
  </header>

  <section class="card block" class:dimmed={!settings.enabled}>
    {#if host}
      <div class="row">
        <div class="site">
          <span class="site-title">
            <span class="dot" data-state={page?.state ?? 'none'} aria-hidden="true"></span>
            {host}
          </span>
          <span class="muted note">{pageNote}</span>
        </div>
        {#if page && settings.enabled}
          <button
            class="switch"
            role="switch"
            aria-checked={page.state === 'active'}
            aria-label="Translate on {host}"
            title={page.state === 'active' ? 'Turn off for this site' : 'Turn on for this site'}
            onclick={toggleSite}
          ></button>
        {/if}
      </div>
      <hr />
    {/if}
    <div class="label">Show translation on</div>
    <div class="segmented" role="group" aria-label="Trigger">
      {#each triggers as t (t.value)}
        <button aria-pressed={settings.trigger === t.value} onclick={() => patch({ trigger: t.value })}>{t.label}</button>
      {/each}
    </div>
    <p class="hint muted">
      {#if settings.trigger === 'hover'}Rest the pointer on a word.
      {:else if settings.trigger === 'hover-alt'}Hold <kbd>Alt</kbd> while pointing at a word.
      {:else}Double-click a word.{/if}
    </p>
    <div class="label">When you select text</div>
    <div class="segmented" role="group" aria-label="Selected text">
      {#each selections as s (s.value)}
        <button aria-pressed={settings.selection === s.value} onclick={() => patch({ selection: s.value })}>{s.label}</button>
      {/each}
    </div>
  </section>

  <section class="card block">
    <div>
      <div class="title">Offline sentence translation</div>
      <div class="muted small">{mtSummary}</div>
    </div>
    {#each mtLangs as l (l)}
      {@const status = mt[l]}
      {#if status && status !== 'unsupported' && status !== 'unavailable'}
        <div class="row model">
          <span class="model-name">{LANGUAGES[l].name}</span>
          {#if status === 'available'}
            <span class="ok" aria-label="{LANGUAGES[l].name} ready">
              <svg viewBox="0 0 20 20"><path d="M5 10.5l3.2 3L15 6.5" /></svg>
            </span>
          {:else if status === 'downloadable'}
            <button class="btn btn-accent" onclick={() => download(l)}>Download</button>
          {:else}
            <div class="progress"><span style:width="{Math.max(4, (progress[l] ?? 0) * 100)}%"></span></div>
          {/if}
        </div>
      {/if}
    {/each}
    {#if mtError}<p class="error small">{mtError}</p>{/if}
  </section>

  <section class="card block">
    <div class="row">
      <div class="label">My words</div>
      <span class="count">{saved.length}</span>
    </div>
    {#if saved.length}
      <div class="bar" role="img" aria-label="{counts.new} new, {counts.learning} learning, {counts.known} known">
        {#each ['new', 'learning', 'known'] as const as s (s)}
          {#if counts[s]}<span data-status={s} style:flex-grow={counts[s]}></span>{/if}
        {/each}
      </div>
      <div class="legend">
        <span><i data-status="new"></i>{counts.new} new</span>
        <span><i data-status="learning"></i>{counts.learning} learning</span>
        <span><i data-status="known"></i>{counts.known} known</span>
      </div>
      {#if thisWeek}<p class="muted small empty">+{thisWeek} saved this week</p>{/if}
    {:else}
      <p class="muted small empty">Tap the bookmark in a translation to save a word.</p>
    {/if}
    {#if suggestedCount}
      <button class="suggest" onclick={() => openWords('suggested')}>
        <span><strong>{suggestedCount}</strong> word{suggestedCount === 1 ? '' : 's'} you keep looking up</span>
        <span aria-hidden="true">→</span>
      </button>
    {/if}
    {#if saved.length || suggestedCount}
      <button class="btn btn-accent wide" onclick={() => openWords()}>Open My words</button>
    {/if}
  </section>

  <footer class="row">
    <button class="btn" onclick={openOptions}>
      <svg viewBox="0 0 20 20" class="gear" aria-hidden="true"><path d="M10 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z" /><path d="M16.2 11.9l1.3 1-1.6 2.8-1.6-.5a6 6 0 0 1-1.7 1l-.3 1.6H9.1l-.4-1.6a6 6 0 0 1-1.6-1l-1.6.5-1.6-2.8 1.3-1a6 6 0 0 1 0-1.9l-1.3-1 1.6-2.7 1.6.5a6 6 0 0 1 1.6-1l.4-1.6h3.2l.3 1.6a6 6 0 0 1 1.7 1l1.6-.5 1.6 2.8-1.3 1a6 6 0 0 1 0 1.8Z" /></svg>
      Settings
    </button>
    <span class="muted small shortcut" title="Turn on or off"><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd></span>
  </footer>
</main>

<style>
  .popup {
    width: 340px;
    padding: 14px;
    display: grid;
    gap: 10px;
  }
  header {
    padding: 2px 2px 4px;
  }
  .block {
    padding: 12px 13px;
    display: grid;
    gap: 8px;
    transition: opacity 0.2s;
  }
  .dimmed {
    opacity: 0.5;
  }
  hr {
    width: 100%;
    margin: 2px 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .site {
    display: grid;
    min-width: 0;
  }
  .site-title {
    display: flex;
    align-items: center;
    gap: 7px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    font-size: 12px;
    padding-left: 15px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--faint);
  }
  .dot[data-state='active'] {
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent);
  }
  .dot[data-state='off'] {
    background: var(--error);
  }
  .title {
    font-weight: 600;
  }
  .small {
    font-size: 12px;
  }
  .hint {
    margin: 0;
    font-size: 12px;
  }
  kbd {
    font: 600 10.5px/1 var(--sans);
    padding: 2px 5px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--hover);
  }
  .ok {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--ok) 15%, transparent);
    flex-shrink: 0;
  }
  .ok svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--ok);
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .model {
    min-height: 28px;
  }
  .model-name {
    font-size: 13px;
  }
  /* Download progress (the status bar below uses .bar). */
  .progress {
    width: 110px;
    height: 6px;
    border-radius: 3px;
    background: var(--hover);
    overflow: hidden;
  }
  .progress span {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: var(--accent);
    transition: width 0.3s;
  }
  .error {
    margin: 0;
    color: var(--error);
  }
  .count {
    min-width: 22px;
    padding: 1px 7px;
    border-radius: 999px;
    text-align: center;
    font-size: 11.5px;
    font-weight: 650;
    color: var(--accent-ink);
    background: var(--accent-soft);
  }
  .bar {
    display: flex;
    gap: 3px;
    height: 7px;
    border-radius: 4px;
    overflow: hidden;
  }
  .bar span {
    flex-basis: 0;
    min-width: 5px;
    border-radius: 4px;
    background: var(--c);
  }
  [data-status='new'] {
    --c: var(--faint);
  }
  [data-status='learning'] {
    --c: var(--accent);
  }
  [data-status='known'] {
    --c: var(--ok);
  }
  .legend {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: var(--muted);
  }
  .legend i {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 5px;
    border-radius: 50%;
    background: var(--c);
  }
  .suggest {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px;
    border: 0;
    border-radius: 9px;
    background: var(--accent-soft);
    color: var(--text);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .suggest:hover {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .wide {
    width: 100%;
  }
  .empty {
    margin: 0;
  }
  .gear {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  footer {
    padding: 2px 2px 0;
  }
  footer .btn {
    white-space: nowrap;
  }
  .shortcut {
    white-space: nowrap;
  }
</style>
