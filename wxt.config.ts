import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  // Load .output/chrome-mv3 (or -dev) as an unpacked extension instead of auto-launching a browser.
  webExt: { disabled: true },
  manifest: {
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
  },
});
