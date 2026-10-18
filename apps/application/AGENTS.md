# Dashboard app — agent guide

Rules for working inside `apps/application/` (the Nuxt 4 app, its Nitro server, the demo SPA and the MCP server).
Read [`../AGENTS.md`](../AGENTS.md) first for repo-wide conventions, and [`ARCHITECTURE.md`](ARCHITECTURE.md) when you
need the map of what lives where.

Everything below is a **rule or an invariant** — something you cannot infer by reading the code you happen to open.

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

## Database

- Drizzle ORM, two dialects: SQLite via libSQL (default) and PostgreSQL via postgres.js, selected at runtime by
  `PIWI_DATABASE_URL`.
- **`server/database/schema.ts` is a conditional re-export only** — never edit it to add a table or column. Edit
  **both** `schema.sqlite.ts` and `schema.pg.ts`, then `npm run db:generate && npm run db:generate:pg`.
- ⚠ **Never hand-write a migration file or edit `_journal.json`** — always generate. A hand-made migration is silently
  skipped by the migrator.
- **Migrations across a merge of the base branch** — a local database that ran a branch's migrations keeps their
  records, so what a merge does to them decides whether that database still starts:
  - **The base branch added no migration: keep the branch's migrations as they are.** Regenerating gives them new names
    and dates, and every database that ran the old ones then holds records this build does not know.
  - **The base branch added migrations** (a conflict in `_journal.json` or a `meta/NNNN_snapshot.json`, or two files
    with the same number): the branch's must be dated after them. From `apps/application/`, in **both** folders:

    ```bash
    git diff --relative --name-only --diff-filter=A origin/main... -- server/database/migrations server/database/migrations-pg
    git rm <each file listed>        # the branch's own .sql files and snapshots
    git checkout origin/main -- server/database/migrations server/database/migrations-pg
    npm run db:generate && npm run db:generate:pg
    ```

    drizzle-kit only regenerates schema changes: recreate each custom migration (a data backfill) with
    `npm run db:generate -- --custom --name=<name>` and `npm run db:generate:pg -- --custom --name=<name>`, then paste
    its SQL back.

  - **Never resolve a `_journal.json` or snapshot conflict by hand** — keeping both sides' entries, renumbering `idx`,
    reordering them. The migrator applies by date: an entry dated before one a database already ran is never run there.
  - **Never change a committed migration**, not even to fold the base branch's migration into it under the same name or
    date: a database that already ran it never runs the added statements. A new schema change is a new migration.
  - Check with `npx vitest run tests/unit/migration-history.test.ts`: it fails on a journal whose dates do not strictly
    increase, and on a fresh SQLite database that no longer matches the latest snapshot.
- Startup migrates through `applyMigrations` (`server/database/migration-history.ts`), which compares
  `__drizzle_migrations` with the journal first. A matching history goes through the Drizzle migrator; a diverged one
  (rows from another branch, a migration dated before the latest applied one, a file changed after it ran) is
  repaired in one transaction and checked against the latest `meta/NNNN_snapshot.json`. The snapshot is the reference,
  so a fresh database must match it — a unit test checks this for SQLite.
- **A partial index serves a query only when the query repeats its condition with literals** —
  ``sql`${testRunsCases.status} = 'passed'` ``, not `eq(testRunsCases.status, 'passed')`. A bound parameter cannot be
  matched to the index's constant by PostgreSQL's cached generic plans or by SQLite's planner, and the query falls
  back to reading every row. The capability probes (`shared/handlers/setup-status.ts`) and the `fixme` count
  (`fixmeSkipPredicate`) rely on this.
- **`test_runs.origin` is `runOrigin(metadata)`**: every insert or update that writes a run's `metadata` writes
  `origin: runOrigin(<the same value>)` beside it, as `branch` follows `resolveRunBranch`, and a query reads a run's
  origin from the column — `notLabRun(testRuns.origin)`, `runOriginIn(testRuns.origin, …)`, `eligibleRunSql` — never
  from the metadata text. `tests/unit/run-origin-column.test.ts` fails on a write that leaves it out.
- Dates are stored as Unix timestamps in SQLite.
- **Large per-case text payloads MUST go through `case_payloads`** (content-addressed, deduped per project):
  `upsertCasePayloads` on write, `inlineCasePayloads` / `resolveCasePayloadContents` on read (`server/utils/case-payloads.ts`).
  Never add a new fat inline text column to `test_runs_cases`. Legacy inline columns stay readable (readers coalesce
  payload → inline) and the demo writer keeps writing inline, which permanently exercises that fallback. GC lives in
  `server/utils/retention.ts`.

## Authentication & authorization

- **Auth is optional**, enabled by `PIWI_AUTH_ENABLED=true`. When disabled `requireAuth()` returns a virtual
  administrator (`ADMIN_ACCESS`), so every endpoint keeps working and the UI allows everything.
- Two methods when enabled: session cookie (browser) or API key (Bearer / `X-API-Key`, `pd_` prefix). **An API key
  carries its owner's access** (instance role and project roles), nothing more and nothing less.
- **`/mcp` takes a third: an OAuth access token** (`pdo_`), from the authorization server MCP clients sign in through
  (`server/utils/mcp-oauth.ts`, the `/.well-known/*` and `/oauth/*` routes, design record `proposals/mcp-oauth.md`).
  Only `requireMcpAuth` accepts it, never `requireAuth`, so the REST API refuses it; keep it that way. Each grant owns
  an `api_keys` row named after the client, whose value is never handed out: it carries the access, the write log
  names it, and deleting it ends the grant (foreign-key cascade). Every 401 from `/mcp` carries the
  `WWW-Authenticate` challenge clients discover the server from. **The authorize endpoint never redirects an error
  to the client's redirect URI**: registration is open, so that would make the instance an open redirector; every
  refusal lands on the consent page, and only the user's Allow or Deny sends the browser to the client.
- **The model lives in `#shared/permissions`** (pure, shared by the server, the MCP tools, the demo and the UI; design
  record `proposals/roles-and-groups.md`): instance roles `InstanceRole` (`administrator`, `member`; stored in
  `users.role`), project roles `ProjectRole` (`viewer`, `contributor`, `maintainer`, `project_admin`, `uploader`),
  permissions `Permission` (`ProjectPermission` | `InstancePermission`, named `resource:action`) and the matrix
  `ROLE_PERMISSIONS`. Use the enums and types, **never raw string literals** in code; route meta is the one exception
  (below). Labels and one-line descriptions for the UI are `INSTANCE_ROLE_LABELS`, `PROJECT_ROLE_LABELS` and
  `PROJECT_ROLE_DESCRIPTIONS`.
- **Role bindings** (`role_bindings`): a user or a group (exactly one of `user_id` / `group_id`) holds one project role
  on one project, or on all projects, present and future (`project_id` null). Groups (`groups`, `group_members`) do not
  nest and carry project roles only, never the instance role. A user's permissions on a project are the union of every
  role they hold there, directly or through their groups; there are no deny rules. The data layer is
  `shared/handlers/role-bindings.ts` and `shared/handlers/groups.ts`, shared with the demo.

### Per-route permissions are declared once, in the route meta (MUST follow)

A route's `defineRouteMeta` declares what it needs in `openAPI['x-required-permission']`, and that single literal drives
**both** the `/docs` display and enforcement: `requireAuth(event)` reads it from the compiled route metas
(`server/utils/route-required-permission.ts`, matched with rou3 exactly as Nitro dispatches).

```typescript
defineRouteMeta({ openAPI: { tags: ['Failure Clusters'], summary: '…', 'x-required-permission': 'triage:write' } });

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'failure cluster ID');
  // requireAuth runs inside; the route's permission is checked on the cluster's project
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');
});
```

- **Values:** one permission (`'triage:write'`); an inline array, where any one suffices; or `'signed-in'` for routes
  any signed-in user may call (their profile, API keys, dashboards, channels, subscriptions). Omit the field only for
  public or token-authenticated routes.
- **It MUST be inline string literals.** Nitro's meta extractor only folds inline `ObjectExpression` /
  `ArrayExpression` / `Literal` nodes, so a variable, a function call or an imported constant is silently dropped.
- **`requireAuth(event)`** identifies the user, loads their `AccessSummary` once per request (`event.context.access`:
  instance role, roles on all projects, roles per project, own and through groups) and applies the early check
  (`passesEarlyCheck`): `signed-in` and `project:read` pass for any signed-in user, an instance permission needs an
  administrator, any other project permission needs that permission on at least one project. It refuses with 403
  before any database work; it is never the per-project decision.
- `requireAuth(event, permission)` is an **explicit override** for handlers computing their own authorization (e.g.
  `users/[id].patch.ts` self-or-admin); the meta then documents but does not drive it.
- Streaming endpoints (`start`, `events`, `finish`, `case-files`) keep **stream-token** auth instead of `requireAuth`.
  A run stores its main stream or setup token only as a digest (`streamTokenDigest`, checked with `matchesStreamToken`),
  and no response carries `test_runs.stream_token`: a handler returning run rows selects `publicRunColumns()`.
- **No CORS, and no cross-site writes.** `server/middleware/cross-site.ts` refuses any state-changing request whose
  `Sec-Fetch-Site` is `cross-site` or `same-site` (browser extensions excepted), and no route sends
  `Access-Control-Allow-Origin` except trace archives for the hosted trace viewer. Browser clients are same-origin
  pages or Piwi Picker's background worker; everything else (reporter, CLI, MCP, IDE clients) sends no browser metadata.

### Project-level permissions

The early check only says the user holds the permission _somewhere_. The project helpers in
`server/utils/project-access.ts` make the real decision, with the route's permission:

