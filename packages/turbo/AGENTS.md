# @piwitests/turbo: agent instructions

The published package (`@piwitests/turbo`) that speeds up Playwright suites without forking Playwright, built with
tsup to `dist/`, and its benchmark in `bench/` (repository only: plain `.mjs` scripts, not published).

- **No runtime dependencies.** Node built-ins only; `@playwright/test` is a peer dependency, and no `@piwitests/*`
  package is imported, so `dist/` stays self-contained.
- **MIT**, like `packages/core`: no code from the FSL parts of the repository moves in here.
- **No copied Playwright or Flashwright code** (both Apache-2.0): hooks wrap internals at runtime. The README's
  Credits name Flashwright as the source of the techniques; keep them when a technique is added.
- **A browser context is shared between tests only through `reuseContextWithReset`** (`src/test.ts`), which adds the
  reset Playwright's `reuseContext` leaves out. `tests/e2e/reuse-isolation.ts` holds a pair of tests for each kind of
  state a test can leave, run by one spec per reset; a new kind of state gets a pair there.
- **Every lever is off unless named** in `withOptimizations` or `use`, or part of the preset; a project's own settings
  win, and an option left `undefined` keeps the preset's value (`tests/config.test.ts`).
- **The experimental hooks fail loudly** (`src/hooks.ts`): a Playwright version outside `TESTED_VERSIONS`, an internal
  with another shape, or a browser outside the worker throws; never add a silent fallback.
- **A Playwright version joins `TESTED_VERSIONS` by hand**, once `npm run turbo:test:e2e` and the benchmark pass on it
  with `PIWI_TURBO_ALLOW_UNTESTED=1`. CI runs the e2e suite that way, so a Playwright update shows whether the hooks
  still work.
- **The workload stays deterministic**: seeded data, tests that create the data they change, visual tests on seeded
  rows only. A lever of the workload is one `BENCH_*` variable in `bench/workload/playwright.config.ts` and one variant
  in `bench/workload/bench.config.mjs`.
- **Only `src/test.ts` imports the hooks**: tsup bundles each entry on its own, and the hooks' `state` must exist once
  per worker.
- `npm run turbo:test` runs the unit tests (Vitest), `npm run turbo:test:e2e` the hooks' compatibility suite.
