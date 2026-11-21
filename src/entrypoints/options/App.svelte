<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import Logo from '@/assets/Logo.svelte';
  import Popover from '@/entrypoints/content/Popover.svelte';
  import { ui } from '@/entrypoints/content/state.svelte';
  import { send } from '@/lib/messaging';
  import { present } from '@/lib/present';
  import {
    ACCENTS,
    DEFAULT_MODELS,
    DEFAULT_SETTINGS,
    getApiKeys,
    getSettings,
    setApiKey,
    updateSettings,
    watchSettings,
  } from '@/lib/settings';
  import { LANGS, LANGUAGES, type Lang } from '@/lib/languages';
  import { speak } from '@/lib/speech';
  import type { AiProvider, ApiKeys, Explanation, SelectionMode, Settings, Theme, TriggerMode } from '@/lib/types';

  let settings = $state<Settings>(DEFAULT_SETTINGS);
  let keys = $state<ApiKeys>({});
  let keyDraft = $state('');
  let test = $state<{ status: 'idle' | 'loading' | 'ok' | 'error'; result?: Explanation; error?: string }>({ status: 'idle' });

  const themes: { value: Theme; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
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
  const providers: { value: AiProvider; label: string; keyUrl?: string; keyHint?: string }[] = [
    { value: 'none', label: 'Off' },
    { value: 'anthropic', label: 'Claude', keyUrl: 'https://platform.claude.com/settings/keys', keyHint: 'sk-ant-…' },
    { value: 'openai', label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…' },
    { value: 'gemini', label: 'Gemini', keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…' },
  ];

  let provider = $derived(providers.find((p) => p.value === settings.ai.provider)!);
  let activeKey = $derived(settings.ai.provider === 'none' ? '' : (keys[settings.ai.provider] ?? ''));

  // ---------- Live preview, rendered with the real popover component ----------
  const sample = present('banco', {
    query: 'banco',
    matched: 'banco',
    clitics: [],
    entries: [
      {
        pos: 'noun',
        gender: 'm',
        ipa: '/ˈbanko/',
        senses: ['bank (financial institution)', 'bench', 'pew', 'school of fish'],
        example: ['Nos sentamos en un banco del parque.', 'We sat on a park bench.'],
        forms: [],
      },
    ],
    lemmas: [],
  });

  $effect(() => {
    Object.assign(ui, {
      open: true,
      theme: settings.theme,
      accent: settings.accent,
      word: 'banco',
      sentence: 'Fui al banco a sacar dinero.',
      phase: 'ready',
      data: sample && { ...sample, groups: sample.groups.map((g, i) => ({ ...g, contextual: i === 0 })) },
      contextTerm: 'bank',
      sentenceMT: 'I went to the bank to withdraw money.',
      saved: true,
      status: 'learning',
      lookups: 4,
      aiEnabled: settings.ai.provider !== 'none',
      ai: {
        status: 'ready',
        data: {
          meaning: 'bank',
          lemma: 'banco',
          partOfSpeech: 'noun',
          explanation: 'Here it’s the financial bank, not a bench: you go there “a sacar dinero” (to take out money).',
          sentenceTranslation: '',
        },
        error: '',
      },
    });
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty('--accent', settings.accent);
  });

  onMount(() => {
    void getSettings().then((s) => (settings = s));
    void getApiKeys().then((k) => (keys = k));
    const a = watchSettings((s) => (settings = s));
    return a;
  });

  async function patch(p: Partial<Settings>) {
    settings = await updateSettings(p);
  }

  /** At least one language stays on; the first one is the fallback where a page's language can't tell. */
  function toggleLanguage(lang: Lang) {
    const on = settings.languages.includes(lang);
    if (on && settings.languages.length === 1) return;
    void patch({ languages: on ? settings.languages.filter((l) => l !== lang) : [...settings.languages, lang] });
  }

  let languageList = $derived(settings.languages.map((l) => LANGUAGES[l].name).join(' or '));

  function chooseProvider(value: AiProvider) {
    test = { status: 'idle' };
    keyDraft = '';
    void patch({ ai: { ...settings.ai, provider: value, model: '' } });
  }

  async function saveKey() {
    if (settings.ai.provider === 'none') return;
    await setApiKey(settings.ai.provider, keyDraft.trim());
    keys = await getApiKeys();
    keyDraft = '';
    test = { status: 'idle' };
  }

  async function forgetKey() {
    if (settings.ai.provider === 'none') return;
    await setApiKey(settings.ai.provider, '');
    keys = await getApiKeys();
  }

  async function runTest() {
    test = { status: 'loading' };
    try {
      test = { status: 'ok', result: await send('testAi', {}) };
    } catch (e) {
      test = { status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  }


  const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : '••••');
</script>

<div class="page">
  <header class="top">
    <div class="brand">
      <Logo size={36} />
      <div>
        <div class="brand-name big">TurboTranslate</div>
        <div class="brand-sub">Settings</div>
      </div>
    </div>
    <a class="btn" href={browser.runtime.getURL('/words.html' as '/')}>My words →</a>
  </header>

  <div class="layout">
    <div class="col">
      <!-- Languages -->
      <section class="card section">
        <h2>Languages</h2>
        <p class="muted small lead">The languages you’re learning. Everything is translated into English.</p>
        <div class="langs" role="group" aria-label="Languages you're learning">
          {#each LANGS as l (l)}
            {@const on = settings.languages.includes(l)}
            <button
              class="lang"
              aria-pressed={on}
              disabled={on && settings.languages.length === 1}
              title={on && settings.languages.length === 1 ? 'Keep at least one language' : ''}
              onclick={() => toggleLanguage(l)}
            >
              <span class="lang-badge">{LANGUAGES[l].badge}</span>
              <span class="lang-name">{LANGUAGES[l].name}</span>
              <svg class="lang-check" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5l3.2 3L15 6.5" /></svg>
            </button>
          {/each}
        </div>
        <div class="row">
          <div>
            <div class="field-label">Only on {languageList} websites</div>
            <div class="muted small">
              Sleeps on pages written in other languages. To use it on a particular site anyway, turn it on from the toolbar icon there.
            </div>
          </div>
          <button
            class="switch"
            role="switch"
            aria-checked={settings.matchLanguage}
            aria-label="Only on {languageList} websites"
            onclick={() => patch({ matchLanguage: !settings.matchLanguage })}
          ></button>
        </div>
      </section>

      <!-- Appearance -->
      <section class="card section">
        <h2>Appearance</h2>
        <div class="field">
          <span class="field-label">Theme</span>
          <div class="segmented" role="group" aria-label="Theme">
            {#each themes as t (t.value)}
              <button aria-pressed={settings.theme === t.value} onclick={() => patch({ theme: t.value })}>{t.label}</button>
            {/each}
          </div>
        </div>
        <div class="field">
          <span class="field-label">Accent</span>
          <div class="swatches" role="radiogroup" aria-label="Accent color">
            {#each ACCENTS as c (c)}
              <button
                class="swatch"
                role="radio"
                aria-checked={settings.accent === c}
                aria-label={c}
                style:--c={c}
                onclick={() => patch({ accent: c })}
              ></button>
            {/each}
          </div>
        </div>
      </section>

      <!-- Behavior -->
      <section class="card section">
        <h2>Behavior</h2>
        <div class="field">
          <span class="field-label">Show translation on</span>
          <div class="segmented" role="group" aria-label="Trigger">
            {#each triggers as t (t.value)}
              <button aria-pressed={settings.trigger === t.value} onclick={() => patch({ trigger: t.value })}>{t.label}</button>
            {/each}
          </div>
        </div>
        <div class="field">
          <span class="field-label">When you select text</span>
          <div class="segmented" role="group" aria-label="Selected text">
            {#each selections as s (s.value)}
              <button aria-pressed={settings.selection === s.value} onclick={() => patch({ selection: s.value })}>{s.label}</button>
            {/each}
          </div>
          <span class="muted small">
            {#if settings.selection === 'instant'}Selecting a word, phrase or sentence translates it right away.
            {:else if settings.selection === 'button'}A small Translate button appears next to your selection.
            {:else}Selections are ignored. Double-click or Alt+select still translate.{/if}
          </span>
        </div>
        {#if settings.trigger !== 'click'}
          <label class="field">
            <span class="row"><span class="field-label">Hover delay</span><span class="muted">{settings.hoverDelay} ms</span></span>
            <input
              type="range"
              min="120"
              max="900"
              step="20"
              value={settings.hoverDelay}
              onchange={(e) => patch({ hoverDelay: +e.currentTarget.value })}
            />
          </label>
        {/if}
        <label class="field">
          <span class="row">
            <span class="field-label">Pronunciation speed</span>
            <button type="button" class="btn small-btn" onclick={() => {
                const lang = settings.languages[0] ?? 'es';
                speak(LANGUAGES[lang].sample, lang, settings.speechRate);
              }}>
              Listen
            </button>
          </span>
          <input
            type="range"
            min="0.5"
            max="1.3"
            step="0.05"
            value={settings.speechRate}
            onchange={(e) => patch({ speechRate: +e.currentTarget.value })}
          />
        </label>
        {#if settings.enabledSites.length}
          <div class="field">
            <span class="field-label">Always on</span>
            <div class="chips">
              {#each settings.enabledSites as site (site)}
                <button
                  class="chip"
                  title="Back to automatic ({languageList} pages only)"
                  onclick={() => patch({ enabledSites: settings.enabledSites.filter((s) => s !== site) })}
                >
                  {site} <span aria-hidden="true">×</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
        {#if settings.disabledSites.length}
          <div class="field">
            <span class="field-label">Turned off on</span>
            <div class="chips">
              {#each settings.disabledSites as site (site)}
                <button
                  class="chip"
                  title="Back to automatic"
                  onclick={() => patch({ disabledSites: settings.disabledSites.filter((s) => s !== site) })}
                >
                  {site} <span aria-hidden="true">×</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </section>

      <!-- AI -->
      <section class="card section">
        <h2>Explain in context <span class="tag">optional</span></h2>
        <p class="muted small lead">
          Adds an “Explain in context” button that asks an AI model what the word means in that exact sentence. It uses your own
          API key, and requests go straight from your browser to the provider. A lookup costs about $0.0001 on Claude Haiku. Gemini has
          a free tier.
        </p>
        <div class="segmented" role="group" aria-label="AI provider">
          {#each providers as p (p.value)}
            <button aria-pressed={settings.ai.provider === p.value} onclick={() => chooseProvider(p.value)}>{p.label}</button>
          {/each}
        </div>

        {#if settings.ai.provider !== 'none'}
          <div class="field">
            <span class="row">
              <span class="field-label">API key</span>
              <a class="small" href={provider.keyUrl} target="_blank" rel="noreferrer">Get a key ↗</a>
            </span>
            {#if activeKey}
              <div class="row keyrow">
                <code>{mask(activeKey)}</code>
                <button class="btn" onclick={forgetKey}>Remove</button>
              </div>
            {:else}
              <form class="row keyrow" onsubmit={(e) => (e.preventDefault(), saveKey())}>
                <input class="input" type="password" autocomplete="off" placeholder={provider.keyHint} bind:value={keyDraft} />
                <button class="btn btn-accent" disabled={!keyDraft.trim()}>Save</button>
              </form>
            {/if}
            <span class="muted small">Stored only on this device, never synced.</span>
          </div>
          <label class="field">
            <span class="field-label">Model</span>
            <input
              class="input"
              placeholder={DEFAULT_MODELS[settings.ai.provider]}
              value={settings.ai.model}
              onchange={(e) => patch({ ai: { ...settings.ai, model: e.currentTarget.value.trim() } })}
            />
          </label>
          <div class="row">
            <div>
              <div class="field-label">Explain automatically</div>
              <div class="muted small">Ask on every lookup instead of waiting for a click. Uses more of your API quota.</div>
            </div>
            <button
              class="switch"
              role="switch"
              aria-checked={settings.ai.auto}
              aria-label="Explain automatically"
              onclick={() => patch({ ai: { ...settings.ai, auto: !settings.ai.auto } })}
            ></button>
          </div>
          <div class="row">
            <button class="btn" onclick={runTest} disabled={!activeKey || test.status === 'loading'}>
              {test.status === 'loading' ? 'Testing…' : 'Test with “Cuenta”'}
            </button>
            {#if test.status === 'ok' && test.result}
              <span class="test-ok">✓ “{test.result.meaning}”</span>
            {/if}
          </div>
          {#if test.status === 'error'}<p class="error small">{test.error}</p>{/if}
        {/if}
      </section>
    </div>

    <aside class="col preview-col">
      <div class="label">Preview</div>
      <div class="preview">
        <p class="preview-text" lang="es">Fui al <span class="preview-word">banco</span> a sacar dinero.</p>
        <Popover />
      </div>
    </aside>
  </div>

  <footer class="muted small foot">
    Toggle on/off anywhere with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> (change it at chrome://extensions/shortcuts). Dictionary data from
    <a href="https://en.wiktionary.org" target="_blank" rel="noreferrer">Wiktionary</a> (CC BY-SA) via kaikki.org.
  </footer>
</div>

<style>
  .page {
    max-width: 980px;
    margin: 0 auto;
    padding: 32px 24px 48px;
    display: grid;
    gap: 18px;
  }
  .big {
    font-size: 22px;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .top a.btn {
    text-decoration: none;
    color: var(--text);
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 18px;
    align-items: start;
  }
  .col {
    display: grid;
    gap: 18px;
  }
  .preview-col {
    position: sticky;
    top: 24px;
    gap: 8px;
  }
  @media (max-width: 820px) {
    .layout {
      grid-template-columns: 1fr;
    }
    .preview-col {
      position: static;
      order: -1;
    }
  }

  .section {
    padding: 18px 20px;
    display: grid;
    gap: 14px;
  }
  h2 {
    margin: 0;
    font: 650 17px/1.2 var(--serif);
    letter-spacing: -0.01em;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tag {
    font: 650 10.5px/1 var(--sans);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 3px 7px;
    border-radius: 999px;
    color: var(--accent-ink);
    background: var(--accent-soft);
  }
  .lead {
    margin: -6px 0 0;
  }
  .field {
    display: grid;
    gap: 7px;
  }
  .field-label {
    font-weight: 600;
  }
  .small {
    font-size: 12px;
  }
  .small-btn {
    height: 26px;
    padding: 0 9px;
    font-size: 12px;
  }

  .swatches {
    display: flex;
    gap: 10px;
  }
  .swatch {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 0;
    padding: 0;
    background: var(--c);
    cursor: pointer;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .swatch:hover {
    transform: scale(1.08);
  }
  .swatch[aria-checked='true'] {
    box-shadow:
      0 0 0 2px var(--surface),
      0 0 0 4px var(--c);
  }

  input[type='range'] {
    width: 100%;
    accent-color: var(--accent);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    border: 1px solid var(--border);
    background: var(--hover);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .chip:hover {
    border-color: var(--accent);
  }

  .langs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }
  .lang {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .lang:hover {
    border-color: var(--accent);
  }
  .lang[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .lang:disabled {
    cursor: default;
  }
  .lang-badge {
    display: grid;
    place-items: center;
    width: 28px;
    height: 22px;
    border-radius: 6px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--muted);
    background: var(--hover);
  }
  .lang[aria-pressed='true'] .lang-badge {
    color: #fff;
    background: var(--accent);
  }
  .lang-name {
    flex: 1;
    font-weight: 600;
  }
  .lang-check {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0;
  }
  .lang[aria-pressed='true'] .lang-check {
    opacity: 1;
  }

  .keyrow {
    gap: 8px;
  }
  .keyrow code {
    flex: 1;
    padding: 7px 10px;
    border-radius: 9px;
    background: var(--hover);
    font-size: 12.5px;
  }
  .test-ok {
    color: var(--ok);
    font-weight: 600;
  }
  .error {
    margin: 0;
    color: var(--error);
  }

  .preview {
    position: relative;
    padding: 22px 18px 24px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background:
      radial-gradient(circle at 1px 1px, var(--track) 1px, transparent 0) 0 0 / 14px 14px,
      var(--bg);
    overflow: hidden;
  }
  .preview-text {
    margin: 0 0 12px;
    font: 400 17px/1.5 Georgia, serif;
  }
  .preview-word {
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent) 24%, transparent);
  }
  .preview :global(.tt-card) {
    position: relative !important;
    left: auto !important;
    top: auto !important;
    max-width: 100%;
  }

  kbd {
    font: 600 10.5px/1 var(--sans);
    padding: 2px 5px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--hover);
  }
  .foot {
    text-align: center;
  }
</style>
