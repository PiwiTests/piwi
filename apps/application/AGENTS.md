# Dashboard app: agent guide

Rules for working inside `apps/application/` (the Nuxt 4 app, its Nitro server, the demo SPA and the MCP server). Read
[`../../AGENTS.md`](../../AGENTS.md) first for repo-wide conventions, and [`ARCHITECTURE.md`](ARCHITECTURE.md) when you
need the map of what lives where.

Everything in these guides is a **rule or an invariant**: something you cannot infer by reading the code you happen to
open. This file holds the rules for every change in the app; the rules of each subsystem live in a guide next to its
code.

## Topic guides

Claude Code loads a topic guide by itself when you open a file in its directory; other agents read the matching row
before editing. A change that spans several rows reads each of them.

| Editing…                                                                                | Read                                                                   |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `app/`: pages, components, composables, utils (UI conventions)                          | [`app/AGENTS.md`](app/AGENTS.md)                                       |
| `app/components/run/`: the run page, its workers timeline                               | [`app/components/run/AGENTS.md`](app/components/run/AGENTS.md)         |
| `app/demo/`, `shared/demo/`, the demo seed, or any change the demo must mirror          | [`app/demo/AGENTS.md`](app/demo/AGENTS.md)                             |
| `app/utils/demo-tour/`: the live demo's guided tour                                     | [`app/utils/demo-tour/AGENTS.md`](app/utils/demo-tour/AGENTS.md)       |
| `shared/guide-anchors/`, `app/utils/guide/`, `app/utils/guides/`, a `data-tour` element | [`shared/guide-anchors/AGENTS.md`](shared/guide-anchors/AGENTS.md)     |
| `server/api/`, `server/routes/`, authentication and permissions                         | [`server/api/AGENTS.md`](server/api/AGENTS.md)                         |
| The reporter's routes (`server/api/test-runs/`), a new field on run data, sharding      | [`server/api/test-runs/AGENTS.md`](server/api/test-runs/AGENTS.md)     |
| `server/database/`: schema, migrations, queries                                         | [`server/database/AGENTS.md`](server/database/AGENTS.md)               |
| `server/utils/`: SCM providers, fingerprints, locator healing, trace storage, DOM views | [`server/utils/AGENTS.md`](server/utils/AGENTS.md)                     |
| `server/utils/mcp/`, `shared/mcp-tools.ts`: the MCP tools                               | [`server/utils/mcp/AGENTS.md`](server/utils/mcp/AGENTS.md)             |
| The in-app assistant and its nudges                                                     | [`server/utils/assistant/AGENTS.md`](server/utils/assistant/AGENTS.md) |
| `shared/env-format*.ts`, `shared/deploy/`, the deploy manifests                         | [`shared/deploy/AGENTS.md`](shared/deploy/AGENTS.md)                   |
| `scripts/`: feature screenshots, page measurements, performance suite, demo media       | [`scripts/AGENTS.md`](scripts/AGENTS.md)                               |

