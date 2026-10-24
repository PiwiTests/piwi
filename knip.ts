import type { KnipConfig } from 'knip';

// The live suites' Playwright configs (`app:test:ai:live`, `app:test:jira:live`)
// throw without their credentials; knip only reads them for their entry files.
process.env.OPENCODE_API_KEY ||= 'knip';
process.env.PIWI_JIRA_BASE_URL ||= 'https://knip.atlassian.net';
process.env.PIWI_JIRA_EMAIL ||= 'knip@example.com';
process.env.PIWI_JIRA_API_TOKEN ||= 'knip';
process.env.PIWI_LIVE_JIRA_PROJECT_KEY ||= 'KNIP';
// Knip reads every config as a local run does, so the result is the same in CI: the app's Playwright
// config names `monocart-reporter` only outside CI.
delete process.env.CI;

const config: KnipConfig = {
  // Report exports nothing imports; an export used only inside its own module is not flagged.
  ignoreExportsUsedInFile: true,
  // System commands the scripts run: Windows' `tasklist`, and ImageMagick's `import` and `Xvfb` for the JetBrains
  // screenshots.
  ignoreBinaries: ['tasklist', 'import', 'Xvfb'],
  workspaces: {
    '.': {
      // The JetBrains plugin is not a workspace: its screenshot script is read from the root.
      entry: ['scripts/*.mjs', 'apps/jetbrains/scripts/*.mjs'],
      // Not workspaces: built on their own toolchains (Tauri, VitePress) or resolved from the npm registry.
      ignore: ['apps/desktop/**', 'apps/docs/**', 'examples/sample-app/**'],
    },
    'apps/application': {
      entry: [
        'app/service-worker/demo-sw.ts',
        'scripts/*.mjs',
        // The performance suite's report step, run by `reusable-perf.yml`.
        'scripts/perf/*.mjs',
        'tests/globalSetup.ts',
        'tests/globalTeardown.ts',
        // The fake Claude Code CLI the server runs in `assistant-claude-code.spec.ts`.
        'tests/fixtures/fake-claude.mjs',
        'drizzle.config.pg.ts',
        // Dashboard widgets are imported from `#components` by `app/utils/analytics-widgets.ts`.
        'app/components/analytics/*.vue',
        // drizzle-kit reads every table the schema exports.
        'server/database/schema.*.ts',
        // What `#components` resolves to under Vitest (vitest.config.ts): Nuxt resolves it everywhere else.
        'tests/unit/stubs/nuxt-components.ts',
      ],
      // `nitropack` comes with Nuxt; Nuxt Icon loads the installed `@iconify-json/*` collections; `nuxt typecheck`
      // runs `vue-tsc`. `@emnapi/*` keeps the runtime of the WASM fallback bindings (oxc, Tailwind's oxide) in the
      // lockfile, which `npm ci` needs on every platform.
      ignoreDependencies: [
        'nitropack',
        '@iconify-json/lucide',
        '@iconify-json/simple-icons',
        'vue-tsc',
        '@emnapi/core',
        '@emnapi/runtime',
      ],
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
      // The screenshot script, and the fixture it shares with the JetBrains plugin's.
      entry: ['src/extension.ts', 'tests/integration/*.cjs', 'scripts/*.mjs', 'scripts/lib/*.mjs'],
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
