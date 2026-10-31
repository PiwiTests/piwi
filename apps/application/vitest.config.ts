import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const appDir = fileURLToPath(new URL('./app', import.meta.url)).replace(/\/$/, '');

export default defineConfig({
  // Nuxt's `import.meta.client` is false under Vitest; a test runs a composable's
  // browser branch with `vi.stubGlobal('__IMPORT_META_CLIENT__', true)`.
  define: { 'import.meta.client': 'globalThis.__IMPORT_META_CLIENT__ === true' },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // Migrates one SQLite database for every test file to copy (`migrateToLatest`, tests/unit/temp-db.ts).
    globalSetup: ['tests/unit/global-setup.ts'],
    // @piwitests/core and @piwitests/editor ship TS source; inline them so
    // Vitest transpiles them from the workspace instead of trying to load them
    // as built dependencies.
    server: { deps: { inline: [/@piwitests\/core/, /@piwitests\/editor/] } },
    coverage: {
      provider: 'v8',
      // json-summary + json feed the PR coverage comment (see .github/workflows/ci.yml).
      reporter: ['text', 'html', 'json-summary', 'json'],
      // Scoped to the unit-testable pure-logic layers — app/ Vue components and
      // server/api/ route handlers are exercised by the Playwright E2E suite
      // instead, so including them here would just report accurate zeroes.
      include: ['shared/**/*.ts', 'server/utils/**/*.ts', 'app/utils/**/*.ts', 'app/composables/**/*.ts'],
    },
  },
  resolve: {
    // Mirror Nuxt's path aliases so app composables/utils can be unit-tested.
    alias: {
      '~~': rootDir,
      '@@': rootDir,
      '~': appDir,
      '@': appDir,
      '#shared': `${rootDir}/shared`,
      // Stub Nuxt's auto-import virtual module so pure helpers in modules that
      // reference auto-imported components can be unit-tested in isolation.
      '#components': `${rootDir}/tests/unit/stubs/nuxt-components.ts`,
      // Stub Nitro's compiled-route-metas virtual so server utils that read it
      // (route-required-permission.ts, via auth.ts) import cleanly under Vitest.
      '#nitro-internal-virtual/server-handlers-meta': `${rootDir}/tests/unit/stubs/nitro-handlers-meta.ts`,
    },
  },
});
