<script lang="ts">
  import { containsTerm, termRegex } from '@/lib/disambiguate';
  import { SAVE_MAX_CHARS, SUGGEST_AFTER } from '@/lib/suggest';
  import { markWord as mark } from '@/lib/text';
  import { isReflexive, posLabel, REFL_PREFIX } from '@/lib/present';
  import { actions, ui } from './state.svelte';

  /** Split an English translation so the matched sense ("account") can be emphasised. */
  function markTerm(text: string, term: string | null): { t: string; hit: boolean }[] {
    if (!term) return [{ t: text, hit: false }];
    const re = termRegex(term, 'giu');
    const parts: { t: string; hit: boolean }[] = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) parts.push({ t: text.slice(last, m.index), hit: false });
      parts.push({ t: m[0], hit: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ t: text.slice(last), hit: false });
    return parts;
  }

  const STATUS_LABEL = { new: 'New', learning: 'Learning', known: 'Known' } as const;

  const genderName = { m: 'masculine', f: 'feminine', mf: 'masculine or feminine' } as const;
  const genderShort = { m: 'm', f: 'f', mf: 'm/f' } as const;

  let first = $derived(ui.data?.groups[0]);
  let headword = $derived(ui.data && first?.pos !== 'name' ? ui.word.toLowerCase() : ui.word);
  // Lone labels ("Cuenta") say nothing on their own, so show where else the page uses the word.
  let shortSentence = $derived(ui.sentence.split(/\s+/).length < 3);
  let showSnippet = $derived(!!ui.snippet && (shortSentence || !ui.sentenceMT));
  let showSentence = $derived(!showSnippet && !!ui.sentenceMT && ui.sentence.trim() !== ui.word.trim());
  let canSave = $derived(
    ui.isPhrase ? ui.word.length <= SAVE_MAX_CHARS && !!(ui.wordMT || ui.breakdown?.length || ui.ai.data) : !!(ui.data || ui.wordMT),
  );
  let senseCount = $derived(ui.data?.groups.reduce((n, g) => n + g.senses.length, 0) ?? 0);
</script>