- `requireProjectAccess(event, projectId)` and `requireResolvedProjectAccess(event, id, resolve, label)`: a project
  the user cannot even read → 403 "No access to this project"; readable without the route's permission → 403
  "Insufficient permissions".
- **Route `:id` is the project id** → `requireRouteId(event, 'id', label)` then `requireProjectAccess`.
- **Scoped by a child entity** (run, case, cluster, test-run-case, diagnosis) →
  `requireResolvedProjectAccess(event, id, resolveXProjectId, notFoundLabel)`. It resolves the project, 404s a missing
  entity, then authorizes, and returns `{ db, projectId, user }` so no second `getDatabase()` is needed.
- **`getProjectScope(db, user, permission = 'project:read')`** → `'all' | Set<number>`, the projects where the user
  holds `permission`. List handlers take it (`listProjects(db, scope)`, `getProjectMenu`, `getRecentTestRuns`,
  `searchProjectsTestRunsCases`); an empty set returns `[]` immediately.
- **A write route that authorizes through a scope MUST pass its permission**:
  `getProjectScope(db, user, 'triage:write')`, then `scopeAllows(scope, projectId)`. The default scope is every
  readable project, so someone who reads project A and triages project B could otherwise triage A. Creating a project
  on first submission needs `run:submit` on all projects (`scope === 'all'`).
- `tests/unit/route-permissions.test.ts` checks every route's meta value and these calls.
- Plain `requireAuth` is only for routes with no project scoping (instance permissions, `signed-in`).
- **The UI asks `useAuth().can(permission, projectId?)` or `canAnywhere(permission)`**, built on the `AccessSummary`
  that `/api/auth/me` returns. It is an affordance only (hide or disable a control); the server decides. With
  authentication off everything is allowed (virtual administrator).
- **Safety rules:** the last administrator cannot be demoted; a Project admin edits role bindings only on projects
  where they hold `project:members`, never on all projects; changing a user's instance role bumps `sessionEpoch`,
  while project role and group changes take effect on the next request since access is loaded per request.

### OpenAPI annotations

Every endpoint gets a `defineRouteMeta({ openAPI: … })` block — non-negotiable, it is what feeds `/_openapi.json` and
`/docs`. Public endpoints declare `security: []`; everything else inherits the root-level
`security: [{ bearerAuth: [] }, { sessionCookie: [] }]` from `nuxt.config.ts` (whose `meta` is cast `as any` to allow
those fields — intentional).

## UI conventions

### Reuse the shared primitives

`app/components/shared/` holds the building blocks — **prefer them over re-implementing**. `SectionCard` /
`CollapsibleSectionCard` (headers + folding), `EmptyState` / `LoadingState` / `ErrorState`, `StatTile` + `StatTileGrid`
(never hand-rolled tile markup), `FiltersBlock` + `FilterBar`, `FilterToolbar`, `TableScroller`, `NavbarActions`,
`BreadcrumbNav`, `ChartCard`, `DurationValue`, `ErrorText` (never print a raw error string — it carries ANSI codes),
`DiffPatch` / `DiffFile`, `HelpHint`, `DocLink`, `EnvManagedBadge` / `EnvManagedAlert`, `SettingsField`,
`OpenInIdeLink`. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for what each one does.

### Responsive / mobile (MUST follow)

The app must be usable at **~375 px with no horizontal page scroll**. Write mobile-first (stacked/narrow default, add
`sm:`/`md:`/`lg:` upward) and **never hide data** with `max-sm:hidden` — hide decorations only. For wide tables use
either a `md:hidden` card list + `hidden md:block` table (preferred for dense tables, see `ProjectTrendTable`) or a
`TableScroller`. On fixed-height detail layouts the mobile view must scroll as one document — never `overflow-hidden`
clipping a tall summary; `DetailPageLayout` handles this. **Verify new or changed screens at 375 px before committing.**

### Feature screenshots (MUST follow)

Every change that adds or visibly reworks user-facing UI ends with screenshots of the result: add or update a scene in
the `SCENES` registry of `scripts/take-feature-screenshots.mjs`, run it (`node scripts/take-feature-screenshots.mjs
<scene>` — it boots its own dev server, or pass `--url` to reuse one), and attach the captured images to your final
report or PR. Scenes tagged `desktop` write to `.screens/`, which is **gitignored — those images are a report artifact,
never committed**; the scene, kept current, is what's committed.

**Always send those screenshots to the user in the conversation too — not only attach them to the PR.** A user-facing
change is never reported as done without the pictures. When the change alters existing UI, send the before and the
after; capture both narrow (~390 px) and wide (~1280 px) when the change is about layout or responsiveness.

Scenes tagged `docs` are the exception: they write the committed illustrations in `apps/docs/public/screenshots/`, so
the scene name _is_ the image name and `npm run app:screens:docs` regenerates every one of them.

**Every scene declares the surface it captures** via `mode`: `web` (the default) is the dashboard as a browser serves
it; `tour` is the web server with the demo's guided tour switched on (`NUXT_PUBLIC_DEMO_TOUR=true`), for scenes of the
tour itself; `desktop` is the Tauri shell — the server runs with `NUXT_PUBLIC_DESKTOP=true` and the built-in mocked
Tauri bridge is injected, so no shell build is needed (shape the mock per scene with `link` / `inspection`). Pick `web`
for anything a browser user sees: desktop-only chrome such as the sidebar's back/forward pair would otherwise
misrepresent the app in a full-viewport capture. A run covering several modes boots one server per mode, web first.

| Command                          | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `npm run app:screens -- <scene>` | Capture one scene (add `--url` to drive a server you already have) |
| `npm run app:screens:docs`       | Regenerate every committed docs illustration                       |
| `npm run app:screens:check`      | Fail if a docs image has no scene, or a scene's image is missing   |
| `npm run app:screens -- --list`  | Every scene with its mode, tags and the files it writes            |

**Target elements, not DOM shape.** A scene points at a `data-shot="…"` attribute placed on the container the image is
actually about (`of: '[data-shot="flaky-table"]'`), never at an XPath or nth-child path. Treat the attribute list as a
small API the harness depends on: add one when a scene needs it, keep the name describing the content, and do not
remove one without updating the scene. Capture waits on `settle()` (fonts, network, nothing still loading) rather than
on a timeout, and a capture that would not fit the viewport is an **error naming the viewport to use** — never a
silently cropped image.

`--freeze-now <iso>` pins the browser clock so relative timestamps stop moving and two runs produce byte-identical
PNGs; combine it with a freshly seeded database when a diff needs to mean a real UI change.

Annotations (boxes, arrows, numbered steps, callouts, spotlights, redactions) come from `scripts/screenshot-annotations.mjs`
— an in-repo SVG overlay, no runtime dependency. A scene with an `annotate` list writes both the plain image and a
`-annotated` one, so a docs page can choose. The label text is baked into the PNG, so keep it short and expect a
recapture to change it.

### Inline help (MUST follow)

Any new **block-level** shared component with a header MUST accept an optional `help?: HelpTopicKey` prop (typed from
`app/utils/help-content.ts`) and render `<HelpHint v-if="help" :topic="help" />`. Add copy by adding one entry to the
`HELP_TOPICS` registry — never hardcode hint strings at call sites. Hint text is Markdown (`app/utils/help-markdown.ts`):
put identifiers and commands in `code`, and when a hint can't stay to 1–2 sentences, give it a lead sentence and a
`- **Label** — …` list instead of a wall of prose (it then opens wider and scrolls). Document only non-obvious blocks
(skip counters, search boxes, basic CRUD forms, theme switcher). When adding a hint, **remove the always-on prose it
replaces** so the page gets quieter. If a `PIWI_*` env var can override the setting, set `envVars: [...]` (typed `PiwiEnvVarName[]`) so
the popover surfaces it for system admins.

Use `i-lucide-circle-help` for help and reserve `i-lucide-info` for informational/empty-state callouts. A topic's
`title` becomes the accessible name `Help: <title>` — avoid titles that are substrings of nearby button labels, or
Playwright's substring `getByRole('button', { name })` matches both.

### Settings surface (MUST follow)

Settings pages are driven by the `SETTINGS_PAGES` registry in `app/utils/settings-metadata.ts`; `useSettingsNav` and
`useSettingsEnvState` derive from it. To add a page or field: (1) add the env var to `shared/piwi-env-vars.ts`,
(2) add or extend the `HELP_TOPICS` entry with its `envVars`, (3) add the `fields` entry to `SETTINGS_PAGES`,
(4) render with `SettingsField`. Never hand-roll an env-managed `UAlert` or lock icon — use `EnvManagedBadge` /
`EnvManagedAlert`.

### UTable (MUST follow)

- **Always use template slots for cells** — never `cell:` callbacks with `h()` / `resolveComponent()`. The only
  exception is `createSortHeader<T>()` in `header:`. No `import { h, resolveComponent }` in table components for cells.
- Slot naming: `#${accessorKey}-cell="{ row }"` (or `#${id}-cell` for id-only columns); headers `#${accessorKey}-header`.
- Every sortable column uses `createSortHeader<T>('Label')` (`app/utils/index.ts`); non-sortable ones use a plain string.
- Sticky headers: the `sticky` prop + a `max-h-*` class on the table root. Do **not** wrap tables in `overflow-y-auto`.
- Row highlighting: `:meta="{ class: { tr: '…' } }"` — **not** `:row-attrs`, which Nuxt UI v4 dropped.
- Actions column: `{ id: 'actions', header: 'Actions' }` plus right-aligned `#actions-header` / `#actions-cell` slots.
- **Never `header: ''`.** An empty-string header hydrates as a mismatch (tanstack's `FlexRender` renders a bare `''`
  that Vue cannot place). A column without a visible title gets a real label and renders it through its header slot:
  `header: 'Actions'` plus `<template #actions-header><span class="sr-only">Actions</span></template>`.
