import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  // Manifest V3 for Firefox too, so both browsers share the same APIs (action, background scripts).
  manifestVersion: 3,
  // Load .output/<browser>-mv3 (or -dev) as an unpacked extension instead of auto-launching a browser.
  webExt: { disabled: true },
  manifest: ({ browser }) => ({
    name: 'TurboTranslate',
    description: 'Hover or click any Spanish or Portuguese word for an instant, beautiful translation.',
    permissions: ['storage', 'activeTab'],
    host_permissions: [
      'https://api.anthropic.com/*',
      'https://api.openai.com/*',
      'https://generativelanguage.googleapis.com/*',
    ],
    web_accessible_resources: [{ resources: ['fonts/*.woff2'], matches: ['<all_urls>'] }],
    commands: {
      'toggle-enabled': {
        suggested_key: { default: 'Alt+Shift+T' },
        description: 'Turn TurboTranslate on or off',
      },
    },
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          // Fixed, so settings sync and updates follow the add-on across installs.
          id: '{fd050b95-fc42-4f2e-82eb-2e5492ace7bc}',
          // CSS Custom Highlight API (the active-word highlight) arrived in Firefox 140.
          strict_min_version: '140.0',
          // Nothing is sent to the developer. AI explanations go only to the provider whose key you add.
          data_collection_permissions: { required: ['none'] },
        },
      },
    }),
  }),
});
