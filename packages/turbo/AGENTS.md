# playwright-turbo: agent instructions

A standalone npm package (`playwright-turbo`) that speeds up Playwright suites without forking Playwright, and its benchmark
in `bench/`. Not a workspace: it is versioned and released on its own, outside release-please. Only `src/` ships.

- **No dependencies.** Node built-ins only; `@playwright/test` is a peer dependency.
- **MIT**, like `packages/core`: no code from the FSL parts of the repository moves in here. Nothing Piwi-specific.
- **No copied Playwright or Flashwright code** (both Apache-2.0): hooks wrap internals at runtime. Code taken from
  either would need its license and NOTICE kept beside it. The README's Credits name Flashwright as the source of the
  techniques; keep them when a technique is added.
- **One fresh browser context per test**, as in stock Playwright: every lever keeps it.
- **Every lever is off unless named** in `withOptimizations` or `use`, and a project's own settings win.
- **The experimental hooks fail loudly** (`src/hooks.mjs`): a Playwright version outside `TESTED_VERSIONS`, an internal
  with another shape, or a browser outside the worker throws. Never add a silent fallback. A new tested version needs
  `npm run test:e2e` and the benchmark to pass on it first.
- **The workload stays deterministic**: seeded data, tests that create the data they change, visual tests on seeded
  rows only. A lever of the workload is one `BENCH_*` variable in `bench/workload/playwright.config.ts` and one variant
  in `bench/workload/bench.config.mjs`.
- `npm test` runs the unit tests (`node --test`); `npm run test:e2e` the hooks' compatibility suite.
