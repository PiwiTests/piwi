# Dashboard app: agent guide

Rules for working inside `apps/application/` (the Nuxt 4 app, its Nitro server, the demo SPA and the MCP server). Read
[`../../AGENTS.md`](../../AGENTS.md) first for repo-wide conventions, and [`ARCHITECTURE.md`](ARCHITECTURE.md) when you
need the map of what lives where.

Everything in these guides is a **rule or an invariant**: something you cannot infer by reading the code you happen to
open. This file holds the rules for every change in the app; the rules of each subsystem live in a guide next to its
code.

## Topic guides

Claude Code loads a topic guide by itself when you open a file in its directory; other agents read the matching row
before editing. A row that also names files outside its guide's directory (the guide engine, the demo seed generator)
is read by hand when you edit one of them. A change that spans several rows reads each of them.

| Editing…                                                                                                               | Read                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `app/`: pages, components, composables, utils (UI conventions)                                                         | [`app/AGENTS.md`](app/AGENTS.md)                                       |
| `app/components/run/`: the run page, its workers timeline                                                              | [`app/components/run/AGENTS.md`](app/components/run/AGENTS.md)         |
| `app/demo/`, `shared/demo/`, the demo seed, or any change the demo must mirror                                         | [`app/demo/AGENTS.md`](app/demo/AGENTS.md)                             |
| `app/utils/demo-tour/`: the live demo's guided tour                                                                    | [`app/utils/demo-tour/AGENTS.md`](app/utils/demo-tour/AGENTS.md)       |
| `shared/guide-anchors/`, the guide engine (`useGuide`, `app/utils/guide/`, `app/utils/guides/`), a `data-tour` element | [`shared/guide-anchors/AGENTS.md`](shared/guide-anchors/AGENTS.md)     |
| `server/api/`, `server/routes/`, authentication and permissions                                                        | [`server/api/AGENTS.md`](server/api/AGENTS.md)                         |
| The reporter's routes (`server/api/test-runs/`), a new field on run data, sharding                                     | [`server/api/test-runs/AGENTS.md`](server/api/test-runs/AGENTS.md)     |
| `server/database/`: schema, migrations, queries                                                                        | [`server/database/AGENTS.md`](server/database/AGENTS.md)               |
| `server/utils/`: SCM, fingerprints, locator healing, traces, DOM snapshots, AI CLIs                                    | [`server/utils/AGENTS.md`](server/utils/AGENTS.md)                     |
| `server/utils/mcp/`, `shared/mcp-tools.ts`: the MCP tools                                                              | [`server/utils/mcp/AGENTS.md`](server/utils/mcp/AGENTS.md)             |
| The in-app assistant and its nudges                                                                                    | [`server/utils/assistant/AGENTS.md`](server/utils/assistant/AGENTS.md) |
| `shared/`: which guide owns each shared module                                                                         | [`shared/AGENTS.md`](shared/AGENTS.md)                                 |
| `shared/env-format*.ts`, `shared/deploy/`, the deploy manifests                                                        | [`shared/deploy/AGENTS.md`](shared/deploy/AGENTS.md)                   |
| `scripts/`: feature screenshots, page measurements, performance suite, demo media, brand assets                        | [`scripts/AGENTS.md`](scripts/AGENTS.md)                               |

