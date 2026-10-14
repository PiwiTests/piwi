import type { KnipConfig } from 'knip';

// The live AI suite's Playwright config (`app:test:ai:live`) throws without a
// provider key; knip only reads it for its entry files.
process.env.OPENCODE_API_KEY ||= 'knip';

const config: KnipConfig = {
  // Report exports nothing imports; an export used only inside its own module is not flagged.
  ignoreExportsUsedInFile: true,
  ignoreBinaries: ['tauri', 'playwright'],
  // Built on their own toolchains (Tauri, VitePress) or resolved from the npm registry.
  ignoreWorkspaces: ['apps/desktop', 'apps/docs', 'examples/sample-app'],
  workspaces: {
    '.': {
      entry: ['scripts/*.mjs', 'commitlint.config.js'],
    },
    'apps/application': {
      entry: [
        'app/service-worker/demo-sw.ts',
        'scripts/*.mjs',
        'tests/globalSetup.ts',
        'tests/globalTeardown.ts',
        'drizzle.config.pg.ts',
        // Dashboard widgets are imported from `#components` by `app/utils/analytics-widgets.ts`.
        'app/components/analytics/*.vue',
        // drizzle-kit reads every table the schema exports.
        'server/database/schema.*.ts',
      ],
      ignore: ['public/**'],
      // `vue`, `h3` and `nitropack` come with Nuxt; Nuxt Icon loads the installed `@iconify-json/*`
      // collections; `nuxt typecheck` runs `vue-tsc`.
      ignoreDependencies: ['vue', 'h3', 'nitropack', '@iconify-json/lucide', '@iconify-json/simple-icons', 'vue-tsc'],
    },
    'apps/extension': {
      // The standalone bundles `scripts/build.mjs` builds, plus the HTML pages' scripts.
      entry: [
        'src/content/*.ts',
        'src/ide/record-ide.ts',
        'src/background/index.ts',
        'src/devtools/*.ts',
        'src/login/main.ts',
        'src/options/main.ts',
        'src/popup/main.ts',
        'scripts/*.mjs',
        'tests/e2e/engine-entry.ts',
        'tests/lab/*.{ts,mjs}',
      ],
    },
    'apps/vscode': {
      entry: ['src/extension.ts', 'tests/integration/*.cjs'],
    },
    'packages/reporter': {
      entry: ['tests/bench/*.ts', 'tests/integration/**/*.{ts,mjs}'],
      ignore: ['example.playwright.config.ts', 'tests/fixtures/**'],
    },
    'packages/core': {},
    'packages/picker-dom': {},
    'packages/editor': {
      // The language server, and the launcher and the reporter `build.mjs` bundles beside it.
      entry: ['src/main.ts', 'src/recorder/launcher.ts', 'src/recorder/use-reporter.ts'],
      ignore: ['tests/fixtures/**'],
    },
    'packages/server': {
      // Native modules the published server installs for the bundled Nitro output.
      ignoreDependencies: ['@libsql/client', 'sharp'],
    },
    'integrations/nitro': {},
  },
};

export default config;
