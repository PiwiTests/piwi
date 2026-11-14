# @piwitests/turbo: agent instructions

The published package (`@piwitests/turbo`) that speeds up Playwright suites without forking Playwright, built with
tsup to `dist/`, and its benchmark in `bench/` (repository only: plain `.mjs` scripts, not published).

- **No runtime dependencies.** Node built-ins only; `@playwright/test` is a peer dependency, and no `@piwitests/*`
  package is imported, so `dist/` stays self-contained.
- **MIT**, like `packages/core`: no code from the FSL parts of the repository moves in here.
- **No copied Playwright or Flashwright code** (both Apache-2.0): hooks wrap internals at runtime. Code taken from
  either would need its license and NOTICE kept beside it. The README's Credits name Flashwright as the source of the
  techniques; keep them when a technique is added.
- **A browser context is shared between tests only through `reuseContextWithReset`** (`src/test.ts`), which adds the
  reset Playwright's `reuseContext` leaves out; `tests/e2e/reuse-isolation.spec.ts` checks each kind of state, and a
  new kind of state a test can leave gets a pair of tests there.
- **Every lever is off unless named** in `withOptimizations` or `use`, or part of the preset; a project's own settings
  win, and an option left `undefined` keeps the preset's value (`tests/config.test.ts`).
- **The experimental hooks fail loudly** (`src/hooks.ts`): a Playwright version outside `TESTED_VERSIONS`, an internal
  with another shape, or a browser outside the worker throws. Never add a silent fallback. A new tested version needs
  `npm run turbo:test:e2e` and the benchmark to pass on it first.
- **The workload stays deterministic**: seeded data, tests that create the data they change, visual tests on seeded
  rows only. A lever of the workload is one `BENCH_*` variable in `bench/workload/playwright.config.ts` and one variant
  in `bench/workload/bench.config.mjs`.
- **Only `src/test.ts` imports the hooks**: tsup bundles each entry on its own, and the hooks' `state` must exist once
  per worker.
- `npm run turbo:test` runs the unit tests (Vitest), `npm run turbo:test:e2e` the hooks' compatibility suite.
