# @piwitests/turbo: agent instructions

The published package (`@piwitests/turbo`) that speeds up Playwright suites without forking Playwright, built with
tsup to `dist/`, and its benchmark in `bench/` (repository only: plain `.mjs` scripts, not published).

- **No runtime dependencies.** Node built-ins only; `@playwright/test` is a peer dependency, and no `@piwitests/*`
  package is imported, so `dist/` stays self-contained.
- **MIT**, like `packages/core`: no code from the FSL parts of the repository moves in here.
- **No copied Playwright or Flashwright code** (both Apache-2.0): hooks wrap internals at runtime. The README's
  Credits name Flashwright as the source of the techniques; keep them when a technique is added.
- **turbo resets a context whenever Playwright reuses it** (`_turboReused` in `src/test.ts`: `reuseContextWithReset`
  or `PW_TEST_REUSE_CONTEXT`, with video off). `tests/e2e/reuse-isolation.ts` holds a pair of tests for each kind of
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
- **`piwi-turbo` (`src/cli.ts`) sets its caches up and starts the spare worker before anything loads Playwright**: it
  imports no module that loads `@playwright/test`. `code-cache.ts`, `spare-worker.ts`, `warm-daemon.ts` and
  `warm-runner.ts` stay tsup entries, since other processes load them by path from `dist/`.
- **The spare worker stands in only for a fork that matches its start** (`spareRefusal` in `src/spare.ts`): a changed
  variable Node reads at start, or one Playwright read while the spare loaded, refuses it. `tests/e2e/cli.spec.ts` runs
  a project through the built command.
- **The spare's early browser is taken only by a launch with the recorded options and the same browser environment**
  (`earlyBrowserRefusal` in `src/early-browser.ts`); options that can hold a credential are never recorded
  (`launchableOptions`). `tests/early-browser.test.ts` and `tests/e2e/cli.spec.ts` check both.
- **The warm daemon (`--warm`) answers only requests that carry its token**, kept with its address in a file only its
  user can read; a runner takes a command only when what it read as it loaded, its terminal included, is the caller's
  (`refusal` in `src/warm-daemon.ts`), else the command runs cold. `tests/e2e/cli.spec.ts` checks both.
- `npm run turbo:test` runs the unit tests (Vitest), `npm run turbo:test:e2e` builds the package and runs the hooks'
  compatibility suite and the command's tests.
