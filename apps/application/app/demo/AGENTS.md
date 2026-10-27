# Demo mode: agent guide

Rules for the demo SPA (`app/demo/`, `shared/demo/`, the seed generator) and for keeping it in step with every
feature. Read [`../../AGENTS.md`](../../AGENTS.md) first.

## How the demo works

`PIWI_DEMO_MODE=true` builds a fully client-side SPA: a service worker intercepts `/api/` and serves from in-browser
sql.js (WASM SQLite) through Drizzle, persisted in IndexedDB. `app/demo/api/router.ts` dispatches; SW and main thread
share `app/demo/db.client.ts`.

- **`public/demo/seed.sql` is NOT committed** — gitignored, regenerated on demand (`npm run app:seed:demo`, and by CI in
  `docs.yml` before the demo build). Only `seed.version.json` (SHA-256 of the SQL + timestamp) is tracked. Generation is
  deterministic (seeded PRNG), so two runs with no source changes are byte-identical. After editing
  `scripts/generate-demo-seed.mjs` or `shared/demo/failure-stories.mjs`, re-seed and commit the generator plus the
  updated `seed.version.json`; never stage `seed.sql`.
- **No dynamic `import()` in code the service worker bundles** (`shared/`, `server/utils/`, `app/demo/`): the
  worker is a classic script and Vite's preload wrapper for a dynamic import uses `import.meta.url`, a syntax
  error there that stops the worker from installing. Import statically; `app:check:demo:runtime` catches it.
- The first render waits on the in-browser database, so until then the static shell shows
  `app/demo/loading-template.html` (Nuxt's `spaLoadingTemplate`, removed on `app:suspense:resolve`). It is also what
  crawlers index: keep the demo's heading and description in it, and its status text inside `data-nosnippet`.
- Staleness detection injects `demoDataVersion` into `runtimeConfig.public`; the layout compares it to the IndexedDB
  copy and offers a "New demo data available" reset.
- The run simulator (`DemoSimulator.vue` + `app/demo/simulator.ts`) replays the reporter's streaming protocol against
  the in-browser endpoints. Failing tests **must reuse a seeded story's exact error text** from
  `shared/demo/failure-stories.mjs` so the simulated failure fingerprints identically and joins the real cluster
  instead of spawning a lookalike — hand-copied error strings must never drift from the fixture source again. Live
  updates flow over a BroadcastChannel (`app/demo/run-events.ts`), not SSE.

- **The web-dashboard Test Map** (`shared/demo/demo-test-map.mjs`) is checked against the live recompute by
  `tests/unit/demo-test-map.test.ts`: the seeded gaps (`demo-test-map-gaps.json`), control reach and feature groups
  must be what a recompute writes. The model also labels its ground truth (`expectedWebDashboardGaps`: a control or
  link label on each step, the flaky tests, the catalog's callers, the passing tests the application errored under),
  and the test scores each detector's precision and recall against it
  (`demo-test-map-benchmark.json`): any changed score fails, and a lower one is named. After a change to the model or
  a detector, run the test with `PIWI_UPDATE_DEMO_TEST_MAP=1`, format both files, re-seed and run it again; say in the
  commit why a score moved.

### Demo data requirements

Any feature adding a DB column, an API response field or a UI-visible change updates the demo in five places:
`scripts/generate-demo-seed.mjs` (seed the columns), `app/demo/api/` (mirror the response fields), `app/demo/simulator.ts`
(emit new streaming fields), `apps/docs/`, and the guided tour when the change touches a screen a tour stop shows
(`app/utils/demo-tour/profiles.ts` and every `copy.<code>.ts`, see [`app/utils/demo-tour/AGENTS.md`](../utils/demo-tour/AGENTS.md)) — then
`npm run app:seed:demo`.

**`shared/demo/failure-stories.mjs` is the single source of truth for every seeded failure**: one story per cluster
carries the failing spec line, a reporter-faithful error string, the app source files it traces to, and a suggested-fix
patch _derived_ from those same lines — so error, snippet, patch and demo SCM source cannot drift. Locator-centric
stories also carry an authored failure-time DOM snapshot served by `app/demo/api/dom-snapshot.ts` with precedence over
the committed trace ZIPs (whose recorded pages are too bare for the locator picker); the ZIP-parse path stays the
fallback. Demo AI diagnosis is **data-grounded, not canned prose** — rebuilt from the seeded DB and each cluster's real
stats, with suggested patches genuinely `validatePatch`-checked. Demo-only AI/SCM code stays out of `shared/handlers/`
so the canned SCM never enters the server bundle; the one shared piece is the version-snapshot row shape
(`shared/handlers/diagnosis-versions.ts`). `tests/unit/demo-seed-consistency.test.ts` guards the whole chain.

**The docs link concrete demo screens through `shared/demo/demo-examples.mjs`**, and the same test checks each
example's `expect` against the generated seed (the entity its route opens, and the state its sentence promises). A
seed change that moves or changes one fails there, naming the example: update the entry (route, `expect`, `shows`)
in the same change, never the check.

**`tests/unit/failure-lines-coherence.test.ts` guards the failure pages' lines over the seed**: it fails when two
lines of a cluster or execution page contradict each other (its header lists the rules), and a seed or policy change
that trips one fixes the lines, never the rule.