- A table with ≥5 columns needs the mobile treatment from the responsive rule above.

### Typography and emphasis (MUST follow)

A screen is read top to bottom; emphasis tells the reader where to look, and it only works when it is rare. These
rules apply to every block a page opens on and to any card that states facts (the situation block, page headers,
summaries, list rows). Dense tables and code views are exempt only where a rule says so.

- **Four text styles per block, no more**: a heading (`text-lg sm:text-xl font-semibold text-highlighted`, at most
  one per block), a body (`text-sm text-highlighted leading-relaxed`, every sentence), a label (`text-sm font-semibold
text-highlighted`) and a meta style (`text-xs text-muted` — qualifiers, facts, footers). Code — a locator, a path, a
  commit — is the body or meta style in `font-mono`. One exception: the commit range of a _What changed_ setup gap
  (`a1b2c3d..e4f5a6b since the last passing run`) is a line of meta facts with no sentence, and keeps the meta font
  so the cluster block stays within its text-style budget. Nothing else in the block: no `text-toned`/`text-dimmed`
  mixed with `text-muted`, no italics, no uppercase micro-labels, no `font-semibold` on a sentence.
- **Structure with layout, not with styling.** A block with several kinds of lines gets one label column
  (`SituationBlock` renders a `<dl>` with an 8 rem label column), so the reader scans labels, not formatting. A badge,
  a color or a bold span is never what tells two lines apart.
- **The situation block reads explanation, action, context**, in the one order of `SITUATION_ROWS`
  (`app/utils/situation-rows.ts`): _Most likely_ first, then _State_ right above _Next_, then the context lines, the
  cluster and its ticket first (the execution page's _Cluster_ line ends with the ticket, the cluster page's _Issue_
  line holds it). A page fills the lines it has and never reorders them; a new line takes its place in that list.
  Facts about the execution itself (since when, whether it is the latest) are the meta line under the headline.
- **The situation block's left edge carries the page's status color** (`SituationBlock :edge`): the execution's
  outcome color, the cluster state's dot color. It is the status, not an accent, and nothing else in the block
  repeats it.
- **One accent color per screen: the primary action.** The solid `color="primary"` button is the only saturated
  element the reader is meant to click. Every other button is `color="neutral"` — `variant="outline"` for a secondary
  action, `variant="ghost"` for a disclosure or a menu trigger. No `warning`, `success` or `soft` buttons for ordinary
  actions. A selected tab, a pressed switch or a selected row is neutral too, never `primary`: `SELECTED_TAB_CLASS`
  (`app/utils/index.ts`) for a tab strip, `SEGMENTED_SELECTED_CLASS` for a segmented control or view switch,
  `SELECTED_ROW_CLASS` for the row that picks what the page shows, and `CURRENT_ITEM_RING_CLASS` for the current
  item in a strip of status-colored marks (this execution in its history, this attempt among the retries). On the
  failure pages two tests hold it: `tests/unit/evidence-accent.test.ts` refuses a raw red, orange or green shade and
  a primary class outside `hover:` and `focus-visible:` in the evidence card's and the affected tests' components
  (add a new one to its list), and `tests/failure-page-accent.spec.ts` checks that nothing rendered in them changes
  with the primary color and that the page shows at most one solid primary button. A card's header icon
  (`CARD_ICON_CLASS`, marked `data-card-icon`) is the one exception.
- **Links inside a sentence keep the sentence's color**: `underline decoration-dotted underline-offset-2
hover:decoration-solid`. `text-primary` links belong in navigation lists and tables, not in prose.
- **Badges are for exceptions, at most two per screen** — the status chip and one exceptional state (_Quarantined_, a
  did-not-run cause). A strength, a confidence, an error type, a tag or a mark such as `@fixme` is plain meta text,
  never a chip. Two red chips on one screen is a bug.
- **Icons only where they carry meaning the text does not**: a status dot, a chevron on a disclosure or a menu, the
  check on a copied button. No icon in front of a label, a heading or a fact.
- **Code inside a heading or a sentence of the situation block sits in a chip**: a locator is syntax-highlighted in
  it (`<LocatorCode chip>`, `<FailureHeadline chip>`), a commit keeps the sentence's color (`CODE_CHIP_CLASS`).
  Elsewhere in prose a locator stays plain mono (`<LocatorCode plain>`).
- **Say a fact once, in one style.** When the same fact could be a chip and words, keep the words.
- **Measure it.** `npm run app:measure -- --check` fails when a failure page breaks a budget at 1280×800: at most 15
  text styles in the execution page's situation block and 13 in the cluster page's (a code chip or a diff counts once,
  whatever its token colors), at most 25 controls above the fold (navbar included), at most one solid primary button
  above the fold, and a Next step that copies a code change shows that change in the same block. The measure finds the
  Next action by `data-next-action` and what it copies by `data-copies`: keep both when you move either. Run it before
  committing a change to either page; raising a budget needs a reason in the PR.

### Filters (MUST follow)

- **A page's filters sit in one `FiltersBlock`** (`app/components/shared/FiltersBlock.vue`): a bordered block with the
  _Filters_ heading, the block's help hint and _Reset_ on its header row, folded to a one-line summary of the active
  filters below `sm` (`filterBarSummary`, `app/utils/filter-summary.ts`). `inline` puts a single row of controls on the
  heading's row. Home, a project page and Analytics use it. Never put page filters in the navbar or loose above the
  content.
- **What a filter hides is a note in the block, never an alert.** Its `notes` slot names the count and the action that
  brings the rows back (`HiddenRunsNote`: _Include partial runs_, _Show all branches_); no full-width `UAlert`, no solid
  button.
- **A list's own controls stay with the list**: a search box, status chips, a sort or a window that only one list
  reads go in that list's card or toolbar (`FilterToolbar`), not in the Filters block.
- **The project page's filters are a run scope every tab that reads run history follows** (`#shared/project-run-scope`:
  environments, branches, the branch policy, full runs only). The page passes `projectRunScopeQuery(scope)`, the
  endpoint reads it with `parseProjectRunScope` and its handler adds `projectRunScopeConditions`
  (`shared/handlers/project-run-scope.ts`), so the header, the runs, the catalog, the failures, the Flake Lab and the
  performance tab read the same runs. With no branch picked the scope reads the default branch
  (`projectDefaultBranch`) and the runs that report none, as Analytics does. A new tab or endpoint that reads runs
  takes the scope; a request without its keys keeps its unscoped reading for API callers.

### Test outcome colors (MUST follow)

Passed, failed, flaky, skipped, didn't run and running each have **one** color, everywhere: the `--color-status-*`
tokens in `app/assets/css/main.css` (emerald, rose, purple, zinc, amber, blue). Timed-out and interrupted count as
failed; a pass that needed a retry counts as flaky. Skipped has a second grey, `fixme`, for a `test.fixme()` skip
(`isFixmeSkip` / `fixmeSkipPredicate` in `shared/utils/skip-kind.ts`): a subset of skipped, carved out of the skipped
segment the way flaky is carved out of passed. Never hardcode a status color in a bar, chart, legend, dot, history
cell, timeline bar or filter chip: use `STATUS_PALETTE` / `statusPalette(status, retries?)` from
`app/utils/status-palette.ts` (`bg-status-*` classes for HTML, `var(--color-status-*)` in SVG `style`), the shared
`StatusFilterChip`, and `getStatusColor` for badges (`flaky` is a registered Nuxt UI color). A new outcome view that
needs another shade adds it to the palette entry, not to the component.

Pass rates follow the same rule with one scale: `app/utils/pass-rate.ts` (`passRateTone`, `passRateTextClass`,
`PASS_RATE_TONES`, and `passRateStep` for heatmap-style cells) — good at 90% or more, fair from 50%, poor below, in
emerald / amber / rose. Never write a pass-rate threshold or color at a call site.

### Other UI rules

- Sentence case headings and labels ("Test runs"), relative dates via date-fns (full timestamp on hover), human-readable
  durations (exact ms on hover), `DurationValue` where a tight `210ms` reads better than "0.21 seconds".
- **A duration in an execution's evidence** (a step or a request, on the Timeline, the Network tab or the trace's
  request list) is a `DurationValue`, never `Math.round(ms) + ' ms'`, and is colored only when `durationStandout`
  (`#shared/duration-standout`) says it stands out in its test or against its usual time (the `usual` the timeline
  sends with it, from `getUsualDurations`), in the one tone of `app/utils/duration-tone.ts`. Never color it by a fixed
  threshold at the call site; `tests/timeline-durations.spec.ts` checks which durations stand out, and
  `tests/unit/evidence-accent.test.ts` refuses a raw red, orange or green shade in the evidence card's components. The
  Timeline and the Network tab read the timeline through `useExecutionTimeline`, one key per execution. Web Vitals keep
  their standard rating bands, in `text-error` and the warning tone.
- **Absolute timestamps render client-only**: `prettyDateFormat` output never appears in SSR'd markup (the server host
  and the browser rarely share a time zone). Render the date with `ClientDate`, and wrap title-tooltip spans that bind
  `prettyDateFormat` in `ClientOnly`. The same holds for anything formatted with the browser's locale
  (`toLocaleString()`, `viewerLocale()`): the server formats it in its own.
- **Data several components of one page read under one key** (capability states, the project list) passes
  `dedupe: 'defer'` and `getCachedData: reuseWithinRender` (`app/utils/shared-fetch.ts`). Without them each caller
  fetches again during the server render: the default `dedupe: 'cancel'` restarts a pending request, and nothing is
  reused from the render once it resolved.
