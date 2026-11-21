<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import Logo from '@/assets/Logo.svelte';
  import { LANGS, LANGUAGES, type Lang } from '@/lib/languages';
  import { posLabel } from '@/lib/present';
  import { DEFAULT_SETTINGS, getSettings, watchSettings } from '@/lib/settings';
  import { speak } from '@/lib/speech';
  import { markWord as mark } from '@/lib/text';
  import type { Settings, WordRecord, WordStatus } from '@/lib/types';
  import {
    allWords,
    deleteWords,
    isSuggested,
    saveWord,
    setStatus,
    SUGGEST_AFTER,
    unsaveWords,
    watchWords,
    wordsToCsv,
  } from '@/lib/words';

  type Filter = 'all' | WordStatus | 'suggested';
  type Sort = 'recent' | 'az' | 'seen';

  const PAGE = 150;
  const STATUS_LABEL: Record<WordStatus, string> = { new: 'New', learning: 'Learning', known: 'Known' };
  const STATUSES: WordStatus[] = ['new', 'learning', 'known'];

  let settings = $state<Settings>(DEFAULT_SETTINGS);
  let words = $state<WordRecord[]>([]);
  let loaded = $state(false);
  let query = $state('');
  let filter = $state<Filter>('all');
  let lang = $state<Lang | 'all'>('all');
  let sort = $state<Sort>('recent');
  let limit = $state(PAGE);
  let expanded = $state<string | null>(null);
  let selected = $state(new Set<string>());
  let searchEl = $state<HTMLInputElement>();

  // ---------- Derived lists ----------

  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  /** Languages you have words in (or are learning) — the language filter shows when there's more than one. */
  let langs = $derived(LANGS.filter((l) => settings.languages.includes(l) || words.some((w) => w.lang === l)));
  let inLang = $derived(lang === 'all' ? words : words.filter((w) => w.lang === lang));
  let saved = $derived(inLang.filter((w) => w.saved));
  let suggested = $derived(inLang.filter(isSuggested));
  let counts = $derived({
    all: saved.length,
    new: saved.filter((w) => w.status === 'new').length,
    learning: saved.filter((w) => w.status === 'learning').length,
    known: saved.filter((w) => w.status === 'known').length,
    suggested: suggested.length,
  });
  let addedThisWeek = $derived(saved.filter((w) => (w.savedAt ?? 0) > Date.now() - 7 * 86_400_000).length);

  const when = (w: WordRecord) => (w.saved ? (w.savedAt ?? w.firstSeen) : w.lastSeen);

  let filtered = $derived.by(() => {
    const base = filter === 'suggested' ? suggested : filter === 'all' ? saved : saved.filter((w) => w.status === filter);
    const q = fold(query.trim());
    const hits = q
      ? base.filter(
          (w) =>
            fold(w.lemma).includes(q) || fold(w.translation).includes(q) || w.contexts.some((c) => fold(c.form).includes(q)),
        )
      : base;
    const sorted = [...hits];
    if (sort === 'az') sorted.sort((a, b) => a.lemma.localeCompare(b.lemma, a.lang));
    else if (sort === 'seen') sorted.sort((a, b) => b.lookups - a.lookups || when(b) - when(a));
    else sorted.sort((a, b) => when(b) - when(a));
    return sorted;
  });

  let visible = $derived(filtered.slice(0, limit));

  function bucket(ts: number): string {
    const day = new Date(ts);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Rounded: a day across a daylight-saving change is 23 or 25 hours long.
    const diff = Math.round((today.getTime() - new Date(day).setHours(0, 0, 0, 0)) / 86_400_000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return 'Earlier this week';
    return day.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  /** Date groups for "Recent"; one unlabeled group for the other sorts. */
  let groups = $derived.by(() => {
    if (sort !== 'recent') return [{ label: '', items: visible }];
    const out: { label: string; items: WordRecord[] }[] = [];
    for (const w of visible) {
      const label = bucket(when(w));
      if (out.at(-1)?.label === label) out.at(-1)!.items.push(w);
      else out.push({ label, items: [w] });
    }
    return out;
  });

  // Reset paging and selection when the view changes.
  $effect(() => {
    void filter;
    void query;
    void sort;
    void lang;
    limit = PAGE;
    selected = new Set();
  });

  // ---------- Helpers ----------

  const host = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };

  const shortDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  // ---------- Actions ----------

  async function reload() {
    words = await allWords();
    loaded = true;
  }

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function selectAllVisible() {
    selected = selected.size === visible.length ? new Set() : new Set(visible.map((w) => w.id));
  }

  async function bulkStatus(status: WordStatus) {
    await setStatus([...selected], status);
    selected = new Set();
  }

  async function bulkRemove() {
    const ids = [...selected];
    if (!confirm(`Remove ${ids.length} word${ids.length === 1 ? '' : 's'} from My words?`)) return;
    await unsaveWords(ids);
    selected = new Set();
  }

  async function saveSuggested(w: WordRecord) {
    const ctx = w.contexts[0] ?? { sentence: '', form: w.lemma, url: '', title: '', at: Date.now() };
    await saveWord({ id: w.id, lang: w.lang, lemma: w.lemma, translation: w.translation, kind: w.kind, pos: w.pos, gender: w.gender, context: ctx });
  }

  async function forget(w: WordRecord) {
    if (!confirm(`Delete “${w.lemma}” and its lookup history?`)) return;
    await deleteWords([w.id]);
  }

  function exportCsv(list: WordRecord[]) {
    const blob = new Blob([wordsToCsv(list)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `turbotranslate-words-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    // Revoke later: the download reads the blob after click() returns.
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  function onKey(e: KeyboardEvent) {
    const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
    if (e.key === '/' && !typing) {
      e.preventDefault();
      searchEl?.focus();
    } else if (e.key === 'Escape') {
      if (query) query = '';
      else if (selected.size) selected = new Set();
      else expanded = null;
      searchEl?.blur();
    }
  }

  $effect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty('--accent', settings.accent);
  });

  onMount(() => {
    const fromHash = location.hash.slice(1) as Filter;
    if (filters.some((f) => f.value === fromHash)) filter = fromHash;
    void getSettings().then((s) => (settings = s));
    void reload();
    const a = watchSettings((s) => (settings = s));
    const b = watchWords(() => void reload());
    return () => {
      a();
      b();
    };
  });

  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'new', label: 'New' },
    { value: 'learning', label: 'Learning' },
    { value: 'known', label: 'Known' },
    { value: 'suggested', label: 'Suggested' },
  ];
</script>

<svelte:window onkeydown={onKey} />

<div class="page">
  <header class="top">
    <div class="brand">
      <Logo size={36} />
      <div>
        <h1>My words</h1>
        <div class="brand-sub">
          {`${counts.all} saved${addedThisWeek ? ` · +${addedThisWeek} this week` : ''}`}
        </div>
      </div>
    </div>
    <div class="top-actions">
      <button class="btn" onclick={() => exportCsv(saved)} disabled={!saved.length}>Export CSV</button>
      <button class="btn" onclick={() => browser.runtime.openOptionsPage()}>Settings</button>
    </div>
  </header>

  {#if counts.all}
    <div class="progress" aria-label="Progress">
      <div class="bar" role="img" aria-label="{counts.new} new, {counts.learning} learning, {counts.known} known">
        {#each STATUSES as s (s)}
          {#if counts[s]}<span data-status={s} style:flex-grow={counts[s]}></span>{/if}
        {/each}
      </div>
      <div class="legend">
        {#each STATUSES as s (s)}
          <span><i data-status={s}></i>{counts[s]} {STATUS_LABEL[s].toLowerCase()}</span>
        {/each}
      </div>
    </div>
  {/if}

  <div class="toolbar">
    <label class="search">
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.5 13.5 3.5 3.5" /></svg>
      <input bind:this={searchEl} bind:value={query} placeholder="Search words or translations" aria-label="Search words" />
      {#if !query}<kbd>/</kbd>{/if}
    </label>
    {#if langs.length > 1}
      <div class="segmented langs" role="group" aria-label="Language">
        <button aria-pressed={lang === 'all'} onclick={() => (lang = 'all')}>All</button>
        {#each langs as l (l)}
          <button aria-pressed={lang === l} title={LANGUAGES[l].name} onclick={() => (lang = l)}>{LANGUAGES[l].badge}</button>
        {/each}
      </div>
    {/if}
    <div class="segmented filters" role="group" aria-label="Filter">
      {#each filters as f (f.value)}
        <button aria-pressed={filter === f.value} onclick={() => (filter = f.value)}>
          {f.label}
          <span class="n" class:hot={f.value === 'suggested' && counts.suggested > 0}>{counts[f.value]}</span>
        </button>
      {/each}
    </div>
  </div>

  {#if filter === 'suggested' && counts.suggested}
    <p class="note muted">Words you’ve looked up {SUGGEST_AFTER}+ times but haven’t saved. Save the ones worth learning.</p>
  {/if}

  {#if !loaded}
    <div class="empty muted">Loading…</div>
  {:else if !words.length || (!counts.all && filter !== 'suggested')}
    <div class="empty card">
      <div class="empty-title">No saved words yet</div>
      <p class="muted">
        Tap the bookmark in any translation to save a word. It shows up here with the sentence where you found it.
      </p>
      {#if counts.suggested}
        <button class="btn btn-accent" onclick={() => (filter = 'suggested')}>See {counts.suggested} suggested words</button>
      {/if}
    </div>
  {:else if !filtered.length}
    <div class="empty muted">
      {#if query}No words match “{query}”.{:else}Nothing here yet.{/if}
    </div>
  {:else}
    <div class="list card">
      <div class="list-head">
        <input
          type="checkbox"
          aria-label="Select all shown"
          checked={selected.size > 0 && selected.size === visible.length}
          indeterminate={selected.size > 0 && selected.size < visible.length}
          onchange={selectAllVisible}
        />
        <span class="muted">{filtered.length} word{filtered.length === 1 ? '' : 's'}</span>
        <label class="sort">
          <span class="muted">Sort</span>
          <select bind:value={sort} aria-label="Sort">
            <option value="recent">Recent</option>
            <option value="az">A–Z</option>
            <option value="seen">Most looked up</option>
          </select>
        </label>
      </div>

      {#each groups as g (g.label)}
        {#if g.label}<div class="group">{g.label}</div>{/if}
        {#each g.items as w (w.id)}
          {@const open = expanded === w.id}
          {@const ctx = w.contexts[0]}
          <div class="item" class:open class:selected={selected.has(w.id)}>
            <div class="item-main">
              <input type="checkbox" aria-label="Select {w.lemma}" checked={selected.has(w.id)} onchange={() => toggleSelect(w.id)} />
              <button class="item-btn" aria-expanded={open} onclick={() => (expanded = open ? null : w.id)}>
                <span class="word">
                  <span class="w" lang={w.lang}>{w.lemma}</span>
                  {#if langs.length > 1 && lang === 'all'}<span class="lang-tag" title={LANGUAGES[w.lang].name}>{LANGUAGES[w.lang].badge}</span>{/if}
                  {#if w.gender}<span class="gender" data-g={w.gender}>{w.gender === 'mf' ? 'm/f' : w.gender}</span>{/if}
                </span>
                <span class="t">{w.translation}</span>
                <span class="slot">
                  {#if w.saved}<span class="status" data-status={w.status}>{STATUS_LABEL[w.status]}</span>{/if}
                </span>
                <span class="seen" title="Times looked up">{w.lookups}×</span>
                <span class="src">{ctx ? host(ctx.url) : ''}</span>
                <svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5 5 5-5 5" /></svg>
              </button>
              {#if !w.saved}
                <button class="btn btn-accent save-btn" onclick={() => saveSuggested(w)}>Save</button>
              {/if}
            </div>

            {#if open}
              <div class="detail">
                <div class="detail-meta muted">
                  {[w.pos && posLabel(w.pos), `looked up ${w.lookups}×`, `first seen ${shortDate(w.firstSeen)}`].filter(Boolean).join(' · ')}
                  <button class="link" onclick={() => speak(w.lemma, w.lang, settings.speechRate)}>Listen</button>
                </div>
                {#if w.contexts.length}
                  <ul class="contexts">
                    {#each w.contexts as c (c.at)}
                      <li>
                        <p lang={w.lang}>
                          “{#each mark(c.sentence, c.form) as part, i (i)}{#if part.hit}<mark>{part.t}</mark>{:else}{part.t}{/if}{/each}”
                        </p>
                        <span class="muted small">
                          {#if c.url}<a href={c.url} target="_blank" rel="noreferrer" title={c.title}>{host(c.url)} ↗</a> ·{/if}
                          {shortDate(c.at)}
                        </span>
                      </li>
                    {/each}
                  </ul>
                {/if}
                <div class="detail-actions">
                  {#if w.saved}
                    <div class="segmented" role="group" aria-label="Status">
                      {#each STATUSES as s (s)}
                        <button aria-pressed={w.status === s} onclick={() => setStatus([w.id], s)}>{STATUS_LABEL[s]}</button>
                      {/each}
                    </div>
                    <button class="btn" onclick={() => unsaveWords([w.id])}>Remove from My words</button>
                  {:else}
                    <button class="btn btn-accent" onclick={() => saveSuggested(w)}>Save to My words</button>
                    <button class="btn" onclick={() => forget(w)}>Forget</button>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      {/each}

      {#if filtered.length > limit}
        <button class="more" onclick={() => (limit += PAGE)}>Show more · {filtered.length - limit} left</button>
      {/if}
    </div>
  {/if}
</div>

{#if selected.size}
  <div class="bulk card" role="toolbar" aria-label="Selected words">
    <span class="bulk-count">{selected.size} selected</span>
    <span class="muted bulk-label">Mark as</span>
    <div class="segmented bulk-status" role="group" aria-label="Mark selected as">
      {#each STATUSES as s (s)}
        <button onclick={() => bulkStatus(s)}>{STATUS_LABEL[s]}</button>
      {/each}
    </div>
    <span class="sep" aria-hidden="true"></span>
    <button class="btn" onclick={() => exportCsv(words.filter((w) => selected.has(w.id)))}>Export</button>
    <button class="btn danger" onclick={bulkRemove}>Remove</button>
    <button class="icon-btn" aria-label="Clear selection" onclick={() => (selected = new Set())}>×</button>
  </div>
{/if}

<style>
  .page {
    max-width: 920px;
    margin: 0 auto;
    padding: 32px 24px 120px;
    display: grid;
    gap: 16px;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font: 650 24px/1.1 var(--serif);
    letter-spacing: -0.015em;
  }
  .top-actions {
    display: flex;
    gap: 8px;
  }

  /* Progress */
  .progress {
    display: grid;
    gap: 7px;
  }
  .bar {
    display: flex;
    gap: 3px;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
  }
  .bar span {
    flex-basis: 0;
    min-width: 6px;
    border-radius: 4px;
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
  .bar span {
    background: var(--c);
  }
  .legend {
    display: flex;
    gap: 16px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .legend i {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--c);
  }

  /* Toolbar */
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    padding: 10px 0;
    background: var(--bg);
  }
  .search {
    position: relative;
    flex: 1 1 160px;
    display: flex;
    align-items: center;
  }
  .search svg {
    position: absolute;
    left: 11px;
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--faint);
    stroke-width: 1.8;
    stroke-linecap: round;
  }
  .search input {
    width: 100%;
    height: 36px;
    padding: 0 34px 0 34px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface);
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .search input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .search kbd {
    position: absolute;
    right: 10px;
    font: 600 11px/1 var(--sans);
    padding: 3px 6px;
    border-radius: 5px;
    border: 1px solid var(--border);
    color: var(--faint);
  }
  .filters,
  .langs {
    flex: 0 1 auto;
  }
  .lang-tag {
    flex-shrink: 0;
    padding: 1px 4px;
    border-radius: 4px;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--muted);
    background: var(--hover);
  }
  .filters .n {
    margin-left: 4px;
    font-size: 11px;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
  .filters .n.hot {
    color: var(--accent-ink);
  }
  .sort {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sort select {
    border: 0;
    background: transparent;
    font-weight: 600;
    font-size: 12.5px;
    color: var(--text);
    cursor: pointer;
  }
  .note {
    margin: -6px 0 0;
    font-size: 12.5px;
  }

  /* List */
  .list {
    overflow: hidden;
  }
  .list-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 16px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
  }
  .group {
    padding: 14px 16px 6px;
    font: 650 10.5px/1.3 var(--sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .item {
    border-top: 1px solid var(--border);
  }
  .group + .item {
    border-top: 0;
  }
  .item.selected {
    background: var(--accent-soft);
  }
  .item-main {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px 0 16px;
  }
  input[type='checkbox'] {
    width: 15px;
    height: 15px;
    margin: 0;
    flex-shrink: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .item-btn {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(120px, 230px) minmax(0, 1fr) 82px 38px 150px 16px;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .item-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: 6px;
  }
  .w {
    font: 600 17px/1.2 var(--serif);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .slot {
    display: flex;
    min-width: 0;
  }
  .word {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .t {
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
  .status {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 650;
    color: var(--muted);
    background: var(--hover);
  }
  .status[data-status='learning'] {
    color: var(--accent-ink);
    background: var(--accent-soft);
  }
  .status[data-status='known'] {
    color: var(--ok);
    background: color-mix(in srgb, var(--ok) 13%, transparent);
  }
  .seen {
    font-size: 12px;
    color: var(--faint);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .src {
    font-size: 12px;
    color: var(--faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--faint);
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 0.18s;
  }
  .item.open .chev {
    transform: rotate(90deg);
  }
  .save-btn {
    height: 28px;
    flex-shrink: 0;
  }

  /* Expanded */
  .detail {
    padding: 12px 16px 16px 43px;
    border-top: 1px dashed var(--border);
    display: grid;
    gap: 10px;
    animation: fade 0.18s ease;
  }
  .detail-meta {
    font-size: 12px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    margin-left: 6px;
    color: var(--accent-ink);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .contexts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .contexts li {
    padding: 9px 12px;
    border-radius: 10px;
    background: var(--hover);
  }
  .contexts p {
    margin: 0 0 3px;
    font-style: italic;
  }
  .contexts mark {
    font-style: normal;
    font-weight: 650;
    color: inherit;
    background: var(--accent-soft);
    border-radius: 3px;
    padding: 0 2px;
  }
  .small {
    font-size: 12px;
  }
  .contexts a {
    color: var(--muted);
    text-decoration: none;
  }
  .contexts a:hover {
    color: var(--accent-ink);
  }
  .detail-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .detail-actions .segmented {
    min-width: 260px;
  }
  .more {
    display: block;
    width: 100%;
    padding: 12px;
    border: 0;
    border-top: 1px solid var(--border);
    background: none;
    color: var(--accent-ink);
    font-weight: 600;
    cursor: pointer;
  }
  .more:hover {
    background: var(--hover);
  }

  .empty {
    padding: 40px 24px;
    text-align: center;
  }
  .empty.card {
    display: grid;
    justify-items: center;
    gap: 6px;
  }
  .empty-title {
    font: 650 18px/1.2 var(--serif);
  }
  .empty p {
    max-width: 380px;
    margin: 0 0 8px;
  }

  /* Bulk bar */
  .bulk {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 8px 8px 16px;
    border-radius: 14px;
    box-shadow: 0 12px 32px -8px rgba(16, 12, 32, 0.3);
    animation: rise 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.2);
    width: max-content;
    max-width: calc(100vw - 32px);
    flex-wrap: wrap;
  }
  .bulk-count {
    font-weight: 650;
    margin-right: 8px;
    white-space: nowrap;
  }
  .bulk-label {
    font-size: 12.5px;
  }
  .bulk-status button {
    padding: 5px 10px;
  }
  .sep {
    width: 1px;
    height: 22px;
    margin: 0 4px;
    background: var(--border);
  }
  .danger {
    color: var(--error);
  }
  .icon-btn {
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 9px;
    background: none;
    font-size: 18px;
    color: var(--muted);
    cursor: pointer;
  }
  .icon-btn:hover {
    background: var(--hover);
  }

  @keyframes fade {
    from { opacity: 0; transform: translateY(-2px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes rise {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  @media (max-width: 720px) {
    .item-btn {
      grid-template-columns: minmax(90px, 170px) minmax(0, 1fr) 76px 16px;
    }
    .seen,
    .src {
      display: none;
    }
    .detail {
      padding-left: 16px;
    }
  }
</style>
