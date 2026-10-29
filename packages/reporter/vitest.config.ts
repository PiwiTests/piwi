import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // tests/integration/ is a standalone Playwright project (a real browser +
    // the built package), not part of the Vitest unit suite — run it via
    // `npm run reporter:test:integration` instead. tests/bench/ holds the
    // capture-overhead benchmark: its `.spec.ts` is a Playwright workload
    // driven by `reporter:bench`, and its `.bench.ts` runs under
    // `reporter:bench:micro`. The dot folders in tests/ are the transient
    // Playwright projects the real-run specs write.
    exclude: ['**/node_modules/**', 'tests/integration/**', 'tests/bench/**', 'tests/.*/**'],
    benchmark: {
      include: ['tests/bench/**/*.bench.ts'],
    },
    coverage: {
      provider: 'v8',
      // json-summary + json feed the PR coverage comment (see .github/workflows/ci.yml).
      reporter: ['text', 'html', 'json-summary', 'json'],
      include: ['src/**/*.ts'],
    },
  },
});