<div class="tt-root" data-theme={ui.theme} style:--tt-accent={ui.accent}>
  <div
    class="tt-card"
    data-open={ui.open}
    data-pinned={ui.pinned}
    role="dialog"
    aria-label="Translation of {ui.word}"
    aria-hidden={!ui.open}
  >
    <header class="tt-head">
      <div class="tt-title">
        {#if ui.backTo}
          <button class="tt-back" title="Back to “{ui.backTo}”" aria-label="Back to the phrase" onclick={actions.back}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6" /></svg>
          </button>
        {/if}
        <span class="tt-word" class:tt-word-phrase={ui.isPhrase} class:tt-word-long={ui.word.length > 140} lang={ui.lang}>{headword}</span>
        {#if first?.gender && !first.lemma}
          <span class="tt-gender" data-g={first.gender} title={genderName[first.gender]}>{genderShort[first.gender]}</span>
        {/if}
      </div>
      <div class="tt-actions">
        <button class="tt-icon" title="Listen" aria-label="Listen" onclick={actions.speak}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" /><path class="tt-stroke" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></svg>
        </button>
        {#if canSave}
          <button
            class="tt-icon tt-save"
            data-saved={ui.saved}
            title={ui.saved ? 'Saved to your words' : 'Save word'}
            aria-label={ui.saved ? 'Remove from saved words' : 'Save word'}
            aria-pressed={ui.saved}
            onclick={actions.toggleSave}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h10a1 1 0 0 1 1 1v14l-6-3.6-6 3.6v-14a1 1 0 0 1 1-1Z" /></svg>
          </button>
        {/if}
      </div>
    </header>

    {#if ui.data?.ipa || ui.clitics.length || ui.saved || ui.lookups > 1}
      <div class="tt-meta">
        {#if ui.data?.ipa}<span class="tt-ipa">{ui.data.ipa}</span>{/if}
        {#if ui.clitics.length}
          <span class="tt-clitics" title="Attached pronouns">+ {ui.clitics.join(' + ')}</span>
        {/if}
        {#if ui.saved}
          <button class="tt-status" data-status={ui.status} title="Change status" onclick={actions.cycleStatus}>
            {STATUS_LABEL[ui.status]}
          </button>
        {/if}
        {#if ui.lookups > 1}<span class="tt-seen" title="Times you looked this up">seen {ui.lookups}×</span>{/if}
      </div>
    {/if}

    {#if ui.phase === 'loading'}
      <div class="tt-skeleton" aria-label="Loading">
        <span style:width="38%"></span><span style:width="82%"></span><span style:width="64%"></span>
      </div>
    {:else if ui.phase === 'error'}
      <p class="tt-error">{ui.error}</p>
    {:else if ui.data}
      <div class="tt-groups">
        {#each ui.data.groups as g, gi (gi)}
          <section class="tt-group">
            <div class="tt-pos">
              <span>{posLabel(g.pos)}</span>
              {#if g.lemma}
                <span class="tt-lemma">
                  of <strong lang={ui.lang}>{g.lemma}</strong>
                  {#if g.gender}<span class="tt-gender tt-gender-sm" data-g={g.gender}>{genderShort[g.gender]}</span>{/if}
                </span>
              {/if}
            </div>
            {#if g.inflections.length}
              <p class="tt-inflection">{g.inflections.slice(0, 2).join(' · ')}{g.inflections.length > 2 ? ` · +${g.inflections.length - 2}` : ''}</p>
            {/if}
            {#if g.senses.length}
              <ol class="tt-senses" class:tt-senses-main={gi === 0}>
                {#each g.senses.slice(0, gi === 0 ? 4 : 2) as s, si (si)}
                  <li class:tt-contextual={g.contextual && si === 0}>
                    {#if isReflexive(s)}<span class="tt-refl" title="Reflexive use (with se)">reflexive</span>{s.slice(REFL_PREFIX.length)}{:else}{s}{/if}
                    {#if g.contextual && si === 0}<span class="tt-ctx" title="Picked from the text around this word">in context</span>{/if}
                  </li>
                {/each}
              </ol>
            {/if}
            {#if gi === 0 && g.example && (!g.contextual || !ui.contextTerm || containsTerm(g.example[1], ui.contextTerm))}
              <blockquote class="tt-example">
                <p lang={ui.lang}>
                  {#each mark(g.example[0], ui.word) as part, i (i)}{#if part.hit}<mark>{part.t}</mark>{:else}{part.t}{/if}{/each}
                </p>
                <p class="tt-example-en">{g.example[1]}</p>
              </blockquote>
            {/if}
          </section>
        {/each}
      </div>
    {:else if ui.isPhrase}
      {#if ui.wordMT}
        <div class="tt-mt">
          <span class="tt-label">Translation</span>
          <p class="tt-mt-text" class:tt-mt-long={ui.wordMT.length > 120}>{ui.wordMT}</p>
        </div>
      {:else if ui.ai.status === 'ready' && ui.ai.data}
        <div class="tt-mt">
          <span class="tt-label">Translation</span>
          <p class="tt-mt-text" class:tt-mt-long={ui.ai.data.sentenceTranslation.length > 120}>
            {ui.ai.data.sentenceTranslation || ui.ai.data.meaning}
          </p>
        </div>
      {/if}
      {#if ui.breakdown?.length}
        <div class="tt-breakdown">
          <span class="tt-label">Word by word</span>
          <div class="tt-chips">
            {#each ui.breakdown as b (b.word)}
              <button class="tt-chip" title="Open “{b.word}”" onclick={() => actions.openWord(b.word)}>
                <span class="tt-chip-es" lang={ui.lang}>{b.word.toLowerCase()}</span>
                <span class="tt-chip-en">{b.gloss}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
      {#if !ui.wordMT && !ui.aiEnabled && ui.mtStatus === 'downloadable'}
        <p class="tt-hint">Turn on offline translation from the toolbar icon to translate whole phrases.</p>
      {:else if !ui.wordMT && !ui.aiEnabled && !ui.breakdown?.length}
        <p class="tt-empty">
          Can’t translate this phrase here.
          {ui.mtStatus === 'unsupported' ? 'Add an AI key in Settings to translate phrases.' : 'Add an AI key in Settings, or turn on offline translation from the toolbar icon.'}
        </p>
      {/if}
    {:else if ui.wordMT}
      <div class="tt-mt">
        <span class="tt-label">Machine translation</span>
        <p class="tt-mt-text">{ui.wordMT}</p>
      </div>
    {:else}
      <p class="tt-empty">
        No dictionary entry for <strong lang={ui.lang}>{ui.word}</strong>.
        {#if ui.mtStatus === 'downloadable'}
          Turn on offline translation from the toolbar icon to translate anything.
        {/if}
      </p>
    {/if}

    {#if ui.phase === 'ready' && !ui.saved && !ui.isPhrase && ui.lookups >= SUGGEST_AFTER}
      <div class="tt-suggest">
        <span>You’ve looked this up <strong>{ui.lookups} times</strong>.</span>
        <button class="tt-suggest-btn" onclick={actions.toggleSave}>Save it</button>
      </div>
    {/if}

    {#if ui.phase === 'ready' && showSnippet && ui.snippet}
      <section class="tt-context">
        <span class="tt-label">On this page</span>
        <p class="tt-sentence tt-sentence-es" lang={ui.lang}>
          {#each mark(ui.snippet.text, ui.word) as part, i (i)}{#if part.hit}<mark>{part.t}</mark>{:else}{part.t}{/if}{/each}
        </p>
        <p class="tt-sentence">
          {#each markTerm(ui.snippet.en, ui.contextTerm) as part, i (i)}{#if part.hit}<mark>{part.t}</mark>{:else}{part.t}{/if}{/each}
        </p>
      </section>
    {:else if ui.phase === 'ready' && showSentence && ui.sentenceMT}
      <section class="tt-context">
        <span class="tt-label">In this sentence</span>
        <p class="tt-sentence">
          {#each markTerm(ui.sentenceMT, ui.contextTerm) as part, i (i)}{#if part.hit}<mark>{part.t}</mark>{:else}{part.t}{/if}{/each}
        </p>
      </section>
    {:else if ui.phase === 'ready' && ui.data && senseCount > 1 && ui.mtStatus === 'downloadable'}
      <p class="tt-hint">Turn on offline translation from the toolbar icon to pick the meaning that fits this page.</p>
    {/if}

    {#if ui.phase === 'ready' && ui.aiEnabled}
      <section class="tt-ai" data-status={ui.ai.status}>
        {#if ui.ai.status === 'idle'}
          <button class="tt-ai-btn" onclick={() => actions.explain()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" /><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /></svg>
            Explain in context
          </button>
        {:else if ui.ai.status === 'loading'}
          <div class="tt-skeleton tt-skeleton-ai"><span style:width="30%"></span><span style:width="90%"></span></div>
        {:else if ui.ai.status === 'ready' && ui.ai.data}
          <div class="tt-ai-answer">
            {#if !ui.isPhrase || ui.wordMT}<span class="tt-pill">{ui.ai.data.meaning}</span>{/if}
            <p>{ui.ai.data.explanation}</p>
          </div>
        {:else if ui.ai.status === 'error'}
          <p class="tt-error">
            {ui.ai.error}
            <button class="tt-link" onclick={actions.openSettings}>Settings</button>
          </p>
        {/if}
      </section>
    {/if}
  </div>

  {#if ui.pill}
    <button
      class="tt-translate-btn"
      style:left="{ui.pill.x}px"
      style:top="{ui.pill.y}px"
      onmousedown={(e) => e.preventDefault()}
      onclick={actions.translateSelection}
    >
      <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M18.2 4.8 8.6 18h6.2l-2.1 9.2L23.4 13.4h-6.3l1.1-8.6Z" /></svg>
      Translate
    </button>
  {/if}
</div>