- **What the first screen does not need loads in the browser** (`server: false`, `lazy: true`): a counter, a menu's
  contents, a card further down. What it shows, or what would make it jump (capability states hiding a tab), stays in
  the server render.
- **A `useFetch({ server: false })` loading state reads `status`, not `pending`**: the server renders it `idle`, and
  the client starts the fetch before it hydrates, so gate the spinner on
  `status.value === 'idle' || status.value === 'pending'` (see `pages/projects/[id]/locators.vue`) — gating on
  `pending` renders the empty state on the server and the spinner in the browser.
- **Date/time formatting is locale-aware — never hardcode a format.** `prettyDateFormat` and `formatRelativeTime` read
  the viewer's effective locale and time zone from the active prefs holder (`app/utils/locale-format.ts`), set by
  `app/plugins/locale.client.ts` from three layers: the per-browser override (Settings → Localization), then
  `PIWI_LOCALE` / `PIWI_TIME_ZONE`, then the stored instance default, then the built-in `en-US`. Call sites need no
  change — use `ClientDate` / `prettyDateFormat` / `formatRelativeTime` and they localize automatically. The pure
  formatter and the resolution/validation helpers live in `#shared/i18n/locale-format`; format via `Intl`
  (`formatAbsolute`), never a hand-written `M/d/yyyy`. `en-US` output is byte-identical to the historical format, so it
  is the safe default for screenshots and tests.
- **Page-level tab strips MUST use one pattern**: `UDashboardToolbar` + `UNavigationMenu` with `highlight`
  (`DetailPageLayout` is the reference). `DetailPageLayout` already renders it — pages using
  `DetailPageLayout` never touch the strip themselves, and no other page-level strip (UTabs pill, hand-rolled
  tablist) may be introduced. Content-level tab switches inside a card (e.g. an mcp code-client picker) are
  free to differ. The strip is a navigation menu, not an ARIA tablist: panels carry **no** `tabpanel` role,
  the active item carries `aria-current`, and inline `HelpHint`s render beside the strip for the active tab
  (never inside a navigation trigger's label — that nests buttons). The strip carries
  `:ui="{ list: 'overflow-x-auto', root: 'min-w-0', item: 'shrink-0' }"` so it scrolls as one row when the
  tabs overflow instead of shrinking every label to an ellipsis, and **below `sm` it is replaced by a
  full-width `USelect`** (the strip is `hidden sm:flex`) — the horizontal row collapses to unreadable icons
  on a phone. `DetailPageLayout` does both already.
- **A settings surface with many sections uses a vertical section menu**, not a tab strip: Settings
  (`pages/settings.vue`, one route per page) and a project's Settings tab (`ProjectSettingsPanel.vue`, one
  `?section=` per section) put a vertical `UNavigationMenu` (`orientation="vertical"`, grouped with one
  `{ type: 'label' }` row per group, `lg:w-52`, sticky) beside the content from `lg` up, and a full-width
  `USelect` grouped the same way below `lg`. Add a page to the registry (`SETTINGS_PAGES`) or a section to the
  panel's list; never add a horizontal strip back.
- **Spreadsheet exports people click are Excel (.xlsx), never CSV**: build them with `renderXlsx` /
  `plainXlsxTable` from `#shared/reports/render-xlsx` (numbers and dates as typed cells, text never a formula,
  bold frozen header) and save them with `useDesktopDownload().saveBlob`, since a download link does nothing in
  the desktop shell. CSV stays only for machine consumers (the API `format=csv`, `/api/rollups`, the CLI).
  Page code imports the renderer lazily (`await import(...)`).
- **Every search ignores case and accents** (`resume` finds `Résumé`). In memory, compare with `foldText` from
  `#shared/utils/fold-text` on both sides (`foldText(name).includes(foldText(query))`) and mark matches with
  `foldTextWithOffsets`; in SQL use `foldedContains` / `foldedEquals` from `#shared/utils/fold-text-sql`. Never
  `.toLowerCase().includes(...)` or `lower(col) LIKE ...` for a typed search. A `UCommandPalette` /
  `UDashboardSearch` passes `:fuse="{ fuseOptions: { ignoreDiacritics: true } }"`; `USelectMenu` and `UInputMenu`
  already ignore both.
- **Test lists search and order one way.** A list of tests searches with `TestSearchInput` and the language in
  `#shared/test-search` (in memory with `compileTestSearch`, in SQL with `testSearchConditions` from
  `#shared/utils/test-search-sql`), marks matches with `SearchHighlight`, and orders and groups its rows with
  `app/utils/test-list-order.ts` (run order, file order, File + Describe). Never add a second search syntax, a separate
  tag / lock / browser filter control next to it, or another describe-tree builder. A new qualifier is an entry in
  `TEST_SEARCH_FIELD_DEFS` plus its row in `apps/docs/reference/test-search.md` (the drift test checks the page).
- Add a `title` attribute to any control whose purpose is not obvious from its label.
- **Clickable source paths**: render any repo-relative path or `file:line[:col]` with `OpenInIdeLink`, never a bare
  `<span>`/`<code>`. Pass `filePath` (+ `line`/`column`) or `location`, and thread `projectKey` (the Piwi project **id**)
  and `projectName` when in scope so per-project workspace overrides resolve. IDE preferences are a **per-browser client
  preference** (`useOpenInIde`, `piwi-ide-prefs`) — deliberately not in `SETTINGS_PAGES` and with no `PIWI_*` var, since
  the source lives on the user's machine. Only the Piwi JetBrains plugin (`/api/piwi/open`, `PiwiOpenHandler.kt` in
  `apps/jetbrains`) confirms a file opened. The IDE Remote Control probe only shows an IDE is listening, and
  `vscode://` / `jetbrains://` launches are fire-and-forget, so never report a confirmed "opened" for those.
- **Data fetching in tab children**: for self-contained components rendered conditionally, use `watch` + `$fetch` with
  reactive triggers rather than `useFetch({ lazy: true })`, which may not fire before mount. Use `v-if` on tab-switched
  components for clean mount/unmount. Pass props from the page only for data already fetched at page level.
- `DetailPageLayout` renders summary + tab bar + panels; `tabPanelClass` lets a tab with self-scrolling content use
  `overflow-hidden flex flex-col` instead of the default `overflow-y-auto`.

## Environment variables

`shared/piwi-env-vars.ts` is the **single source of truth** for every `PIWI_*` var — name, description, category, type,
enum, default, min/max, `secret`, `relevantWhen`/`requiredWhen`, `since`/`until`, docs anchor. `PiwiEnvVarName`
(`keyof typeof PIWI_ENV_VARS`) is the typed union used everywhere, so a typo is a build error.

**When you add a `PIWI_*` var anywhere (nuxt.config, a server util), add it to `PIWI_ENV_VARS` in the same change with a
`since: '<next release>'` stamp.** `tests/unit/piwi-env-vars.test.ts` fails if a referenced var is unregistered, if a
post-0.14.0 var lacks `since`, or if a recorded `default`/`min`/`max` drifts from the code constants.

Do not enumerate env vars in prose anywhere — link to the registry or the generated
[configuration reference](../apps/docs/AGENTS.md) instead. Two facts worth knowing without opening it: the app runs with **no
env vars set**, and `PIWI_SECRET_KEY` is the master key for AES-256-GCM encryption of DB-stored secrets (AI keys, SCM
tokens) — recommended in production even without auth, falling back to an insecure development default.

### Emitting configuration

Resolved values are rendered into deployment snippets by a family of pure `(entries, opts) => string` emitters:

- `shared/env-format-base.ts` — the shapes (`EnvEntry`, `EmitOptions`), the per-syntax quoting rules and the constants a
  deployment must agree on (`DATA_MOUNT`, `HEALTH_PATH`, default image). No emitter of its own.
- `shared/env-format.ts` — the generic formats (dotenv, shells, compose, `docker run`, Kubernetes, systemd) plus the
  `ENV_OUTPUT_FORMATS` registry, and the **only** module anything outside `shared/` should import.
- `shared/deploy/<provider>.ts` — one module per hosting platform (railway, render, fly, koyeb, coolify), each owning
  that provider's quirks and nothing else.

Adding a provider is: a new `shared/deploy/*.ts`, an entry in `ENV_OUTPUT_FORMATS`, a re-export from `env-format.ts`,
and — if it should ship a committed manifest — a line in `scripts/generate-deploy-manifests.mjs`. These are stateless
functions selected through a data registry, deliberately not classes: there is no per-provider state to hold, and the
registry already provides the polymorphism a factory would.

Modules under `shared/` import each other with `#shared/...` specifiers, never relative paths — that is what lets the
same files load unchanged in Vite, Vitest and plain Node (the generator script relies on the `imports` map in
`package.json`).

## Adding the usual things

- **API endpoint** — a file under `server/api/` using `eventHandler()` + `getDatabase()`, with a `defineRouteMeta`
  `openAPI` block (including `x-required-permission`) and the right access helper from the authorization rules above.
  **No address the browser requests may contain `analytics`** (a route path, a query key or value): uBlock Origin and
  other blockers refuse such requests, and the page then shows nothing. The analytics routes live under
  `/api/widgets`, `/api/dashboards` and `/api/rollups`; `tests/unit/blocked-request-words.test.ts` checks it.