Where to add things in a subsystem whose wiring spans several files (a flaky root-cause category, a regression signal,
an AI context section, an import path, a quality report language, an issue automation criterion): the _Extension
points_ table of [`ARCHITECTURE.md`](ARCHITECTURE.md#extension-points).

## Layout & imports

- `app/` — Vue pages, components, composables, utils. Components live in domain subfolders and are auto-imported
  **without a folder prefix** (`pathPrefix: false`), so names must be globally unique.
- `server/` — Nitro API (`server/api/`), routes (`server/routes/`), utils, database, scheduled tasks.
- `shared/` — types, constants and pure helpers shared by app + server + demo. Import as `#shared/...` — **never**
  relative paths or `~~/shared/...`.
- `app/demo/` — the in-browser mirror of the server, used by the demo SPA.
- Cross-package pure logic lives in `@piwitests/core` (`packages/core/`) and is re-exported through thin `shared/*`
  shims so `#shared/...` paths never change. Do **not** put app-only (Nuxt/Drizzle/server) or reporter-only
  (Node-dependent) code there — `packages/core/tests/boundary.test.ts` enforces zero deps and no `node:` imports.

### Never duplicate logic between server and demo

`server/` and `app/demo/api/` mirror each other (same schema, same persist logic). Any helper that would otherwise
live in both must be extracted into `server/utils/` (the demo imports it via `~~/server/utils/...`) or `shared/`, and
imported by both. Exceptions only where the implementations genuinely differ (error handling, auth).

## Rules for every change

- **Every `PIWI_*` variable is registered in `shared/piwi-env-vars.ts`** (`PIWI_ENV_VARS`, the single source of truth:
  name, description, category, type, default, limits, `secret`, `since`, docs anchor). When you add one anywhere
  (nuxt.config, a server util), register it in the same change with a `since: '<next release>'` stamp;
  `tests/unit/piwi-env-vars.test.ts` fails on an unregistered variable, a missing `since` or a drifted default. Never
  list variables in prose: link the registry or the generated
  [configuration reference](https://piwitests.dev/reference/configuration). The app runs with **no variable set**;
  `PIWI_SECRET_KEY` is the master key for the AES-256-GCM encryption of stored secrets, recommended in production even
  without authentication.
- **The demo mirrors every feature.** A new DB column, API response field or visible UI change updates the seed
  generator, the demo handlers (`app/demo/api/`), the simulator, the docs and, when a tour stop shows the screen, the
  tour; then `npm run app:seed:demo`. The five places and the checks: [`app/demo/AGENTS.md`](app/demo/AGENTS.md).
- **No dynamic `import()` in code the demo's service worker bundles** (`shared/`, `server/utils/`, `app/demo/`): the
  worker is a classic script, and Vite's preload wrapper for a dynamic import is a syntax error there that stops it
  from installing. Import statically; `npm run app:check:demo:runtime` catches it.
- **A change to what a page loads or renders is measured** with the performance suite (`npm run app:perf`); CI posts
  the comparison on every pull request. How to run it: [`scripts/AGENTS.md`](scripts/AGENTS.md#performance).

## Adding the usual things

- **API endpoint** — a file under `server/api/` with its `defineRouteMeta` block and access helper: the checklist is in
  [`server/api/AGENTS.md`](server/api/AGENTS.md).
- **Calling an endpoint from the app** — `$fetch` and `useFetch` carry no typed route map (a `types:extend` hook in
  `nuxt.config.ts` empties Nitro's `InternalApi`), so every call site names its response type:
  `$fetch<ApiResponse<typeof import('~~/server/api/…').default>>(…)` with `ApiResponse` from `types/api.ts`, or a
  type of that file or of the shared handler. A call without one is `unknown`, never inferred.
- **Page** — a Vue file in `app/pages/` built on `<UDashboardPanel>`; register it in the nav links array in
  `app/layouts/default.vue` if it belongs in the sidebar. A page showing one entity (`[id].vue`) calls
  `showPageLoadError(error.value, '<entity>')` (`app/utils/page-error.ts`) right after fetching it, so a missing or
  forbidden id renders the error page and answers 404 or 403, never an empty page with a 200.
- **Component** — a Vue file in the matching `app/components/` subfolder. Auto-import has no folder prefix, so the name
  must be unique repo-wide; follow the reuse and responsive rules in [`app/AGENTS.md`](app/AGENTS.md).
- **Unit test** — `tests/unit/*.test.ts` (Vitest). One that needs a PostgreSQL server is named `*-pg.test.ts`, reads it
  from `PIWI_POSTGRES_TEST_URL` and skips without it; CI runs those in the E2E job's PostgreSQL cell. **E2E test** —
  `tests/*.spec.ts` (Playwright), with any project name registered in `shared/test-project-names.ts`.
- **AI test** — an E2E that needs a model goes against the mock OpenAI-compatible server in `tests/ai-diagnosis.spec.ts`,
  so the main suite stays at zero tokens. `tests/live/` is the only place that talks to a real provider: it is excluded
  from `playwright.config.ts`, has its own config, and runs from `npm run app:test:ai:live` (needs `OPENCODE_API_KEY`, spends tokens). Assume the live model is
  text-only — that suite pins `PIWI_AI_MAX_IMAGES=0`.

## Commands and verification

From `apps/application/`:

| Command                                                        | Purpose                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run app:typecheck`                                        | TypeScript check (4 GB heap)                                                     |
| `npm run app:lint` / `app:lint:fix`                            | oxlint                                                                           |
| `npm run app:format` / `app:format:check`                      | oxfmt, Markdown included                                                         |
| `npm run app:test:unit`                                        | Unit tests (Vitest); one file: `npx vitest run tests/unit/<name>.test.ts`        |
| `npm run app:test -- <spec>`                                   | E2E tests (Playwright); `:ui`, `:report`, `:desktop` variants                    |
| `npm run db:generate` / `db:migrate` / `db:push` / `db:studio` | Drizzle, SQLite; append `:pg` for PostgreSQL                                     |
| `npm run app:seed:demo` / `app:seed:dev`                       | Regenerate the demo seed / load it into the local dev database                   |
| `npm run app:generate:demo` + `app:check:demo:runtime`         | Build the demo SPA, then drive it from its real `/demo/` sub-path                |
| `npm run app:screens -- <scene>` or `-- --route <path>`        | Screenshot a scene or any page (boots and seeds its own server)                  |
| `npm run app:dev:bg`                                           | Dev server on port 3000 in the background (`node scripts/dev-server.mjs --stop`) |
| `node scripts/db-query.mjs "<sql>" [--json]`                   | Query the local SQLite database                                                  |

- **To see a change working**, follow the `run-app` skill (`.claude/skills/run-app/SKILL.md`): the seeded routes, the
  background dev server, the screenshot command and the pitfalls.
- **Never set `PIWI_DEMO_MODE=true` on a dev server**: demo mode builds the static SPA. To verify the demo, build it and
  drive the build (`app:generate:demo`, then `app:check:demo:runtime`); `app:check:demo` alone only compares route
  patterns.

## Troubleshooting

- **DB locked?** Stop other processes touching `.data/piwi.db` (the dev server holds it — `app:seed:dev` needs it down).
- **Typecheck out of memory?** `npm run app:typecheck` gives the checker a 4 GB heap: it needs about 3 GB, since the
  app's program also type-checks the server code the demo and the typed API responses import. Running `nuxt typecheck`
  or `vue-tsc` yourself needs the same `NODE_OPTIONS=--max-old-space-size=4096`.
- **Port 3000 in use?** `PORT=3001 npm run app:dev` (Linux/macOS) or `$env:PORT=3001; npm run app:dev` (PowerShell).
- **E2E tests failing on every page?** Outside CI, the Playwright config reuses a server already listening on port 3000. A server started with other settings (the desktop app, authentication on, another branch's build) makes the
  specs fail: stop it, or start the one you want with `npm run app:dev:bg`.
- **Migration not applying?** A hand-written migration file or `_journal.json` edit makes the Drizzle migrator skip it
  silently. Delete it, revert the journal entry, and re-run `npm run db:generate` (or `db:generate:pg`).
- **`table … already exists` or a missing table after switching branches?** The local database ran migrations from
  another branch. The next startup repairs it (`Migration history repaired` in the log); if it logs
  `Migration history repair failed`, stop the server, delete `.data/piwi.db` and run `npm run app:seed:dev`.
- **Brand icons blank?** `i-simple-icons-*` icons load from the iconify CDN at runtime, so they render blank without
  outbound network; only the `lucide` collection is bundled. An environment limitation, not a bug.