Where to add things in a subsystem whose wiring spans several files (a flaky root-cause category, a regression signal,
an AI context section, an import path, a quality report language, an issue automation criterion): the _Extension
points_ table of [`ARCHITECTURE.md`](ARCHITECTURE.md#extension-points).

## Layout and imports

What each top-level folder holds: [`ARCHITECTURE.md`](ARCHITECTURE.md#shape).

- **Component names are unique across `app/components/`.** Components live in domain subfolders and are auto-imported
  without a folder prefix (`pathPrefix: false` in `nuxt.config.ts`), so two components of the same name collide.
- **Import `shared/` as `#shared/...`** from `app/`, `server/` and the demo, never with a relative path or
  `~~/shared/...`. `shared/` holds the types, constants and pure helpers the app, the server and the demo share.
- **Cross-package pure logic lives in `@piwitests/core`** (`packages/core/`): import it as `@piwitests/core/<module>`,
  or through the `shared/*` file that re-exports it where one exists. Never put app-only (Nuxt, Drizzle, server) or reporter-only (Node-dependent) code
  there: `packages/core/tests/boundary.test.ts` fails on a dependency or on an import that is not relative (`node:`, a
  package, the app).

### Never duplicate logic between server and demo

`server/` and `app/demo/api/` mirror each other (same schema, same persist logic). A helper that would otherwise live
in both is extracted into `server/utils/` (the demo imports it as `~~/server/utils/...`) or `shared/`, and imported by
both. Keep two implementations only where they genuinely differ (error handling, authentication). The run import and
the offline export are written once in `shared/` and differ only in the port each side passes them (`ImportPort`,
`ExportAssetReader`).

## Rules for every change

- **Every document Piwi writes for use outside the dashboard ends with the Piwi credit** of `shared/brand.ts` (the
  offline exports, the quality reports, the emails, and any new format): `piwiCreditHtml`, `drawPiwiCredit` for a PDF,
  `piwiCreditMarkdown`; `emailLayout` draws it in every email. The mark (`shared/brand-mark.json`) never loads over
  the network: inline SVG in HTML, vector paths in a PDF, an attachment in an email (`sendEmail` attaches it when the
  message shows it). Data files (CSV, XLSX, JSON) carry none.
- **Every `PIWI_*` variable is registered in `shared/piwi-env-vars.ts`** (`PIWI_ENV_VARS`, the single source of truth
  for its description, category, type, default, limits, `secret` flag, `since` release and docs page). Register a new
  one in the same change (in `nuxt.config.ts` or a server util alike), stamped `since: '<next release>'`;
  `tests/unit/piwi-env-vars.test.ts` fails on an unregistered variable, a missing `since` or a default that differs from
  the code. Never list variables in prose: link the registry or the generated
  [configuration reference](https://piwitests.dev/reference/configuration).
- **The app runs with no variable set.** The one thing it refuses without configuration is storing a secret (an AI key,
  an SCM token, a webhook secret): without `PIWI_SECRET_KEY`, the key of their AES-256-GCM encryption, the save answers
  409 (`server/utils/crypto.ts`).
- **The demo mirrors every feature.** A new database column, API response field or visible UI change updates the seed
  generator, the demo handlers (`app/demo/api/`), the simulator, the docs and, when a tour stop shows the screen, the
  tour; then run `npm run app:seed:demo`. The five places and their checks:
  [`app/demo/AGENTS.md`](app/demo/AGENTS.md#demo-data-requirements).
- **No dynamic `import()` in a module the demo's service worker bundles**: `app/demo/` and every module of `shared/` and
  `server/utils/` it imports (`server/utils/` keeps lazy imports elsewhere, such as `sharp` or `nodemailer`). The worker
  is a classic script: Vite's preload wrapper for a dynamic import is a syntax error there, and the worker never
  installs. Import statically; `npm run app:check:demo:runtime` catches it.
- **A change to what a page loads or renders is measured** with the performance suite (`npm run app:perf`); CI posts
  the comparison on every pull request. How to run it: [`scripts/AGENTS.md`](scripts/AGENTS.md#performance).

## Adding the usual things

- **API endpoint**: a file under `server/api/` with its `defineRouteMeta` block and access helper. The checklist:
  [`server/api/AGENTS.md`](server/api/AGENTS.md).
- **Calling an endpoint from the app**: every call site names its response type, since `$fetch` and `useFetch` carry no
  typed route map (the `types:extend` hook in `nuxt.config.ts` empties Nitro's `InternalApi`). Write
  `$fetch<ApiResponse<typeof import('~~/server/api/…').default>>(…)` with `ApiResponse` from `types/api.ts`, or use a
  type of that file or of the shared handler. A call without one returns `unknown`.
- **Page**: a Vue file in `app/pages/` built on `<UDashboardPanel>`, added to the nav links of `app/layouts/default.vue`
  when it belongs in the sidebar. A page showing one entity (`[id].vue`) calls
  `showPageLoadError(error.value, '<entity>')` (`app/utils/page-error.ts`) right after fetching it, so a missing or
  forbidden id renders the error page and answers 404 or 403, never an empty page with a 200.
- **Component**: a Vue file in the matching `app/components/` subfolder, with a name unique in the app; follow the reuse
  and responsive rules of [`app/AGENTS.md`](app/AGENTS.md).
- **Unit test**: `tests/unit/*.test.ts` (Vitest). One that needs a PostgreSQL server is named `*-pg.test.ts`, reads its
  URL from `PIWI_POSTGRES_TEST_URL` and skips without it; CI runs them once, in the E2E job's `s3 + postgres` cell.
- **E2E test**: `tests/*.spec.ts` (Playwright), with any project name registered in `shared/test-project-names.ts`.
- **A test that needs an AI model** runs against a mock OpenAI-compatible server, as `tests/ai-diagnosis.spec.ts` does,
  so the main suite spends no tokens. Only `tests/live/` talks to a real service: `playwright.config.ts` ignores it, and
  each of its suites has its own config and script (`app:test:ai:live` and `app:test:assistant:live` need
  `OPENCODE_API_KEY` and spend tokens, `app:test:jira:live` writes to a real Jira). Assume the live model is text-only:
  the AI suite pins `PIWI_AI_MAX_IMAGES=0`.

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

- **Database locked?** Stop the other processes using `.data/piwi.db`. The dev server holds it, so stop it before
  `app:seed:dev`.
- **Typecheck out of memory?** `npm run app:typecheck` gives the checker a 4 GB heap. It needs about 3 GB, because the
  app's program also type-checks the server code that the demo and the typed API responses import. Running
  `nuxt typecheck` or `vue-tsc` yourself needs the same `NODE_OPTIONS=--max-old-space-size=4096`.
- **Port 3000 in use?** `PORT=3001 npm run app:dev` (Linux/macOS) or `$env:PORT=3001; npm run app:dev` (PowerShell).
- **E2E tests failing on every page?** Outside CI, the Playwright config reuses a server already listening on port 3000.
  A server started with other settings (the desktop app, authentication on, another branch's build) makes the specs
  fail: stop it, or start the one you want with `npm run app:dev:bg`.
- **Migration not applying?** It was probably written by hand: the migrator applies only what `_journal.json` lists.
  Delete it, revert any journal edit and run `npm run db:generate` (or `db:generate:pg`); the rules:
  [`server/database/AGENTS.md`](server/database/AGENTS.md).
- **`table … already exists`, or a missing table, after switching branches?** The local database ran another branch's
  migrations. The next startup repairs it (`Migration history repaired` in the log). If it logs
  `Migration history repair failed`, stop the server, delete `.data/piwi.db` and run `npm run app:seed:dev`.
- **An icon renders blank?** No icon is fetched from the iconify CDN (`fallbackToApi: false` in `nuxt.config.ts`): the
  client bundle holds the icons whose full name (`i-lucide-…`, `i-simple-icons-…`) appears in the source, `.ts` files
  and `shared/` included. Write the full name as a literal; a name built at run time is not bundled.