- **Calling an endpoint from the app** — `$fetch` and `useFetch` carry no typed route map (a `types:extend` hook in
  `nuxt.config.ts` empties Nitro's `InternalApi`), so every call site names its response type:
  `$fetch<ApiResponse<typeof import('~~/server/api/…').default>>(…)` with `ApiResponse` from `types/api.ts`, or a
  type of that file or of the shared handler. A call without one is `unknown`, never inferred.
- **Page** — a Vue file in `app/pages/` built on `<UDashboardPanel>`; register it in the nav links array in
  `app/layouts/default.vue` if it belongs in the sidebar. A page showing one entity (`[id].vue`) calls
  `showPageLoadError(error.value, '<entity>')` (`app/utils/page-error.ts`) right after fetching it, so a missing or
  forbidden id renders the error page and answers 404 or 403, never an empty page with a 200.
- **Component** — a Vue file in the matching `app/components/` subfolder. Auto-import has no folder prefix, so the name
  must be unique repo-wide; follow the reuse and responsive rules below.
- **Unit test** — `tests/unit/*.test.ts` (Vitest). **E2E test** — `tests/*.spec.ts` (Playwright), with any project name
  registered in `shared/test-project-names.ts`.
- **AI test** — an E2E that needs a model goes against the mock OpenAI-compatible server in `tests/ai-diagnosis.spec.ts`,
  so the main suite stays at zero tokens. `tests/live/` is the only place that talks to a real provider: it is excluded
  from `playwright.config.ts`, has its own config, and runs from `npm run app:test:ai:live`. Assume the live model is
  text-only — that suite pins `PIWI_AI_MAX_IMAGES=0`.

## Extension points

Where to add things in subsystems whose wiring spans several files:

| Change                             | Touch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flaky root-cause category          | `classifyFlakyRootCause()` + keyword arrays in `shared/flaky-classify.ts`; persistence and triggers in `shared/handlers/flaky-classify.ts` (`classifyRunFlakyTests`, called from `runFinalizeSideEffects`; `withFlakyRootCauses`, called by the flaky-tests read on the server and in the demo); `rootCause` on `FlakyTest` (`types/api.ts`); `FlakyTestsList.vue` colour map                                                                                                                                                                                                                                                                                                       |
| Flaky impact scoring               | `getProjectFlakyTests` (`shared/handlers/projects.ts`) — sorts by impact desc; `impact`, `wastedCiMinutes`, `avgFailedDurationMs` on `FlakyTest`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Regression signals                 | `computeRegressionSignals()` (`server/utils/compute-regression-signals.ts`), fired by the shared finalize helper `runFinalizeSideEffects` (`server/utils/run-finalize-side-effects.ts`); surfaced by `getTestRun` / `getTestRunCase` mappers                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Finish-time side effects           | Every complete-run ingest path (`finish`, `upload` new-and-attach, `submit`) routes finalization through the one probe-aware `runFinalizeSideEffects` (`server/utils/run-finalize-side-effects.ts`): the environment-incident check first (`recordRunHealth`, `shared/handlers/run-health.ts`; a flagged run sends one `environment.incident` in place of the verdicts), then regression signals, auto markers, flaky root causes, AI diagnosis, notifications, PR feedback, auto-heal. A `finalizing` run reaches it through `settleFinalizingRun` (`server/utils/finalizing-runs.ts`), from its report upload or the stale-run sweep. A probe-stamped run stays silent everywhere |
| A computed AI-context section      | Update the `SectionId` union (`ai-context.types.ts`), `DIAGNOSIS_SECTIONS` (`diagnosis-sections.ts`) and `DiagnosisContextCoverage` (`types/api.ts`) **in one batch** before writing the section builder                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Sharding behaviour                 | See the sharding invariants below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Blob-report import                 | `server/utils/blob-report.ts` (parse) + `import-evidence.ts` (recovered evidence); everything after parsing in `shared/handlers/import-runs.ts`; endpoints `test-runs/import[.post]` and `import/check.post.ts`; page `projects/[id]/import.vue` + `useBlobReportImport`                                                                                                                                                                                                                                                                                                                                                                                                            |
| Trace-file import                  | `server/utils/trace-import.ts` — reconstructs an execution from a trace's `context-options`/`error` events; grouped into one run by the `importGroup` field on `test-runs/import.post.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Quality report language            | Its code in `shared/reports/languages.ts`, the `lang` enum of `server/api/reports/preview.get.ts` (a literal the test checks) and a `shared/reports/sentences.<code>.ts` implementing `ReportSentences` (copy `sentences.fr.ts`), registered in `REPORT_SENTENCES`; validation, the MCP tool, the pickers and the CLI follow. `tests/unit/report-languages.test.ts` names the labels, metrics and gap titles the file lacks, and a new gap detector needs a sample in `tests/unit/gap-title-samples.ts`. The PDF's standard fonts write Windows-1252 only                                                                                                                           |
| Issue automation criterion         | The rule field and its check in `shared/integrations/automation.ts` (`AutoCreateRule`, `resolveAutoCreateRule`, `evaluateAutoCreate`, `describeAutoCreateRule`); the fact it reads in `gatherAutoCreateFacts` (`shared/handlers/tracker-automation.ts`, shared with the demo preview); the form in `app/utils/tracker-binding-form.ts` and `AutoCreateRulesEditor.vue`; the table on `apps/docs/features/issue-automation.md`. The run trigger (`server/utils/integrations/automation.ts`) and the write-back scope (`policies.ts`, `tracker-run.ts`) read the rules, never re-implement them                                                                                       |
| Guided tour stop / role / language | A stop: its entry in `TOUR_PROFILES` (`app/utils/demo-tour/profiles.ts`), its title and body under its id in every `copy.<code>.ts`, and the `data-tour` attribute it targets. A role: its id in `TourProfileId` (`types.ts`), its `TOUR_PROFILES` entry, and its label, hint and stops in every copy file. A language: its code in `TOUR_LANGUAGES` and `TOUR_LANGUAGE_INFO` (`languages.ts`), and a `copy.<code>.ts` registered in `TOUR_COPY` (`copy.ts`). A role or language is also named in the _Live demo_ paragraph of `apps/docs/features/ui-overview.md`. Rules under [Guided tour](#guided-tour)                                                                         |

## Subsystem invariants

These are the rules that a reasonable change would otherwise break.

### SCM providers — one source for hosts and URLs

Provider hosts and web URLs live only in `shared/scm-urls.ts` (`detectScmHost`, `commitUrl`, `compareUrl`,
`fileUrl`, `branchUrl`); provider API calls live only in `server/utils/scm/`. Anything that needs a provider gets it
from `createScmProvider` / `scmProviderForUrl` (or the pure link helpers from `#shared/scm-urls`) — never a hand-written
`github.com` / `gitlab` / `bitbucket.org` host switch or a re-implemented `/commit/<sha>` path. Import the
`ScmProviderName` union from `#shared/scm-urls`; never re-declare `'github' | 'gitlab' | 'bitbucket'`.
`tests/unit/scm-single-source.test.ts` scans `server`, `shared`, `app` and `types` for provider host literals and the
union outside an explicit allow-list, so a new home for either is a visible diff to that list.

On the desktop app with no SCM token, `createScmProvider` returns a `LocalGitProvider` (`server/utils/scm/local-git.ts`)
for a project linked to a clone of the repository: it reads history with git in that folder and wraps the host's own
provider for the rest. A method added to `ScmProvider` must be added there too — a read tries git first and falls back
to the host, anything else is passed to the host. The base class's no-op defaults compile without it, and would
silently turn the feature off on the desktop app.

### Failure clustering & fingerprints

The grouping key is `computeErrorFingerprint` (`shared/error-fingerprint.ts`) over error type + normalized message +
masked locator. **The stack frame is intentionally NOT hashed** (kept as `topFrameFile` for display) so one root cause
groups across spec files. Add volatile-token masking inside `maskVolatile` (message) / `maskSelector` (locator).

When you change normalization, **bump `FINGERPRINT_VERSION`** and keep the demo mirror
`shared/demo/demo-fingerprint.mjs#computeDemoFingerprint` in sync — a regex-for-regex plain-Node port that exists
because the seed script runs under plain Node and cannot resolve the TypeScript module. A version bump is
**non-destructive**: `reclusterFailureFingerprints()` re-fingerprints existing clusters from their stored `sampleError`
on startup, updating in place or merging collisions via `mergeFailureClusters()`, so triage state survives.
Re-run `npm run app:seed:demo` afterwards.

### Timed-out tests fold into `failedTests`

There is no `timedOutTests` column on `test_runs`. Timed-out cases (`'timedOut'` per-case from Playwright; `'timedout'`
in the declared `TestCaseStatus` union) fold into `failedTests` so `total = passed + failed + skipped + didNotRun`
reconciles and matches the UI. **Every ingest site MUST use the helpers in `shared/utils/test-counts.ts`** —
`sumFailedAndTimedOut(body.failedTests, body.timedOutTests)` for body-field sites (`finish`, `submit`, `upload` + the
demo `app/demo/api/reporter.ts` mirror) or `countFailedFromTally(insertedStatusCounts)` for per-status-tally sites
(`events` + its demo mirror). Never write `failedTests: body.failedTests` directly.

### Locator healing

Ranked replacement locators for a broken selector. Pure generation/scoring/fingerprint logic lives in
`@piwitests/core` (`locator-generation`, `locator-fingerprint`, `locator-healing-types`), re-exported by the `shared/*`
shims for `#shared/...` and bundled into the reporter by tsup. **There is no hand-mirrored copy** —
`tests/unit/reporter-core-identity.test.ts` asserts the reporter re-exports the exact core functions, so a
re-implementation fails the suite.

Rules when touching it:

- **Capture** happens in the reporter fixtures (mirrored by the dogfood `tests/fixtures.ts`). The in-page probe
  `probeElementAttrs` is serialized into the browser via `evaluate`, so it cannot reference module closures: the ARIA
  role maps (`TAG_TO_ROLE` / `INPUT_TYPE_TO_ROLE`) arrive as fields of the `evaluate` argument — **do not re-declare
  them inside the probe**, and have the dogfood fixture import and call it rather than re-inlining.
- The live input `value` is **deliberately never captured** (secret leak).
- Snapshots ride the wire as the transient per-case `locatorSnapshots` field (`shared/types.ts`, **never a column**);
  every ingest site passes it to `persistRunCases` → the shared `upsertLocatorSnapshots` (`server/utils/locator-healing.ts`,
  used by server **and** demo). **Two invariants live in that helper:** rows are deduped by `(caseId, location)` before
  the batch upsert (a repeated call site otherwise breaks PostgreSQL's `ON CONFLICT DO UPDATE`), and the stale-location
  purge runs **only for cases whose run passed**, so a run that failed early does not delete valid prior-success rows.
- `elementAttrs` inside `upsertLocatorSnapshots` is the **storage whitelist** — a new wire field on
  `LocatorSnapshot.element` (e.g. `rolePosition`, `ancestors`) must be folded in there or it is silently dropped.
  No migration needed.
- Chained alternatives carry the **leaf** method with flat args (`anchorTestId` / `anchorSelector` / `anchorRole`) and
  **never a `name` key** — `fingerprintFromSnapshot` reads the element name from the first `getByRole` alternative's args.
- The signature must hash identically on both sides: capture via `locatorSignature(method, args)`, look up via
  `locatorSignatureFromExpression(expr)` (`shared/locator-healing.ts`).
- **Stale gating:** when the stored fingerprint's name is provably gone from the failing ARIA, `resolveStoredHit` sets
  `priorNameMayBeStale` and excludes the failing locator and old-name-derived alternatives from the recommendation pool
  (an empty pool yields `recommendation: null` — never a stale pick). `LocatorHealingPanel.vue` MUST NOT recompute a
  client-side recommendation when that flag is set; it would resurrect the stale pick.
- Dashboard picks persist via the shared `saveLocatorPick`: the failing locator's identity is re-derived **server-side**
  from the stored error with the same helpers the lookup ladder uses — never trust client-parsed args. A pick that
  cannot be keyed returns `not-persisted` (surfaced as a toast) rather than being silently dropped. Anyone who can read
  the project may save one, so the endpoint declares `project:read`.
- Re-run `npm run app:seed:demo` after changing the captured or stored shape.

### Workers timeline rendering

A run's timeline draws one SVG shape per test, hook section and gap — thousands on a large run — and a zoom
re-positions each drawn one. Keep every interaction proportional to what changed:

- Hover state lives in one reactive object that only `TimelineTooltip` and `TimelineFocus` read; `WorkersTimeline`'s
  template passes the object, never its fields, so hovering never re-renders the bars.
- Dim the other bars with `TimelineFocus` (one wash plus a copy of the hovered bar), never with per-bar classes,
  styles or a `:has(:hover)` rule, which restyle every shape on each hover.
- Bar props stay referentially stable when nothing changed (`NO_LOCK_COLORS`, `NO_HOOKS`, `timelineStatusFill`); a
  fresh `[]` or `{}` per render re-renders every bar.
- A test's hook sections are drawn by the test's own `TimelineBar`, not as bars of their own; only bars inside the
  viewport's `renderRange` are drawn.
- The resource tracks (`TimelineResourceBand`) and the strips under each worker (`TimelineWorkerStrips`) build each
  path once in milliseconds and take the zoom from their group's `scale()` transform, so a zoom never rebuilds them.
  Their hover lives in its own reactive object, read only by `TimelineResourceTooltip` and `TimelineResourceCursor`.
  Where every lane, band and strip sits comes from one `layOutTimelineRows` (`app/utils/resource-tracks.ts`), which
  the viewport reads through `laneOffset`; anything new drawn between the lanes is added there, never offset by hand.

### Sharding

- **runLabel** comes from `resolveRunLabel` (`packages/reporter/src/internal/support/ci.ts`), used by the reporter and
  `createGlobalSetup` alike: `PiwiDashboardOptions.runLabel` as is, else the CI pipeline id from env vars (GitHub adds
  the run attempt), plus the CI job id for a run that is not sharded, so parallel jobs of a pipeline stay apart.
- When `runLabel` is set, `computeInstanceId(projectName, runLabel)` replaces the `hostname|projectName` key so all
  shards share one instanceId.
- A shard's identity is Playwright's `config.shard`, or the `i/n` in `PIWI_SHARD` that `piwi run --shard` sets because it
  narrows the tests itself and gives Playwright no `--shard`; the reporter reads both through `resolveShardInfo`
  (`packages/reporter/src/internal/support/shard-info.ts`) for `/setup`, `/start` and `/finish`. A run with no shard
  identity starts non-sharded and cancels every running run of its `instanceId`.
- Each shard gets its own stream token, kept as its digest (`shardTokenDigest`) in `RunEventBus.runStates[id].shardTokens`
  and in the run's `metadata.shardTokens`, which project members can read. **Any new streaming endpoint MUST validate
  shard tokens alongside the primary one** — check `matchesShardToken(cachedState.shardTokens, body.streamToken)` as a
  fallback, via `validateAndReviveRun()` with the `isShardToken` callback; never compare against the set directly.
- **A run's shard tokens are merged, never replaced** — in the cache or in `metadata`. Every shard's setup token stays
  valid until that shard calls `/begin`, which swaps it for the shard's stream token; read the set with
  `knownShardTokens` (cache and metadata together) and write it back with `withShardTokens`.
- Server-side merge: `/start`, `/setup` and `/submit` reuse an existing run when `shardTotal > 1` and an active run with
  the same `instanceId` exists, and `/begin` on a run another shard already began joins it (a stream token of its own,
  its planned tests added to `totalTests`); `/finish` accumulates counters with SQL `+` and only sets the final status
  when `shardsFinished === shardTotal`. `cancelInstanceRuns()` skips sharded runs when `isShardedRun: true`.

### Trace storage compression

Trace evidence is compressed at rest, transparently. Two rules keep it that way:

- The shared resource pool (`project-<id>/trace-resources/`) stores text resources gzip-wrapped in a
  self-describing container (see `server/utils/resource-compression.ts`). **Every read of a pool resource
  MUST pass the bytes through `decodeResource`** — reconstruction, evidence, DOM-snapshot inlining all
  do. Add a new pool reader and you add a `decodeResource` call, or you serve compressed bytes as if they
  were raw. `compressResource` is the only writer; `trace_resources.size` is the on-disk (post-compression)
  byte count. There is no encoding column — the container's magic prefix is the source of truth, so a
  resource that is itself gzip (Playwright can store one) is never double-decoded.
- The persisted slim events blob is built with `buildZip(entries, { compress: true })`; reconstruction
  rebuilds the served ZIP stored (uncompressed) for speed. `buildZip` defaults to stored — pass
  `{ compress: true }` only for the write-once-keep path, never for archives rebuilt on every open.

### Trace pooled entries

Besides `resources/`, ingestion moves a trace's per-action screenshots (`screenshots/`) and screencast frames
(`screencast/`) to the shared pool, under the SHA-1 of their bytes (`<sha1>.png`): their names say which action or
instant they belong to, not what they hold, and many are byte-identical. The blob's manifest maps each such entry
name to its pool name (`pooledEntries`, see `server/utils/trace-manifest.ts`); the aria snapshots stay in the slim
ZIP. A blob whose manifest has no `pooledEntries` holds its screenshots and frames inline; blobs are never rewritten.

- **Every manifest read goes through `server/utils/trace-manifest.ts`** (`readTraceManifest` for a view,
  `parseTraceManifest` + `traceManifestPoolNames` for anything that decides what may be deleted, which must tell a
  missing manifest from an unreadable one).
- **A reader of a `screenshots/` or `screencast/` entry looks in the slim ZIP first, then in the pool through
  `pooledEntries`**, as `readSnapshot` in `trace-evidence.ts` and `reconstructTraceZip` do. Reading only the ZIP
  finds nothing for a blob stored since pooling.

### Trace resource refcounting

Shared pool resources are reference-counted through `trace_blob_resources` (blob ↔ resource), so a partial
delete frees a resource the moment no surviving blob references it (`gcTraceBlobs`), not only when the
project loses its last blob. Two invariants keep it correct:

- **Any blob write MUST record its resource links and then set `trace_blobs.resources_indexed = true`, in
  that order.** The links cover every pool name the manifest references, `resources` and `pooledEntries`
  alike (`traceManifestPoolNames`). `upsertTraceBlob` does this via `linkBlobResources`; the flag flips only
  after the links exist, so a half-written blob is never trusted. A new blob-writing path must do the same, or
  resources it needs can be reclaimed out from under it.
- **Any blob write MUST set `trace_blobs.stored_size`** — the bytes of the blob's own files (slim ZIP plus
  manifest, or the whole ZIP stored as is), which the storage analysis counts. `size` stays the uploaded
  trace's size, shown to users; counting it would count the pooled parts twice. `backfillTraceBlobStoredSizes`
  (startup, after the link backfill) measures every blob whose `stored_size` is null.
- **Per-resource GC only runs for a project whose blobs are all indexed.** Deletes on a project with any
  `resources_indexed = false` blob fall back to the whole-project rule (resources go only when the last blob
  does), because such a blob's links may be missing. `backfillTraceBlobResources` (kicked off at startup
  from `initDatabase`, non-blocking) indexes pre-existing blobs from their manifests; the nightly
  `reclaimOrphanTraceResources` sweeps resources nothing references any more, same gate.

### Reading a stored trace

A view that reads a stored trace goes through `server/utils/trace-evidence.ts` (its `getTrace*FromBlob` views and
`loadStoredTraceEvents`), never `parseZip` on the blob. The slim blob of a Playwright 1.63 trace holds its aria
snapshots (and, when its manifest has no `pooledEntries`, its screenshots and screencast); the loader inflates only the
`.trace`, `.stacks` and `.network` streams, one snapshot entry when a view asks for it (from the pool when the
manifest lists it in `pooledEntries`), and never the screencast. A content-addressed blob
(`project-<id>/blobs/<sha256>.zip`) is loaded once for the requests of one page and kept two minutes after its last
read, within 64 MB for all loaded traces, so a bundle keeps compressed copies of the entries it needs and no closure
over the archive itself. Ingestion reads a trace once and does not go through that cache. A new view adds a function
there; an answer that is a pure function of the trace and costly to build is kept on the loaded bundle, as
`snapshotView` is.

### DOM snapshot live state

The DOM view renders a trace snapshot with the live state Playwright records beside the DOM (`__playwright_*`
attributes; `template` nodes for shadow roots and adopted stylesheets), the same from Playwright 1.60 on.

- **Markup, or a marker the frame applies.** `renderedAttributes` (`server/utils/dom-snapshot-render.ts`) writes what
  markup can hold and turns the rest into `data-piwi-*` markers that `restoreSnapshotState`
  (`shared/snapshot-picker-extras.ts`) applies in the frame. The script is serialized, so both name each marker: a new
  one lands in both, and in `tests/dom-snapshot-state.spec.ts`.
- **A password field's value is always masked** (`PASSWORD_MASK`); every other field value is shown.
- **`restoreSnapshotState` runs first in every frame document** (picker and read-only), before anything installs over
  the page, and moves no keyboard focus out of the dashboard.
- **The reporter's focus, hover and selection apply to the failure-time snapshot only** (`atFailure`,
  `withPageInteraction`): they were read at test end. Their element paths are the format of
  `@piwitests/core/page-interaction`, written by the reporter's `readPageInteraction` and read by the frame script.
