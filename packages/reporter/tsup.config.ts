import { defineConfig } from 'tsup';

/**
 * The reporter publishes standalone to npm, so it must ship a self-contained
 * `dist/` with no monorepo paths in its `.js`/`.d.ts`. tsup bundles the shared
 * `@piwitests/core` source straight into the output (JS via esbuild, types via
 * the dts step), leaving only real/peer deps external. The two entry points stay
 * at `dist/` root so `package.json` main/types/exports don't move.
 */
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/global-setup-module.ts',
    // `piwi` CLI (package.json `bin`) — its own entry so the reporter's main
    // bundle stays free of CLI-only code.
    'src/cli/index.ts',
    // The dashboard dogfoods the reporter by deep-importing these internal
    // capture modules from `dist/` (see application/tests/fixtures.ts), so each
    // keeps its own emitted file at `dist/internal/capture/<name>.js`.
    'src/internal/capture/locator-healing.ts',
    'src/internal/capture/capture-fixtures.ts',
    'src/internal/capture/inspect-on-failure.ts',
    'src/internal/capture/pick-on-failure.ts',
    'src/internal/capture/attachments.ts',
  ],
  format: ['cjs'],
  // Every entry's types, the internal capture entries' too (the public entry
  // re-exports the fixtures from one), take in the types of @piwitests/core and
  // @piwitests/picker-dom, which a consumer never installs: the types build
  // resolves both from their sources (`paths`, `rootDir` above this package).
  dts: {
    resolve: [/^@piwitests\//],
    compilerOptions: {
      rootDir: '..',
      paths: {
        '@piwitests/core/*': ['../core/src/*.ts'],
        '@piwitests/picker-dom': ['../picker-dom/src/index.ts'],
      },
    },
  },
  bundle: true,
  outDir: 'dist',
  target: 'node20',
  platform: 'node',
  splitting: false,
  sourcemap: false,
  clean: true,
  // Inline the shared core/picker-dom packages so nothing monorepo-relative
  // leaks into the published artifact.
  noExternal: [/^@piwitests\/core/, /^@piwitests\/picker-dom/],
  // Real runtime dep + Playwright peer stay external.
  external: ['form-data', '@playwright/test'],
});
