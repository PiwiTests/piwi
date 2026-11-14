# suitebench: agent instructions

A standalone npm package (`suitebench`) that benchmarks configurations of any Playwright suite, with its reference
workload in `workload/`. Not a workspace: it is versioned and released on its own, outside release-please.

- **No dependencies.** The harness runs on Node built-ins only; `@playwright/test` is a peer dependency of the
  workload. A new dependency needs a reason a built-in cannot meet.
- **MIT**, like `packages/core`: no code from the FSL parts of the repository moves in here.
- **Nothing Piwi-specific**: no `@piwitests/*` import, no Piwi branding in the CLI output or the workload.
- **The workload stays deterministic**: seeded data, tests that create the data they change, visual tests on seeded
  rows only. A test that fails or flakes under `--repeat-each 5 --workers 4` makes every comparison noisier.
- **A new lever of the workload** is one `BENCH_*` variable read in `workload/playwright.config.ts` (or its fixtures),
  listed in that file's header comment, and one variant in `workload/suitebench.config.mjs`.
- `npm test` runs the unit tests (`node --test`); `npm run workload:profile` runs the workload once.