- **A trace format change is checked against recorded traces**: `scripts/record-live-state-traces.mjs` records the
  E2E fixtures with any Playwright version; keep 1.60 and the latest.

## Adding a field to test run data

The full chain, in order:

1. `shared/types.ts` — add to the payload(s).
2. Both `schema.sqlite.ts` and `schema.pg.ts` (a large text/JSON field must go through `case_payloads`, not a new
   inline `test_runs_cases` column) → `npm run db:generate && npm run db:generate:pg`.
3. `types/api.ts` — frontend types.
4. All API handlers: `submit`, `upload`, `[id]/events`, `[id].get`, `[id]/stream.get`, `test-cases/[id].get`.
5. `server/utils/persist-run-cases.ts`.
6. **Reporter**: `src/types/collected.ts` (`CollectedTestCase`) + `src/types/wire.ts` (`WireTestCase`), accumulate in
   `src/public/reporter.ts` (`onTestBegin`/`onTestEnd`), project in `src/internal/submit/serializer.ts` —
   `toWireTestCase` for per-case, `serializeRun` for run-level (the single source of truth for the run body, used by
   both `uploadJSON` and `uploadWithFiles`).
7. **Demo**: `scripts/generate-demo-seed.mjs`, `app/demo/api/reporter.ts`, `app/demo/api/test-runs.ts`,
   `app/demo/api/test-cases.ts`, `app/demo/simulator.ts`.
8. UI components that consume it.
9. `npm run app:seed:demo`.

`shared/types.ts` is the wire contract; the server imports it directly. The reporter shares only the **leaf shapes**
via `@piwitests/core/wire` (bundled in, so no monorepo path leaks into the published `.d.ts`) and keeps its own
`WireTestCase`, pinned to the server payloads by `tests/unit/wire-shared-drift.test.ts`. **Never `import`
`apps/application/shared` from the reporter** — use `@piwitests/core`.

## Demo mode

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
(`app/utils/demo-tour/profiles.ts` and every `copy.<code>.ts`, see [Guided tour](#guided-tour)) — then
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

### Guided tour

The demo offers one tour per role (Developer, QA engineer, Product owner, DevOps / platform). A toast asks a first-time
visitor what they do: a role starts its tour, **Later** asks again on a visit a day later, **×** never again, and the
banner's **Guided tour** button reopens it. A tour opens that role's seeded screens one by one, with a driver.js
popover on one element per screen that links its docs page. It speaks English, French, Spanish and German (the
browser's language, or the one picked in the toast); the dashboard stays in English.

`app/utils/demo-tour/` holds the data, all pure: `profiles.ts` (`TOUR_PROFILES`, each stop's `route`, `expect`,
`target`, `unfold`, `side`, `align`, `doc`), `copy.<code>.ts` registered in `copy.ts` (`TOUR_COPY`, every word the
tour says, one file per language), `languages.ts` (`TOUR_LANGUAGES`, `TOUR_LANGUAGE_INFO`, `pickTourLanguage`),
`types.ts`, `markup.ts` (escaping, `**bold**`) and `prompt-state.ts` (what a browser decided, stored under
`localStorage['piwi-demo-tour']`, and when to ask again). `app/composables/useDemoTour.ts` holds the prompt's state and
the language, stores the decision, and drives driver.js across a tour's pages; `app/components/demo/` has `DemoTour`
(host, auto-prompt), `DemoTourPrompt` (the toast) and `DemoTourButton` (banner); `app/assets/css/demo-tour.css` themes
the popover.

- **The switch is `runtimeConfig.public.demoTour`**, on in the demo build and off in every other, and `app.vue`
  mounts the tour only when it is on. `NUXT_PUBLIC_DEMO_TOUR=true` turns it on for a dev server, which is what the
  screenshot harness's `tour` mode does.
- **`data-tour="<id>"` attributes are the tour's API**, as `data-shot` is the harness's: a stop's `target` and
  `unfold` name one. A value is static (never a bound `:data-tour`), kebab-case, names the content, and is set in
  exactly one component. Never remove or rename one without updating its stop: `tests/unit/demo-tour.test.ts` fails
  naming the stop whose target is gone, and names an attribute no stop uses.
- **A stop's `route` opens a seeded screen, and its `expect` names the entity it shows**, in the demo examples'
  vocabulary; `tests/unit/demo-seed-consistency.test.ts` checks it against the generated seed like a demo example. A
  seed change that moves the entity updates the stop, never the check. A stop with no `route` stays on the current
  page (a banner control); the first stop always has one. Every stop has a `doc`, which `docs-drift.test.ts` resolves
  like every in-app docs link.
- **Copy**: `copy.en.ts` is the source, and every other copy file has exactly its keys. A change to the English copy
  updates every language file in the same commit, and adding, renaming or removing a stop touches `profiles.ts` and
  every copy file: the compiler refuses a missing or extra key, `demo-tour.test.ts` an empty string, an untranslated
  body and a stop with no copy. A dashboard label is `**bold**` and stays in English exactly as the screen spells it;
  the test checks that every language names the same bold labels as the English, in order. `**bold**` is the only
  markup, and a translation keeps the English's placeholders. The voice is the docs'
  ([`apps/docs/AGENTS.md`](../docs/AGENTS.md#voice)): informative, specific, never promotional. 4–7 stops a tour; a
  title ≤ 60 characters and a body ≤ 360 in every language. French says _vous_, German _Sie_, Spanish _tú_; product
  names are never translated.
- **A change to a toured screen updates the tour in the same commit**, its copy in every language included, exactly
  like the docs and the demo: moving or renaming a targeted element, renaming a label a stop quotes in bold, a seed
  change under a stop. A new feature that serves a role may replace a stop; it never grows a tour past 7.
- **Adding a language** works like a quality report language: its code in `TOUR_LANGUAGES` and its
  `TOUR_LANGUAGE_INFO` entry, then a `copy.<code>.ts` (copy `copy.fr.ts`) registered in `TOUR_COPY` — the compiler asks
  for the file, then for every key — and its English name in the _Live demo_ paragraph of
  `apps/docs/features/ui-overview.md`, which `docs-drift.test.ts` checks for every role and language.
- **The engine never lets `scrollIntoView` run**: the dashboard scrolls inside its content panel, and
  `scrollIntoView` would shift the layout around it, so the engine scrolls the target's panels itself and stubs
  driver.js's own call on the target and the popover. driver.js, its CSS and `demo-tour.css` load only when the first
  tour starts (`loadEngine`).
- Verify with `npm run app:generate:demo && npm run app:check:demo:runtime`: it walks every tour in the built demo
  (the prompt, **Later**, the banner button, each stop's target highlighted, one tour in French, one at phone width).

## MCP tool conventions (MUST follow)

MCP tools (`server/utils/mcp/tools.ts`, route `server/routes/mcp.post.ts`, definitions `shared/mcp-tools.ts`) return
JSON consumed by AI coding agents; consistency saves the agent from guessing.

**Authorization** — every handler is `(db, params, ctx)` with `ctx: McpContext = { user, scope }` (the route resolves
`scope = getProjectScope(db, user)` once, the readable projects). Every project- or entity-scoped tool MUST enforce scope: `assertProject(ctx, projectId)`
when the arg _is_ a project id, or `checkEntityScope(db, ctx, id, resolveXProjectId)` for run/case/cluster/diagnosis ids
(`'not-found'` → return null/empty; out of scope → throws). Cross-project feeds filter by `ctx.scope`. Write/triage
tools MUST also check, on the project they act on, the permission the same REST action declares
(`assertPermission(ctx, permission, projectId)`, from the `#shared/permissions` matrix): reading a project is not
enough to write to it.

**Reuse** — prefer a shared handler (`#shared/handlers/*`) over re-querying. When a REST endpoint has inline logic a
tool also needs, extract it to a shared handler and call it from both. Never duplicate.

**Field naming** — `id` only for the top-level entity; `testCaseId` for stable test-case identity; `executionId` for a
per-run execution record (`testRunsCases.id`), spelled `testRunsCaseId` inside `affectedTestCases` / `locatorHealing`;
`runId` for run references in sub-entities; always `filePath` (never `file`) and `startedAt` (never `start`/`runStart`).

**Response shape** — list tools and paginated sub-lists return `{ items, nextCursor }` (`PaginatedResponse<T>` in
`shared/mcp-tools.ts`). `dropNulls()` strips `null`, `''` and `[]` before serialization. Error text truncates to 400
chars via `trunc(msg, 400)`.

**Validation** — `numericParam(raw, name)` for every numeric param; `numericCursor(raw)` for cursors (never
`Number(cursor)` inline); `clampPageSize(raw)` (1–50, default 10); `paginatedItems(items, pageSize, getCursor)` to wrap
a `pageSize + 1` fetch. **`getCursor` must read the POST-map field name** (`r.executionId`, not the pre-map `r.caseId`)
— reading a renamed field yields an `"undefined"` cursor that crashes the next page. In-memory-filtered list paths must
apply the cursor in memory on the same axis as the emitted cursor, or paging loops on page one.

**Tools about Piwi itself** — `describe_piwi` and `get_release_notes` (`server/utils/mcp/about-piwi.ts`) answer from
the docs pages and `CHANGELOG.md` bundled as Nitro server assets (`nitro.serverAssets` in `nuxt.config.ts`; the
Dockerfile copies both in) and from the registries the docs site renders — never from prose written for the tool,
so they cannot say anything the docs do not. How this instance is configured (storage, retention, capability
states) is deployment shape, shown to administrators only, like the Setup page.

## Performance

A change to what a page loads or renders is measured with the performance suite (`scripts/perf/`, `npm run app:perf`):
it runs two production builds against a large dataset (1,500 runs, about 475,000 executions) and compares the server
render, the full load in Chromium, the API calls and the SQL each request runs, for the projects list, every project
tab, the test-run page, and a failed execution's page whose test carries the whole history and a 20 MB Playwright 1.63
trace (generated by `scripts/perf/lib/trace.mjs`, uploaded through the real import), with its trace views. CI runs it
on every pull request against the base commit and posts the comparison as a comment. Locally:

```bash
npm run app:build                                     # the build to measure, in .output
node scripts/perf/run.mjs --target base=<a build of main>/.output --target head=.output --scale medium
node scripts/perf/run.mjs --database postgres --pg-url postgresql://postgres:postgres@localhost:5432/postgres …
```

PostgreSQL must load `pg_stat_statements` (`scripts/perf/lib/pg.mjs` has the `docker run` line); with it every
request's statements are counted on any build. The suite also runs each build with OpenTelemetry on
(`server/plugins/opentelemetry.ts`, `server/utils/otel.ts`) to list the SQL of each request and of the requests the
server makes to itself while rendering a page; set `OTEL_EXPORTER_OTLP_ENDPOINT` to see the same traces in a
collector of your own (`apps/docs/operate/tracing.md`).

## Running the app locally to verify a change

The step-by-step recipe, the seeded routes worth opening and the pitfalls live in the `run-app` skill
(`.claude/skills/run-app/SKILL.md`) — read it first. The short form: `npm run app:screens -- --route <path> --expand
--height 2400` screenshots any page against a throwaway server it boots and seeds itself, and `npm run app:seed:dev`
followed by `npm run app:dev:bg` gives you a server on port 3000 to iterate against.

When you need to see a change working — a UI tweak, a flow, a screenshot — run a **plain (non-demo) dev server backed by
a dev DB seeded from the demo data**:

```bash
cd apps/application
npm run app:seed:demo                            # 1. generate public/demo/seed.sql (skip if present)
mkdir -p .data && npm run db:migrate             # 2. create + migrate an empty dev DB (.data/piwi.db)
npm run app:seed:dev                             # 3. load sample data (server must be stopped — DB lock)
NUXT_IGNORE_LOCK=1 npx nuxt dev --port 3002      # 4. plain dev server, auth disabled by default
```

`app:seed:dev` creates and migrates a missing or empty dev DB itself, so step 2 is only needed when you want a clean
schema by hand; it is idempotent (`INSERT OR IGNORE`), and to refresh stale rows wipe `.data` and re-run it. The file
endpoint serves only paths inside a project's folder, so it also moves each seeded `demo/…` media row to
`project-<id>/demo/…` and copies the committed binary (`public/demo/{screenshots,traces,videos}`) there, and the failure
pages serve the real screenshot, trace and video rather than a broken image. The seed itself keeps `demo/…`, the path
demo mode serves from `public/demo/`. Drive the
app with Playwright — `scripts/take-feature-screenshots.mjs` (`--route`, `--url`) is the working harness, and its
`settlePage` is the wait strategy to copy: the run and execution pages hold an SSE stream open, so a bare
`networkidle` never resolves, and the page scrolls inside a panel, so `fullPage` captures a single viewport.

**Caveats that cost real debugging time:**

- **During development, keep ONE dev server on port 3000 and run Playwright against it** — start it with
  `npm run app:dev:bg` (background, waits for readiness, logs to `.data/dev-server.log`, refuses if the port is
  taken by the desktop app). The Playwright config reuses an existing port-3000 server
  (`reuseExistingServer: !process.env.CI`), and Nuxt's HMR picks up your edits, so you iterate without re-booting
  a server per test run. Watch `dev-server.log` for compile errors (a template error shows up there, not in the
  browser); restart only when the server crashes or you touch `nuxt.config`/server plugins. The feature-screenshot
  harness reuses the same server (`--url`). A cold server compiles each page on its first visit, which can take 20 s:
  a spec's first test timing out on a page that renders is that compile, so rerun it against the warm server before
  reading it as a regression.

- **Do NOT use `PIWI_DEMO_MODE=true` for the dev server.** Demo mode builds the static SPA; it is not a `nuxt dev` flag.
  To verify a change _in the demo_, build it and drive the build:
  `npm run app:generate:demo && npm run app:check:demo:runtime`. That serves `.output/public` from the `/demo/` sub-path
  it is really deployed under, with its service worker installed — the only setup in which base-path, worker-scope and
  demo-handler bugs appear. `app:check:demo` alone only compares route patterns, and stays green while every page is
  broken.
- **Anything the UI opens outside `$fetch` MUST carry `useRuntimeConfig().app.baseURL`** — `window.open`, an `href`, a
  download URL. The demo is served from `/demo/` and its service worker only intercepts that prefix, so a root-relative
  `/api/...` escapes the scope and 404s against the static host. `fileApiUrl` and `getTraceViewerUrl` exist for exactly
  this reason.
- **Every seeded run carries its cases**, and every one of the ten clusters has failing executions; project #2
  (`api-integration`) owns clusters 3 and 4. Run and execution ids are stable for a given seed, but query a real one
  rather than guessing: `node scripts/db-query.mjs "SELECT id FROM test_runs_cases ORDER BY id DESC LIMIT 5"`.
- **Brand icons** (`i-simple-icons-*`) resolve from the iconify CDN at runtime; with no outbound network they render
  blank. Only the `lucide` collection is bundled locally. Environment limitation, not a bug.

## Demo evidence media (committed binaries)

Demo screenshots (`public/demo/screenshots/*.png`), trace ZIPs (`public/demo/traces/*.zip`) and failure videos
(`public/demo/videos/*.webm`) are **real Playwright artifacts**, captured against the small self-contained
app-under-test pages in `scripts/demo-pages.mjs` — never a real app, and never the Piwi dashboard itself (traces embed
full page snapshots, and a screenshot of the _results UI_ is not believable evidence of a failing _test_). Each page
mirrors one story in `shared/demo/failure-stories.mjs` closely enough (headings, labels, button names) that the evidence
reads as the same app the seeded data describes.

- Screenshots: `node scripts/take-demo-screenshots.mjs` — serves the fake pages from a throwaway HTTP server, no dev
  server or seeded DB needed.
- Traces + videos: `node scripts/record-demo-media.mjs` — drives each page with a real interaction reproducing its
  story's failure mode, per the `SCENARIOS` table in the script (add an entry for a new story's media). Traces record
  with `sources: true` so the call-stack evidence view has real content.
- Commit the binaries, then `npm run app:seed:demo` to re-wire the `files` rows with real sizes.
- Playwright must be loaded through `createRequire(import.meta.url)` from the repo-root `node_modules` — an ESM
  `import` from outside the workspace fails. Point at the Chromium in `PLAYWRIGHT_BROWSERS_PATH` when the environment
  provides one instead of a downloaded browser.

The seed generator wires media generically: every story with `media.screenshot`/`trace`/`video` attaches it to the
**most recent failing execution of each member case** (`max(test_runs_cases.id)` per cluster+case, matching how
`shared/handlers/failure-clusters.ts` picks `recentTestRunsCaseId`). A story with no `media` intentionally has none.

## Testing the API by hand

```bash
curl -X POST http://localhost:3000/api/test-runs/submit \
  -H "Content-Type: application/json" \
  -d '{"projectName":"my-project","status":"passed","startTime":"2024-01-01T12:00:00Z","duration":120000,"totalTests":10,"passedTests":9,"failedTests":1,"skippedTests":0,"testCases":[{"title":"should login","status":"passed","duration":1500,"location":"tests/login.spec.ts:10:5"}]}'
```
