# Dashboard app: architecture map

The reference for `apps/application/`: what exists, where it lives and how the pieces connect. The **rules** for
changing it live in [`AGENTS.md`](AGENTS.md) and the topic guides it lists: read those before editing.

This map describes structure and intent, not every file. For exact names, the directory listings and the generated
OpenAPI spec ([`/_openapi.json`](#backend)) are the authority.

## Contents

- [Shape](#shape): the top-level folders.
- [Shared types and core](#shared-types-and-core): the wire contract, the permissions, `@piwitests/core`.
- [Database](#database): the schemas, the migrations, the tables by area, the tables worth a note.
- [Backend](#backend): [route families](#route-families), [other routes](#other-routes),
  [server utilities](#server-utilities), [scheduled tasks](#scheduled-tasks),
  [code the server and the demo share](#code-the-server-and-the-demo-share).
- [Front end](#front-end): [pages](#pages), [the failure pages](#failure-pages), [components](#components),
  [shared building blocks](#shared-building-blocks), [composables](#composables), [utils](#utils),
  [coverage insights](#coverage-insights-in-the-ui).
- [Demo SPA](#demo-spa): the in-browser mirror of the server.
- [Extension points](#extension-points): where to add things whose wiring spans several files.
- [Key features](#key-features): what the dashboard does, in one paragraph.

## Shape

```
app/          Nuxt 4 (Vue 3) front end: pages, components, composables, utils, layouts, plugins, middleware
app/demo/     In-browser mirror of the server, used by the demo SPA
server/       Nitro back end: api/, routes/, middleware/, plugins/, tasks/, utils/, database/, storage/
shared/       Types, constants and pure helpers shared by app, server and demo (imported as `#shared/...`)
public/       Static files (logos, favicon, the demo's media)
scripts/      Demo seed, dev server, DB query helper, screenshots and demo media, page measurements,
              the performance suite (`scripts/perf/`)
tests/        Playwright specs (`*.spec.ts`), Vitest unit tests (`tests/unit/*.test.ts`), live AI tests (`tests/live/`)
types/        Front-end API response types (`api.ts`)
```

## Shared types and core

- **Wire contract.** `shared/types.ts` holds the shapes the reporter sends: `TestCasePayload`, `StreamEventPayload`,
  `TestRunSubmitPayload`, `TestRunStartPayload` and `TestRunFinishPayload`. Server endpoints import it as
  `#shared/types`. The routes that receive test cases (`submit`, `upload`, `[id]/events`) and the demo's reporter turn a
  wire test case into what `persistRunCases` stores with `mapWireCaseToRunCase` (`server/utils/map-wire-case.ts`).
- **Wire leaf shapes.** The small shapes the app shares with the reporter (`BrowserConfig`, `TestStepEvent`,
  `SuiteConfigEntry`, `TestAnnotation`, `FilterDetails`, `TestSourceFrame`, the resource report shapes and a few more)
  live in `@piwitests/core/wire`, and `shared/types.ts` re-exports them: one definition for both sides. The per-case
  payloads stay in the app, and the reporter keeps its own `WireTestCase`. `tests/unit/wire-shared-drift.test.ts` keeps
  the two compatible.
- **Authorization model.** `shared/permissions.ts` holds `InstanceRole`, `ProjectRole`, `Permission`, the role matrix
  `ROLE_PERMISSIONS`, a user's `AccessSummary` and the checks on it (`can`, `passesEarlyCheck`, `projectScopeFor`). It
  is pure; the server, the MCP tools, the demo and `useAuth` import it. Instance roles are `administrator` and `member`
  (`users.role`); project roles are `viewer`, `contributor`, `maintainer`, `project_admin` and `uploader`; a
  `Permission` is a `ProjectPermission` or an `InstancePermission`, named `resource:action`. Role bindings and groups
  are read and written by `shared/handlers/role-bindings.ts` and `shared/handlers/groups.ts`, shared with the demo.
- **Project run scope.** `shared/project-run-scope.ts` describes the runs a project page's Filters block picks
  (environments, branches, the branch policy, full runs only), the scope's query keys (the analytics ones, so an
  analytics drill-down address is a scope too) and the in-browser matcher (`runInProjectScope`).
  `shared/handlers/project-run-scope.ts` turns a scope into the SQL conditions (`projectRunScopeConditions`) that every
  project tab's handler adds.
- **`@piwitests/core`** (`packages/core/`) is a private package with **zero dependencies**, safe to run in the browser,
  a service worker or the server. It holds the pure logic the app shares with the reporter, Piwi Picker (the browser
  extension) and the editor service: locators (generation and scoring, ARIA role resolution, element-fingerprint
  matching for healing, chains, the locator index, the locator-method list), error text and parsing, step analysis,
  coverage and code reach, recordings and codegen, bug reports, the CI gate, and the wire leaves. The `exports` of its
  `package.json` list every module. It ships **TypeScript source** with no build step: Vite and Vitest transpile it, and
  the reporter's tsup bundles it in. The modules that moved there from the app keep a thin re-export shim under
  `shared/*`, so their `#shared/...` path still works; newer app code also imports `@piwitests/core/<module>` directly.

## Database

Drizzle ORM over **SQLite (libSQL)** or **PostgreSQL (postgres.js)**. `PIWI_DATABASE_URL` picks the dialect at
startup: PostgreSQL when it is set, else a SQLite file (`.data/piwi.db` by default).

- `server/database/schema.sqlite.ts` and `schema.pg.ts`: the real schemas, one per dialect, kept identical (a change
  edits both).
- `server/database/schema.ts`: a conditional re-export that picks one dialect when the module loads. Type-checking uses
  the SQLite schema as the reference. It never declares a table (see `server/database/AGENTS.md`).
- `server/database/index.ts`: `getDatabase()` and `initDatabase()`, which open the connection and run the migrations
  once per process (the startup plugins are the first callers).
- `server/database/migrations/` (SQLite) and `migrations-pg/` (PostgreSQL): both run automatically at startup.
- `server/database/migration-history.ts`: the startup check of the recorded migration history, and the repair of a
  database that ran another branch's migrations. `migration-targets.ts` holds its SQLite and PostgreSQL queries.

### Tables by area

| Area                 | Tables                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core results         | `projects`, `test_runs`, `test_suites`, `test_cases`, `test_runs_cases`, `network_requests`, `run_deliveries`                                                                               |
| Failure analysis     | `failure_clusters`, `failure_cluster_aliases`, `failure_cluster_test_routes`, `cluster_merge_suggestions`, `failure_diagnoses`, `failure_diagnosis_versions`                                |
| Flaky tests          | `quarantined_tests`, `flake_experiments`, `flake_arms`                                                                                                                                      |
| Evidence & storage   | `files`, `trace_resources`, `trace_blobs`, `trace_blob_resources`, `case_payloads`, `locator_snapshots`, `locator_usages`                                                                   |
| Coverage             | `code_reach`, `coverage_fragments`, `test_coverage`, `run_coverage`, `coverage_reports`, `coverage_report_files`, `coverage_executable`, `coverage_totals`, `coverage_daily`                |
| Test Map             | `graph_nodes`, `graph_edges`, `probes`, `scenario_gaps`                                                                                                                                     |
| CI and pull requests | `gate_evaluations`, `pr_feedback_posts`, `run_locator_breaks`, `heal_actions`                                                                                                               |
| Metadata             | `tags`, `project_tags`, `markers`, `entity_links`, `app_settings`, `test_functions`, `test_selections`, `project_url_patterns`                                                              |
| Bug reports          | `bug_reports`, `bug_reproductions`                                                                                                                                                          |
| Identity             | `users`, `api_keys`, `account_tokens`, `groups`, `group_members`, `role_bindings`, `extension_device_codes`, `oauth_clients`, `oauth_authorization_requests`, `oauth_grants`, `share_links` |
| Integrations         | `integration_connections`, `project_integrations`, `integration_actions`                                                                                                                    |
| Notifications        | `notification_channels`, `subscriptions`, `notification_deliveries`                                                                                                                         |
| Analytics, reports   | `analytics_daily_rollups`, `analytics_dashboards`, `report_schedules`, `report_snapshots`, `handback_outcomes`, `handback_outcome_rollups`                                                  |
| Assistant and agents | `assistant_conversations`, `assistant_messages`, `assistant_usage`, `assistant_nudge_dismissals`, `mcp_tool_calls`                                                                          |
| Resources            | `test_run_resource_reports`, `resource_findings`, `resource_occurrences`                                                                                                                    |

Each table's comment in `schema.sqlite.ts` says what a row is.

### Tables worth a note

- **`case_payloads`**: content-addressed storage for large per-execution text: `aria_snapshot` (and its JSON form),
  `test_source`, `test_source_frames`, the page inventory, the locator pages, the code reach and the list of coverage
  fragments. One row per unique content per project (SHA-256 `hash`, unique `(project_id, hash)`), referenced from
  `test_runs_cases.*_payload_id`. See the rule in `server/database/AGENTS.md`.
- **`locator_snapshots`**: one row per locator call site (`test_case_id` + `location`), upserted on each run with the
  latest element attributes and the ranked alternatives computed in advance. Unique index on
  `(test_case_id, location)`; the `last_seen_run_id` foreign key is `ON DELETE set null`.
- **`locator_usages`**: the **locator index**, read from the steps of each ingested execution. One row per test case,
  Playwright project, branch, call site, action, canonical chain and page.
  - `branch` is `''` for the default branch. A view of another branch replaces the default rows of the tests that ran
    on it.
  - `page` is the page key the call ran on, `''` when unknown. It comes from the execution's `piwi-locator-pages` list,
    joined by call site and chain; the list is stored through `case_payloads` as
    `test_runs_cases.locator_pages_payload_id`, so a rebuild keeps it (`server/utils/locator-pages.ts`).
  - `arrival` says the call ran on that page before any locator interaction there.
  - It feeds "Who uses this?", the project's Locators page and the extension's Tested elements
    (`GET /api/projects/:id/locator-index`).
- **Coverage tables** (`server/utils/coverage.ts`, `server/utils/code-reach.ts`): which code each test executed, per
  repository-relative file and runtime (`browser`, `server`).
  - `coverage_fragments` holds one file's coverage as one test recorded it (the function and executed line ranges, and
    the git blob they refer to), content-addressed per project (unique `(project_id, hash)`). Each execution names its
    fragments through `test_runs_cases.coverage_payload_id` (a `case_payloads` row).
  - `test_coverage` holds, per test case, branch and runtime, the fragments of its latest run with coverage, and
    `code_reach` their files (or the reporter's `codeReach` list for a test without coverage). A newer run replaces
    both the same way. `branch` is `''` for the default branch; a view of another branch reads, per runtime, the
    branch's rows of the tests that have some.
  - `run_coverage` holds a run's coverage per file, merged across shards. `test_runs.server_coverage_gaps` lists the
    backends whose part of it is missing: one restarted during the run, or was unreachable at its end
    (`#shared/run-coverage-gaps`).
  - Branch rows are pruned with the Test Map's branch rows (`graph:sweep`, after 30 days); fragments nothing
    references go in the orphan sweep.
  - `coverage_reports`, `coverage_report_files`, `coverage_executable`, `coverage_totals` and `coverage_daily` hold
    the coverage imported from other tools per commit and suite (`piwi coverage upload`), and its totals and trend.
- **`account_tokens`**: single-use, SHA-256-hashed tokens for password reset, invite and email verification, with a
  `purpose` and an expiry checked at query time (`server/utils/account-tokens.ts`).
- **`notification_deliveries`**: an outbox. `dedupeKey` is unique, which makes delivery idempotent; `status`,
  `attempts` and `scheduledFor` drive progressive retry: five retries, after 1, 5, 15, 60 and 240 minutes
  (`server/utils/outbox.ts`). `heal_actions` and `integration_actions` are outboxes of the same kind.
- **`resource_findings`**: one row per project and finding identity (`shared/resource-fingerprint.mjs`: verdict, kind,
  scope and where it was opened, line included), with the runs it was first and last seen in, ordered by start time.
  `resource_occurrences` holds each run's showing with the run's branch. `shared/handlers/resource-findings.ts` writes
  them when a run finishes. It also:
  - marks a finding fixed after five clean full runs of the default branch;
  - moves a finding to its new line when an edit above it shifted it (the same identity without line numbers, closest
    line first);
  - tells the gate and the pull-request comment which findings are new to the base branch.
- **`test_run_resource_reports`**: one row per run and shard with that reporter's resource report. Each shard's finish
  upserts its row whole, so concurrent shards never overwrite each other. Reads fold the rows in shard order
  (`shared/handlers/resource-reports.ts`).
- **`entity_links`**: external URLs (Jira, GitHub…) attached to a run, an execution, a test case, a failure cluster or
  a bug report, through one nullable foreign key column per owner with `ON DELETE CASCADE`, like `files`.
  `shared/link-detect.ts` detects the provider from the URL.
- **`run_deliveries`**: one row per batch delivery of a run's results (`submit`, `upload`, a shard's), under the key
  the reporter generated. A delivery repeated with the same key answers with the run it already created.
- **`graph_nodes`, `graph_edges`, `probes`, `scenario_gaps`**: the Test Map. Their run ids are not foreign keys, since
  runs are pruned independently and a node must outlive them.

## Backend

Nitro file-based routing: `server/api/` serves `/api/...`, and `server/routes/` serves the other paths. The generated
**OpenAPI 3.1** spec at `/_openapi.json` and the in-app reference at `/docs` list every endpoint; this section only
gives the shape.

### Route families

Each entry names folders under `server/api/`.

- **`test-runs/`**: the reporter's routes and the run page.
  - Batch ingest: `submit` (JSON), `upload` (multipart), `import` and `import/check` (a historical blob report or
    trace).
  - The streaming protocol: `setup`, `start`, `[id]/begin`, `[id]/events`, `[id]/heartbeat`, `[id]/case-files`,
    `[id]/finish`, and `[id]/live-resources`: a watched run's CPU, memory and open pages, held in memory by
    `server/utils/run-events.ts` until the run ends and merged by `shared/live-resources.ts`.
  - The run page's live view, for a project with `projects.live_view` on: `[id]/live-view` (a test worker's event
    stream, `GET`, and its frames and stops, `POST`, on the run's live view key, `@piwitests/core/live-view`),
    `[id]/live-view/watch` (one worker's view, to a person who may open the run) and `[id]/live-view/workers`. All of
    it is relayed in memory by `server/utils/live-view.ts`, written straight to the response by
    `server/utils/event-stream.ts` so a slow reader gets the latest frame alone; `setup` mints the key.
  - Run detail: `[id]` (read, update, delete), `recent`, the SSE `[id]/stream`, network requests, failure groups,
    `[id]/insights` (the comparison with a baseline that the Changes tab shows), coverage, the Perfetto export.
  - `[id]/resources`: the report each reporter sent (one `test_run_resource_reports` row per shard, rebuilt on ingest
    by `shared/resource-report.ts`) and the costliest executions (`shared/handlers/run-resources.ts`);
    `[id]/resource-timeline`.
  - CI: `[id]/gate` (a gate policy's verdict) and `[id]/incident` (an environment incident).
- **`test-cases/`**: one test across runs: detail, history, stability trend, coverage reach, path variation, merge,
  and the Flake Lab (`flake-plan`, `flake-experiments`, `flake-lab-ci`, `flake-profile`).
- **`test-run-cases/`**: one execution: detail, steps, timeline, the trace views, DOM snapshots, page and visual
  diffs, the attempt diff, clues, coverage and its divergence, suspect lines, execution-scoped diagnosis (`diagnose`,
  `diagnosis`, `diagnosis-context`), locator healing (`locator-healing`, `locator-pick`, `locators`), the export, the
  `.piwibug` file, share links.
- **`projects/`**: the list with stats (`projects.get.ts`), `menu` (the sidebar's short list, one SELECT),
  `overview` (per-project trends), create, detail, update, delete. Under `projects/[id]/`: members, flaky and slow
  tests, failure clusters, the test catalog, coverage, the locator index, the Test Map (`graph`, `feature-map`,
  `gaps/`, `probes/`, `surface/`), quarantine, the Flake Lab, capabilities, markers, share links, and the families
  listed below.
- **`failure-clusters/`, `cluster-merge-suggestions/`, `failure-diagnoses/`**: cluster list, detail and triage
  (status, assignee, snooze, bulk, quarantine, extract cases), AI diagnosis (`diagnose`, `context`, `commits`,
  `commit-diff`, `base-commit`), the diagnosis version history (`diagnoses`), suspect lines, fix plan, fixed-before
  matches, occurrence trend, rerun, bisect, export; semantic merge suggestions (approve, reject); diagnosis feedback.
- **`widgets/`, `dashboards/`**: the cross-project analytics behind `/analytics`.
  - `widgets/[widget]` answers one widget; `widgets/preview` answers the editor's unsaved widget. `analytics/[widget]`
    is the former path of `widgets/[widget]`, kept for scripts: ad blockers refuse an address containing "analytics".
  - `dashboards/`: the saved dashboards (CRUD, `duplicate`, share links), `dashboards/scope` (how a scope resolves) and
    `[id]/widgets/[key]` (a saved widget's answer, cached 60 s by `server/utils/dashboard-widget-cache.ts`).
  - Handlers in `shared/handlers/dashboards.ts`.
- **`reports/`**: quality reports: the preview, the schedules and the snapshots.
- **`auth/`, `users/`, `groups/`, `project-access`**: login, logout, `me`, first setup, OAuth sign-in, password reset
  and change, email verification, invites, user and API-key management, groups, the permission grid.
- **`channels/`, `subscriptions/`, `notifications/stream`**: notification destinations, per-project subscriptions, the
  SSE delivery stream.
- **`settings/`**: AI, SMTP, auto-heal, pull-request feedback, CI cost, locale and other admin settings. A stored
  secret is never returned, only whether it is set; the flags the environment manages are exposed.
- **`ai/`, `assistant/`**: the AI status and the local CLI providers; the in-app assistant's conversations, messages,
  Stop, questions and nudge dismissals.
- **`integrations/`**: issue trackers: connections, issue creation and drafts, the Jira webhook, status sync.
- **`files/`, `traces/`, `markers/`, `links/`, `tags/`, `search`, `share-links/`, `admin/`**: artifact download,
  trace checks, timeline markers, entity links, tags, global search, share links, admin stats, storage and cleanup.
- **`projects/[id]/test-functions`, `test-functions/[id]`**: the browser extension's function catalog: CRUD, plus:
  - `test-functions/extract` (AI): pasted source becomes a proposed catalog entry, an unsaved draft;
  - `test-functions/validate-proposal` (no AI call): parses and validates an AI reply pasted back, against the same
    schema, for instances with no AI configured. The demo serves it too, since it needs no AI.
- **`extension/connect`, `extension/url-patterns`**: connecting the browser extension, an RFC 8628 device
  authorization. The extension calls `connect`, then polls `connect/token`; the `/extension/connect` page reads
  `connect/request` and answers with `connect/decision`. The first poll that sees the request approved creates the API
  key (`server/utils/extension-connect.ts`, table `extension_device_codes`). `extension/url-patterns` lists every URL
  pattern the caller can see.
- **`projects/[id]/url-patterns`**: a project's URL patterns (`project_url_patterns`): list, replace, add one, and
  `suggestions` from the origins the suite visited. Handlers in `shared/handlers/url-patterns.ts`; the editor is
  `ProjectUrlPatternsForm`.
- **`projects/[id]/bug-reports`, `bug-reports/[id]`**: bug reports from Piwi Picker (`bug_reports`,
  `bug_reproductions`).
  - Routes: send (multipart, screenshots in storage under `bug-reports/<id>/`), `intake` (what sending will do), list,
    read, update, `reproductions`, `spec` (the failing test, with the project's `generated_specs`), `missed-by`,
    `screenshots/:index` and `step-shots/:step`.
  - Handlers and the run lifecycle (`applyBugReportLifecycle`, called from `runFinalizeSideEffects`) in
    `shared/handlers/bug-reports.ts`; pages `projects/[id]/bug-reports.vue` and `bug-reports/[id].vue`.
- **`projects/[id]/selections`, `selections/[key]`**: named, data-driven test selections.
  - CRUD, and `[key]/resolve`: a definition becomes the matching tests and a `playwright test` command, with `shard`
    balanced by duration. This is what `piwi select` and `piwi run` call.
  - `preview` (an ad-hoc definition) and `suggestions` (proposed `slow` and `feature` tags, and a mined smoke suite).
  - `impact`: changed files, and with `changes` their changed base lines, become the affected tests. This is what
    `piwi run impact --base` and the MCP tool `get_impacted_tests` call.
  - `overview`: per-selection health, drift from the last run and the coverage of unselected tests (`analytics` is
    its former path).
  - Code: resolver and CRUD in `shared/handlers/selections.ts`, suggestions in
    `shared/handlers/selection-suggestions.ts`, overview in `shared/handlers/selection-analytics.ts`, impact in
    `server/utils/selection-impact.ts` (its pure line-level rules in `shared/line-impact.ts`), the definition's shape,
    validation and materialization in `shared/selection/`.
- **`desktop/`**: routes the desktop app calls: its event stream, local imports, Piwi Picker pairing, reproduction
  requests, reporter configuration.
- **`flake-lab/inbox`, `gaps/`**: cross-project inboxes of the Flake Lab and the scenario gaps.
- **`health`, `version`, `capabilities`, `setup-status`, `metrics`, `rollups`, `stream`, `agent-skills`**: the
  readiness probe (200 or 503, with a database check), build info, the instance capabilities, the setup status,
  metrics for Prometheus, the rollup export, the global SSE stream, the agent skills this build ships.

### Other routes

- **`server/routes/mcp.post.ts`**: the MCP server endpoint. Tool definitions in `shared/mcp-tools.ts`, handlers in
  `server/utils/mcp/`. `describe_piwi` and `get_release_notes` live in `server/utils/mcp/about-piwi.ts`: they read the
  docs and the CHANGELOG bundled as Nitro server assets, parsed by `shared/docs-corpus.ts` and `shared/changelog.ts`,
  with the pieces and setup decisions in `shared/piwi-ecosystem.ts`.
- **`server/routes/oauth/`, `server/routes/.well-known/`**: the OAuth authorization server MCP clients sign in
  through: discovery metadata (RFC 9728, RFC 8414), dynamic client registration, `authorize` (stores the request and
  redirects to the `/oauth/consent` page, backed by `api/oauth/authorizations/[id]`), `token` (code with PKCE, refresh
  rotation) and `revoke`. Logic in `server/utils/mcp-oauth.ts`, pure helpers in `mcp-oauth-helpers.ts`, tables
  `oauth_clients`, `oauth_authorization_requests`, `oauth_grants`.
- **`server/routes/share/`**: the public page of a share link (an execution or a cluster rendered as the offline
  export, a report snapshot, a live dashboard), with its badge and chart image.
- **`server/routes/test-runs/[id]/locate`**: finds an execution from what the reporter knows before the server
  assigns ids, and redirects to its page (the links the reporter prints when a test fails).
- **`server/routes/__piwi/`**: the desktop session bootstrap, guarded by `server/middleware/desktop-guard.ts`.

### Server utilities

The main files of `server/utils/`, by area.

**Ingest and import**

- `persist-run-cases.ts`: the single write path for run cases; every ingest site, server and demo, goes through it.
- `run-finalize-side-effects.ts`: `runFinalizeSideEffects`, what runs when a run finishes (see
  [Extension points](#extension-points)).
- `blob-report.ts`: reads a Playwright blob report (`report.jsonl` + `resources/`) into a run and `RunCaseInput`s for
  the import endpoint.
- `trace-import.ts`: rebuilds one execution from a bare `trace.zip`: title, browser, timing and error from the trace's
  own headers.
- `archive-reader.ts`: the server's ZIP half of the import parsers (the demo supplies its own), inflating entries on
  demand.
- `import-evidence.ts`: recovers the ARIA snapshot and source snippet from `error-context`, and the console entries
  from the trace, for imported executions.
- `upload-limits.ts`: the effective multipart ceiling (`PIWI_IMPORT_MAX_BYTES`), shared by `upload` and `import` and
  shown on the import page.
- `case-payloads.ts`: content-addressed payloads: upsert, inline, resolve.

**Locators, coverage and suspect lines** (each shared with the demo)

- `locator-healing.ts`: `upsertLocatorSnapshots`, `getLocatorHealing`, `saveLocatorPick`.
- `locator-usages.ts`: the locator index: step indexing on ingest, "Who uses this?", `getLocatorIndex`.
- `code-reach.ts`, `coverage.ts`: code reach (the code index, a file's reach, replacement by the latest run per test,
  branch and runtime) and coverage storage (fragments, per-execution payloads, test and run coverage, their reads,
  retention).
- `source-at-blob.ts`: a file's source at the git blob a coverage names, through the project's SCM provider
  (`fetchBlob`, else the file at a run's commit when its blob id matches), kept per blob. The demo serves its canned
  files instead (`getDemoSourceAtBlob`).
- `suspect-lines.ts`: the suspect lines of an execution or a failure cluster: the regression context's range, its
  changes from source control and the coverage, joined by `@piwitests/core/suspect-lines` and kept five minutes. The
  database reads and the join live in `#shared/handlers/suspect-lines`.
- `mcp/coverage-tools.ts`: the coverage MCP tools (`get_coverage`, `compare_coverage`, `get_coverage_loss`,
  `get_coverage_summary`) over the coverage insights: a failure's path against its last pass, a test's path that
  varies with the tests before it (the `order` flaky root cause), what quarantining tests leaves uncovered, whether a
  test reached target lines. The pure comparisons live in `shared/coverage-insights.ts`, the database reads in
  `#shared/handlers/coverage-insights`.

**Access**

- `project-access.ts`: `getProjectScope`, `requireProjectAccess`, `requireResolvedProjectAccess`, and the resolvers
  from an entity to its project.
- `route-required-permission.ts`, `route-permission-match.ts`: read `x-required-permission` from the compiled route
  metas, and match a request to its route with rou3.

**AI and the assistant**

- `ai-*.ts`: the provider abstraction and the local CLI providers, the AI settings, diagnosis, context building and
  its limits, the research stage, embeddings, images, the system prompt, AI-step resolution, model calls with tools
  (`ai-tool-calls.ts`), and the function-catalog extraction from pasted code. The extraction's rules, schema and
  prompt builder live in `shared/test-function-extract-prompt.ts`, the one source for the endpoint that calls the AI,
  the dashboard's "copy prompt" flow for instances with no AI credits, and the description of the MCP
  `create_test_function` tool.
- `assistant/`, `ai-tool-calls.ts`, `mcp/catalog.ts`: the in-app assistant.
  - One turn: its loop (`loop.ts`) and its answer (`answer.ts`), or a run by the Claude Code CLI with its own MCP
    endpoint and token (`claude-code.ts`, `turn-mcp.ts`, `turn-token.ts`).
  - Its tools per page (`tools.ts`, `instance-config.ts`, `explain_setting` in `settings.ts`, the desktop's
    `local-source.ts`), the block tools (`blocks.ts`, limits in `#shared/assistant-blocks`, proposal actions in
    `#shared/assistant-actions`), the entities a read names (`entities.ts`), the guide checks (`guides.ts`).
  - The system prompt (`prompt.ts`), the limits and daily allowance (`limits.ts`), the route entry points
    (`turn.ts`), the answers being written and Stop (`running.ts`).
  - `mcp/catalog.ts` filters the tools a caller is offered (on `/mcp` and in the assistant) and builds the
    `McpContext`.
  - Conversations, question history, replies, ticks, outcomes and usage: `#shared/handlers/assistant`.
- `cluster-*.ts`: failure clustering: similarity, semantic adjudication, naming, reconciliation, and the resolved
  clusters a new one resembles (`cluster-memory.ts`, "Fixed before").
- `scm/`: the SCM providers (GitHub, GitLab, Bitbucket): repository history, diffs and patch validation for AI
  diagnosis, the default branch, code ownership, change coverage and the pull-request feedback. On the desktop app,
  `local-git.ts` reads a linked clone.

**Notifications, email and security**

- `notifications/`: `match.ts` (subscription matching into outbox rows), `dispatch.ts` (`sweepOutbox`, webhooks
  signed with HMAC-SHA256 in `X-Piwi-Signature`, Slack and Microsoft Teams messages), `emit.ts`,
  `run-notifications.ts`.
- `outbox.ts`: the retry schedule and the row claim every outbox sweeper shares (notifications, auto-heal,
  integrations).
- `email.ts`, `account-tokens.ts`, `rate-limit.ts`, `crypto.ts`: the SMTP transport and templates; single-use tokens
  (reset 1 h, verify 24 h, invite 72 h); an in-memory fixed-window rate limiter; AES-256-GCM encryption of stored
  secrets.

**Export and trace storage**

- `export-request.ts`, `export-assets.ts`: the plumbing the offline-export endpoints share: format parsing, download
  headers, the size budget, the asset reader backed by storage.
- `trace-reconstruct.ts`: rebuilds a full trace ZIP from a slim blob and the shared resource pool (pooled screenshots
  and frames go back under their entry names). The file endpoint and the exports use it.
- `trace-manifest.ts`: the slim blob's manifest: what went to the shared pool (`resources`, and the screenshots and
  screencast frames by content hash in `pooledEntries`). The one reader and path helper.
- `trace-evidence.ts`: the one loader of a stored trace for the views (`getTrace*FromBlob`, `loadStoredTraceEvents`).
  It inflates only the event streams (`.trace`, `.stacks`, `.network`); the ARIA snapshots and screenshots stay
  compressed until a view reads one (from the pool when the manifest lists them in `pooledEntries`), and the screencast
  is never read. A content-addressed blob (`project-<id>/blobs/<sha256>.zip`) is loaded once for the requests of one
  page and kept two minutes after its last read, within 64 MB for all loaded traces.

**Housekeeping and observability**

- `retention.ts`: run deletion, and the pruning the nightly `retention:sweep` runs: runs past the retention period
  (opt-in), settled notification deliveries and outbox rows, report snapshots, idle assistant conversations, extra
  diagnosis versions, orphan payloads and other orphan rows.
- `compute-regression-signals.ts`: the `isNewRegression` and `isNewFlaky` signals of a finished run.
- `otel.ts`, `server/plugins/opentelemetry.ts`: OpenTelemetry tracing, on when an OTLP endpoint is set: a span per
  request (and per request the server makes to itself during SSR), a span per SQL statement through
  `@kubiks/otel-drizzle`, and `Server-Timing: traceparent` on responses.

### Scheduled tasks

Nitro tasks under `server/tasks/`, scheduled in `nuxt.config.ts` (`scheduledTasks`):

| Schedule        | Tasks                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Every minute    | `notifications:sweep` (`server/tasks/notifications/sweep.ts`, the notification outbox), `heal:sweep`, `integrations:sweep`, `integrations:sync` |
| Every 5 minutes | `reports:schedule` (the report schedules that are due)                                                                                          |
| Every 10 min    | `gate:sweep` (the final state of the pull requests a gate failed on)                                                                            |
| Nightly         | `retention:sweep` (retention, outbox pruning, orphan sweep), `graph:sweep` (stale Test Map and coverage branch rows)                            |

### Code the server and the demo share

- **Import.** The orchestration is shared, not mirrored: `shared/handlers/import-runs.ts` owns everything after
  parsing, and the server and the demo each supply an `ImportPort` for the parts that really differ.
- **Offline export.** Same split: `shared/export/` collects the bundle, renders the self-contained HTML, the Markdown
  and the PDF, and writes the ZIP (with fflate, so it also runs in the demo's service worker). The server and the demo
  differ only in the `ExportAssetReader` that fetches the evidence bytes. `server/utils/trace-zip.ts` is unrelated: the
  server's own ZIP reader and writer for trace blobs (it parses and inflates archives within size caps, writes the
  slim blob deflated and the rebuilt trace stored).
- **A failed execution's `.piwibug`** (Piwi Picker's bug report file) follows the same split.
  `shared/handlers/execution-bug-report.ts` reads the execution and writes the archive, every entry stored, through
  the same `ExportAssetReader`. The conversion of the stored steps into a steps document is `bugReportFromExecution` in
  `@piwitests/core/execution-steps`. The archive's file names and text (`BUG_REPORT_FILES`, `renderBugMarkdown`,
  `renderBugSpec`, gathered by its local `bugReportTextFiles`) come from `@piwitests/core/bug-report`, which Piwi
  Picker writes its own archives with.

## Front end

### Pages

The files of `app/pages/`:

- `/`: the dashboard home.
- `/projects` and `/projects/[id]`: the project list, and a project's page with its tabs (Runs, Tests, Failures,
  Flake Lab, Gaps, Performance, Settings). `/projects/[id]/compare`, `/edit` and `/test-cases` only redirect to a tab.
- `/projects/[id]/test-functions`: the browser extension's function catalog. Add an entry by hand, through AI
  extraction from pasted code or, with no AI configured, by copying a prompt for your own AI chat and pasting its reply
  back.
- `/projects/[id]/selections`: test selections: a builder with a live preview and the command to run.
- `/projects/[id]/coverage`: with `?file=`, a file's coverage: its source with how many tests ran each line, the
  tests of a selected line or range, the nearest test to copy for a line no test runs, and a version selector. Worded
  by `app/utils/file-coverage.ts`; linked from the execution page's Coverage rows, the suspect lines and the Test
  Map's file nodes. Without `?file=`, the project's combined coverage at a commit, by folder.
- `/projects/[id]/locators`: check locators against the ones the tests use, and browse the locator index. Piwi Picker
  links here.
- `/projects/[id]/bug-reports` and `/bug-reports/[id]`: the bug reports from Piwi Picker.
- `/projects/[id]/import`: import historical Playwright blob reports.
- `/test-runs/[id]`: one run. `/test-cases/[id]`: one test case across runs. `/test-run-cases/[id]`: one execution.
  `/failure-clusters/[id]`: one failure cluster.
- `/analytics` (the viewer's default dashboard), `/analytics/d/[id]` (one dashboard, `?tv=1` for TV mode) and
  `/analytics/dashboards` (the list).
- `/reports` and `/reports/[id]`: quality report schedules and snapshots.
- `/setup`: the connect wizard and the optional capabilities.
- `/settings/*`: the settings pages.
- `/docs` (the in-app API reference) and `/mcp` (the MCP server and its tools).
- `/extension/connect` and `/oauth/consent`: where a signed-in user answers a connection request.
- `/login`, `/forgot-password`, `/reset-password`: public pages with no layout.

### Failure pages

`/test-run-cases/[id]` (one execution) and `/failure-clusters/[id]` read top to bottom in one column.

**The situation block.** Both pages open on `SituationBlock`:

- an identity kicker, then the headline as the page's `h1`;
- labelled rows in the order of `SITUATION_ROWS` (`app/utils/situation-rows.ts`): the explanation, then the action,
  then the context. The rows are Most likely (`StoryLine`), Situation, State (`ClusterStateLine`), Next
  (`NextStepLine`), Cluster, Issue (`IssueLine`), Occurrences, What changed (`WhatChangedLine`) and The suite; a page
  fills the rows it has;
- a facts line (`ExecutionFactsLine`, `ClusterFactsLine`) that holds Details and Raw error.

On the execution page:

- a meta line under the headline (`ExecutionMetaLine`) says since when the test fails, on which commit, and whether
  a newer execution of the test failed again or passed;
- the Cluster row names the cluster, then its ticket (`SituationParts` in the lead of `IssueLine`). The cluster page
  has an Issue row instead;
- a test that passed on retry takes its headline from its failed attempt's row (`FailureVerdict.attempt`), which the
  meta line names and links.

**Where the rows come from.**

- The handlers the demo shares build them (`shared/handlers/test-cases.ts`, `shared/handlers/failure-clusters.ts`),
  from `shared/situation.ts` (with `shared/latest-execution.ts` over `getNewerExecutions`), `shared/cluster-state.ts`
  and `computeNextStep` (`shared/next-step.ts`).
- `useNextStepActions` turns the Next row's action id into behavior on both pages, and copies the change the row shows
  (`buildNextStepChange`, `app/utils/next-step-change.ts`).
- Both pages choose Most likely, and word where the Next step's change comes from, with `shared/most-likely.ts`
  (`pickMostLikely`, `nextStepSourceLine`): one rule for the two.
- A test that did not run gives its reason as Most likely instead (`DidNotRunLine`, from `describeDidNotRun` in
  `shared/did-not-run.ts`), and its Next opens the blocking failure or the run (`open-blocker`, `open-run`).

**Under the block.**

- The execution page shows `EvidenceTabs` (opening on the tab `useEvidenceHint` picks from the leading clue), the
  `Toolbox` (More ways to fix: one folded section per way to fix, the one the next step points at open) and the
  history (`HistoryStrip`).
- The cluster page shows, in order:
  - the section the next step points at, as a card of its own (`Toolbox` with `lead`; the sections, their order and
    the step each serves are in `app/utils/fix-sections.ts`);
  - `ClusterInvestigation` when there is a diff to browse, with the cluster's suspect lines in `SuspectLinesList`,
    marked in its diff;
  - `ClusterAffectedTests`, when the cluster has several tests: its selection picks the execution the evidence shows;
  - `EvidenceTabs`, then More ways to fix with the other sections folded;
  - the history, each folded to one line: `ClusterOccurrenceTrend` (a `ChartCard` with `foldKey`, opened by the
    occurrence sparkline) and `ClusterActivity`.

**Shared by both pages.**

- Both provide a section locator (`clusterSectionLocatorKey`), so a clue or an AI citation reveals the evidence it
  cites.
- `useEvidenceHint` hands the evidence card what Most likely cites; the card marks those tabs and timeline rows
  (`citedItemIds`, `app/utils/timeline-rows.ts`).
- Both What changed lines say what the suspect lines say (`SuspectLinesSentence`, worded by
  `app/utils/suspect-lines.ts`), from the suspect-lines endpoints, fetched in the browser after the page mounted.

`/bug-reports/[id]` opens on the same block, with Situation, State, Next and The suite.

`npm run app:measure` (`scripts/measure-detail-pages.mjs`) checks the two failure pages against their budgets: the
text styles, the controls of the navbar and of the situation block, and the distance between the Next step and what
it copies.

### Components

The components of `app/components/` live in domain subfolders. They are all auto-imported **without a folder prefix**
(`pathPrefix: false`), so their names are unique across folders.

| Folder               | Scope                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`            | Cross-page primitives and widgets: see [Shared building blocks](#shared-building-blocks)                                                                                                                                        |
| `run/`               | The run page: header, tests list, workers timeline (`timeline/`), the Changes tab's comparison and baseline picker, reports, the Resources tab (`RunResources`, formatting in `app/utils/resources.ts`), keep and delete        |
| `test-case/`         | One execution: the meta and facts lines, the evidence tabs and their cards (timeline, screen, source, network, console, state, performance, attempts, locators), the did-not-run line, clues; the test page's flakiness tab     |
| `cluster/`           | One failure cluster: the state, owner, what-changed and facts lines, the occurrence sparkline and trend, the affected-tests selector, the investigation and baseline picker, the commit browser, activity, fixed-before matches |
| `diagnosis/`         | The AI diagnosis panel: the context preview and coverage strip, the result with evidence citations, screenshots, the version history                                                                                            |
| `integrations/`      | Issue trackers: the Issue line both failure pages share, the create and link dialogs, the Jira connection, the project binding and its field defaults, the automation rules, the integration activity                           |
| `project/`           | A project's page: charts, flaky list, cluster list, SCM changes, subscribe bell, quarantine, Flake Lab, locators, the settings panels, the tests panel of a file's coverage page                                                |
| `combined-coverage/` | The combined coverage view: the tree, the bars, the legend                                                                                                                                                                      |
| `analytics/`         | Cross-project widgets (component map in `app/utils/analytics-widgets.ts`), and the dashboard page: `DashboardPage`, `DashboardBody` (view, editor, TV mode), `DashboardSwitcher`, `AddWidgetSlideover`, `WidgetConfigSlideover` |
| `bug-reports/`       | A bug report from Piwi Picker: the reported steps (`BugStepText`, from core's step parts), the evidence, the generated spec                                                                                                     |
| `gaps/`              | The Test Map: the feature graph and map views, the map health, the node inspector, the scenario gaps panel                                                                                                                      |
| `notifications/`     | Notification channels and subscription scope                                                                                                                                                                                    |
| `reports/`           | Quality reports: the schedule form and list, previews, snapshots                                                                                                                                                                |
| `assistant/`         | The assistant's panel (`AssistantPanel`, docked or over the page; `AssistantPanelBody`), its input (`AssistantInput`, `AssistantUsage`), messages and blocks, on `useAssistant`; a page's nudge, `AssistantNudge`               |
| `guides/`, `mcp/`    | The authored guides list; one MCP tool on the `/mcp` page                                                                                                                                                                       |
| `home/`              | The home page's cards (open failures, the Flake Lab inbox)                                                                                                                                                                      |
| `layout/`            | The app shell: user menu, sidebar status badges, the get-started wizard and its setup steps                                                                                                                                     |
| `settings/`          | The settings pages' panels                                                                                                                                                                                                      |
| `desktop/`           | Desktop-only cards, modals and controls                                                                                                                                                                                         |
| `docs/`              | The in-app API reference                                                                                                                                                                                                        |
| `demo/`              | Demo-only banner, simulator, user switcher and guided tour                                                                                                                                                                      |

### Shared building blocks

The components of `app/components/shared/` worth knowing before writing new markup (`app/AGENTS.md` makes reuse a
rule):

- **Structure**
  - `SectionCard`: the standard header (icon, title, count, subtitle), with `actions` and `footer` slots.
  - `CollapsibleSectionCard`: the same contract plus a required `storageKey`. Its fold state is kept in a cookie
    through `useFoldedState`, and its `#folded` slot shows a one-line peek while folded.
  - `DetailPageLayout`: summary, tabs and panels, with the right flex height at `lg` and up, and one scrolling
    document below.
- **States**: `EmptyState`, `LoadingState`, `ErrorState` (with an `action` slot).
- **Connection requests**: `ConnectRequestCard` (the page with the logo and the card, with its loading and error
  states) and `ConnectRequestButtons` (Deny / Allow), driven by `useConnectRequest`. They make the page where a
  signed-in user answers a client's request: Piwi Picker's and the editors' (`/extension/connect`) and an MCP client's
  OAuth sign-in (`/oauth/consent`).
- **Piwi Picker install hint**: `PickerInstallHint` (one line on what the extension does on that page, the store of
  this browser and _Don't show again_), driven by `usePickerInstallHint`.
  - It shows only in a browser the extension exists for (`pickerStoreFor`), never in the desktop window, and never
    once the extension marked the page (`@piwitests/core/picker-marker`, which the extension does on its connected
    instance's pages).
  - It sits where the extension is the next step: an empty bug reports list, an empty test function catalog, the
    Locators page's empty check box.
- **Filters**: `FiltersBlock` (the bordered _Filters_ block every page's filters sit in, folding to a summary on a
  phone), `FilterBar` (environment, branch, branch policy via `BranchPolicySelect`, full runs only) and
  `HiddenRunsNote` (what the filters hide, with the action that shows it).
- **Data display**
  - `StatTile` + `StatTileGrid` (auto-fitting, no per-page breakpoints), `TableScroller`, `FilterToolbar`.
  - `ChartCard`: a header and a `legend`; `foldKey` folds it to one line.
  - The SVG chart primitives: `ChartFrame` (measures its own plot area, draws the y-axis, and renders the tooltip of
    the `ChartMarkerLines` in its slot, outside the SVG), `ChartTooltip`, `ChartMarkerLines`, `ChartLegend`,
    `ChartMarkerTooltip`; and `MiniRunBars`.
  - `DurationValue`: a tight `210ms`, through the pure `splitDuration`.
  - `CodeBlock`, `MarkdownPreview`, `DiffPatch` / `DiffFile`.
  - `CoverageSourceView`: a source file with the lines a coverage ran and the executable lines it did not, the
    functions that ran linked above it, and an optional per-line annotation column; without the source, the line
    numbers alone.
  - `LocatorCode`: a locator expression, syntax-highlighted through `@piwitests/picker-dom`'s `tokenizeLocator`.
  - `ErrorText`: error text with its ANSI colors rendered, as a one-line `line` preview for lists and cells, or the
    full `block`.
  - `DeferredTooltip`: a `UTooltip` built when the pointer first enters, for a tooltip repeated on every row of a
    list.
- **Test lists**
  - `TestRow` + `TestRowGroup`: one test or one group header, read the same way in every list.
  - `TestSearchInput`: the search box of the run and project Tests tabs (qualifiers, completion of the term under the
    caret, Ctrl+F through `useFindShortcut`), and `SearchHighlight`, which marks what a search matched.
  - The search language lives in `shared/test-search.ts` (parser, in-memory matcher, highlight ranges, completion),
    with its SQL form in `shared/utils/test-search-sql.ts` for the paged catalog. The run and file order and the File /
    File + Describe rows live in `app/utils/test-list-order.ts`.
- **Navigation and actions**
  - `NavbarActions`: every `UDashboardNavbar` `#right` group; labels collapse to icons below `xl`.
  - `BreadcrumbNav`: a drop-in for `UBreadcrumb`, and the page title of every detail page, so the navbar never repeats
    it. The current page label takes the remaining width, the middle levels hide below `2xl`, and the ancestors
    collapse into a dropdown below `sm`.
  - `OpenInIdeLink` + `OpenInIdeSettingsModal`, `DocLink`, `LinkChip` / `EntityLinks`.
- **Help and settings**: `HelpHint` (topic keys from `shared/help-content.ts`), `SettingsField`, `EnvManagedBadge`,
  `EnvManagedAlert`.
- **Domain widgets**
  - `RunStatusBadge`, `StatusChip` (status icon and label in one badge, for detail summaries), `TestStatusBar`,
    `TagBadge` / `TagsSelect`, `BrowserBadge`, `MarkerBadge` / `MarkerForm`.
  - `ZoomableImage` (an image opened by click or keyboard, with an "Enlarge" hint on hover) drives
    `ScreenshotLightbox` (full screen, keyboard navigation, an actual-size zoom toggle for large captures, and a
    details panel naming the test, the step and the error raised on the page; `LightboxImage` in
    `app/utils/lightbox.ts`).
  - `VideoPlayer`, `TraceListItem`, `LocatorHealingPanel` / `LocatorAlternativeRow`, `SnapshotLocatorPicker`,
    `EnvironmentDiffCard`, `DataLocationCard`.
- **Failure pages** (see [Failure pages](#failure-pages))
  - `SituationBlock`: the labelled block the failure pages and a bug report open on, its rows in `SITUATION_ROWS`,
    the status color on its left edge.
  - `FailureHeadline`: the one-line headline, its locator in a chip when it is the `h1`. `StatusChip` sits in the
    block's identity kicker.
  - `StoryLine` (Most likely) and `NextStepLine` (the one recommended step; it emits its actions as ids the page
    handles through `useNextStepActions`).
  - `Toolbox` (More ways to fix, one folded section per way) and `HistoryStrip` (this test's recent executions as a
    row of squares).

### Composables

`app/composables/` holds state and behavior shared across components:

- **Auth and the dashboard shell**: `useAuth`, and the desktop detection (`useIsDesktop`, the Tauri bridge in
  `useTauri.ts`).
- **Run streaming**: `useRunStream`, `useNotificationStream`, and `useTabRunIndicator` (a watched run's progress on
  the browser tab's favicon and title).
- **Diagnosis**: `useClusterDiagnosis`, `useStreamingDiagnosis`, `useDiagnosisNotification`.
- **Timeline**: `useTimelineModel`, `useTimelineViewport`, and `useExecutionTimeline` (an execution's failure timeline
  under one key, for its Timeline and Network tabs).
- **Fold state**: `useFoldedState`.
- **A page's view state**: `useViewState` (search, filters, sort and open groups, kept per page path until a reload)
  and `useViewScroll` (its scroll position), both in `useViewState.ts`.
- **Settings**: `useSettingsNav`, `useSettingsEnvState`.
- **Analytics scope**: `useAnalyticsScope`.
- **The run page's retry command**: `useRunRetryCommand` (one failing set and one shared mode for every copy button on
  the page).
- **IDE preferences**: `useOpenInIde`.
- **Guides**: `useGuide` (the engine that walks a guide's stops, with a driver.js popover on each stop's guide
  anchor), `useDemoTour` (the demo tour's prompt and language, on top of it) and `useAuthoredGuides` (the authored
  guides the command palette and the assistant panel list).
- **Date and time localization**: `useLocaleSettings`, applied by `app/plugins/locale.client.ts`. The locale and time
  zone come from the per-browser override (Settings → Localization), else the instance default: `PIWI_LOCALE` /
  `PIWI_TIME_ZONE`, then the stored instance setting, then the built-in `en-US`. `en-US` output is byte-identical to
  the historical format (`M/d/yyyy, h:mm:ss a`).
- **The assistant**: `useAssistant` (the panel's state across navigation, the question asked with its page, the
  answer's event stream, its Stop and Try again, the question being typed, the question history) and
  `useAssistantDock` (where the panel sits, and its width).
- **Small utilities**: `useCopy` / `useCopyRich` (use them instead of calling `navigator.clipboard` by hand),
  `useAiStatus`, `useChartTooltip`.

How the guide engine plays a guide (`app/composables/useGuide.ts`):

- `start(run)` takes a `GuideRun` (`app/utils/guide/types.ts`: an id, a language, the stops with their copy, the words
  of the popover's controls).
- For each stop it opens the stop's route (else its anchor's main page when that is a fixed path), runs the anchor's
  reveal, scrolls the panels holding it and highlights it.
- A stop whose anchor does not render shows centered, with the anchor's `shownWhen` under its body; an `absent` stop
  does so at once, without opening a page or waiting.
- Until the user scrolls, clicks or types, the engine scrolls back into view a target that content loading above
  pushed out of it.
- `app/assets/css/guide.css` themes the popover (`piwi-guide*` classes). The anchor kinds are `GUIDE_ANCHOR_KINDS`
  (`page`, `tab`, `block`, `row`, `field`, `action`, `nav`).

### Utils

`app/utils/` holds pure helpers. The main ones:

- `index.ts`: `formatDuration`, `splitDuration`, `getStatusColor`, `getFileApiPath`, `formatRelativeTime`,
  `createSortHeader`, `formatBytes`, `errorMessage`, patch and commit helpers, the cluster color maps.
- `page-error.ts`: `showPageLoadError`. A detail page whose entity does not load shows `app/error.vue`, inside the
  dashboard layout, and answers with the API's 404 or 403.
- `route-query.ts`: `replaceQuery`. Query changes made in the same tick (a tab switch and the list the tab mounts) add
  up, instead of the last one dropping the others.
- `status-palette.ts`: `STATUS_PALETTE` / `statusPalette`, the test outcome colors every bar, chart, history cell,
  timeline bar and filter chip uses, backed by the `--color-status-*` tokens in `assets/css/main.css`.
- `pass-rate.ts`: the one set of thresholds and the one color scale for every colored pass rate, heatmap cells
  included.
- `duration-tone.ts`: the one tone for a timeline duration that stands out in its test. The rule is in
  `shared/duration-standout.ts`: at least 1 s, and either a third of the test or much slower than its usual time over
  the last passing runs. That module also holds the much-slower rule, the usual durations the timeline sends, and the
  step match key that the Attempts tab's `shared/attempt-diff.ts` compares attempts with.
- `chart.ts`: the per-chart series definitions the plots and their legends share, and the tick, stack and bar
  geometry of the SVG charts.
- `performance-hints.ts`, `ide-links.ts`, `openapi.ts` / `openapi-console.ts`.
- **Re-export shims.** `help-content.ts`, `settings-metadata.ts`, `retry-command.ts` and `locator-edit.ts` re-export
  shared modules, so they stay auto-imported in the app while the server and the demo import the same code:
  - `shared/retry-command.ts`: `buildRetryCommand` (`file-line` / `grep` / `file` modes, shell-escaped, capped at 4096
    chars) and `buildTitleGrepFlag` (the regex-escaped, shell-quoted `-g` flag the fix plan and auto-heal verify
    commands add);
  - `shared/locator-edit.ts`, itself a re-export of `@piwitests/core/locator-edit`: `buildLocatorEdit` (rewrites the
    failing locator call on a source line). The fix plan builds the same verify command and edits.
- Locator-line edits become a unified diff `git apply` accepts through `shared/heal-edit.ts` (`buildHealEdit` /
  `buildUnifiedLineDiff`), and `shared/callsite-location.ts` (`parseCallsiteLocation`) parses a captured
  `file:line:col` (safe with Windows drive letters).
- `app/utils/guide/`: the guide engine's pure parts: the `GuideRun` and `GuideStop` types, the route a stop opens
  (`stopRoute`, re-exported from `shared/guide-stops.ts`, which the assistant's guide checks read too) and the
  `**bold**` markup.
- `app/utils/demo-tour/`: the demo's guided tour as data: the tours (`TOUR_PROFILES`), their words (one
  `copy.<code>.ts` per language, registered in `TOUR_COPY`), the tour languages and the prompt's stored state.
- `app/utils/guides/`: the authored guides as data: the guides (`AUTHORED_GUIDES`), the resolvers that find the entity
  a stop opens on this instance (`GUIDE_RESOLVERS`) and the guide run they make for the engine.
- The assistant's panel (`AssistantPanel`, state in `useAssistant`) renders every block with the dashboard's own
  components and plays a composed guide through `useGuide`. From 1280 px it docks beside the page unless the user
  floats it, and below 1536 px a docked panel folds the sidebar to its rail; below 1280 px it is a slide-over, and a
  full-screen sheet on a phone.
- `app/utils/assistant/`: the assistant panel's pure parts: the event reducer, the page context a question carries
  (with the guide anchors rendered on the page), the replies to a question or options block, the page suggestions and
  the next question the input offers, the input's question history, the usage limits as the input shows them, and the
  guide run of a composed guide.
- `app/utils/nudges/`: the nudges (`NUDGES`: each one's page, rule, offer and words) and the browser's weekly budget.

### Coverage insights in the UI

The coverage insights (`#shared/coverage-insights`) reach the UI where the project's coverage capability is active,
and render nothing elsewhere:

- a failed execution's Coverage section compares it with the test's last passing run (`CoverageDivergencePart`; a
  file both ran at one version unfolds to `CoverageDivergenceSource`);
- the test page's `PathVariationCard` names the earlier test a path depends on;
- every quarantine action previews the code only its tests run (`CoverageLossPreview`; beside a bare button,
  `CoverageLossPopover` on hover or focus), read through `useCoverageLoss` when the action is about to be taken.

Their wording is in `app/utils/coverage-insights.ts`. Both AI contexts, the server's and the demo's, carry the
divergence through `coverageDivergenceContext` (`#shared/handlers/coverage-insights`).

## Demo SPA

`PIWI_DEMO_MODE=true` builds a client-only SPA with no server:

- A PWA service worker (`app/service-worker/demo-sw.ts`) intercepts `/api/` and answers from in-browser sql.js (WASM
  SQLite) through Drizzle, persisted in IndexedDB.
- `app/demo/api/router.ts` dispatches to per-domain handlers that mirror the server. `app/demo/db.client.ts` is shared
  by the service worker and the main thread.
- Live updates use a BroadcastChannel instead of SSE.
- The demo build also mounts the guided tour (`public.demoTour`). `DemoTour` in `app.vue` asks a first-time visitor's
  role, then walks that role's seeded screens with a driver.js popover on a guide anchor of each; `useDemoTour` hands
  the role's tour to the guide engine (`useGuide`). The tours are `TOUR_PROFILES` and their words one `copy.<code>.ts`
  per language, both in `app/utils/demo-tour/`.
- The anchors are the registry in `shared/guide-anchors/`: every element a guide can point at, by its `data-tour`
  attribute, with the pages it renders on, how to reveal it and a seeded sample where it renders.
- With no model, the demo's assistant answers the prepared questions of `shared/demo/assistant-questions.mjs`,
  matched by `app/demo/api/assistant-match.ts` and computed from the seed by `app/demo/api/assistant-answers.ts`.

- The demo build puts the hash of `public/demo/seed.version.json` in `runtimeConfig.public.demoDataVersion`. The
  layout compares it to the copy in IndexedDB and offers a "New demo data available" reset.
- Until the in-browser database is ready, the static shell shows `app/demo/loading-template.html` (Nuxt's
  `spaLoadingTemplate`, removed on `app:suspense:resolve`).
- The run simulator (`DemoSimulator.vue` + `app/demo/simulator.ts`) replays the reporter's streaming protocol against
  the in-browser endpoints; its live updates go over a BroadcastChannel (`app/demo/run-events.ts`).
- The tour's prompt is a toast (`DemoTourPrompt`, hosted by `DemoTour`) asking a first-time visitor what they do: a
  role starts its tour, **Later** asks again a day later (`TOUR_SNOOZE_MS`), **×** never again, and the banner's
  **Guided tour** button (`DemoTourButton`) reopens it. The decision is stored under `localStorage['piwi-demo-tour']`
  (`app/utils/demo-tour/prompt-state.ts`). The tour speaks the browser's language (`pickTourLanguage`) or the one
  picked in the toast; each stop links its docs page.

Rules and invariants: see `app/demo/AGENTS.md`.

## Extension points

Where to add things in subsystems whose wiring spans several files:

- **Flaky root-cause category**: `classifyFlakyRootCause()` and its keyword arrays in `shared/flaky-classify.ts`.
  Persistence and triggers in `shared/handlers/flaky-classify.ts`: `classifyRunFlakyTests`, called from
  `runFinalizeSideEffects`, and `withFlakyRootCauses`, called by the flaky-tests read on the server and in the demo.
  Then `rootCause` on `FlakyTest` (`types/api.ts`), and the color map and filter options of `FlakyTestsList.vue`.
- **Flaky impact scoring**: `getProjectFlakyTestsWithVerified` (`shared/handlers/projects.ts`, wrapped by
  `getProjectFlakyTests`) computes `impact` and sorts by it, highest first; `impact`, `wastedCiMinutes` and
  `avgFailedDurationMs` are fields of `FlakyTest`.
- **Regression signals**: `computeRegressionSignals()` (`server/utils/compute-regression-signals.ts`), started by the
  shared finalize helper `runFinalizeSideEffects` (`server/utils/run-finalize-side-effects.ts`); the `getTestRun` and
  `getTestRunCase` mappers return the signals.
- **A computed AI-context section**: update the `SectionId` union (`ai-context.types.ts`), `DIAGNOSIS_SECTIONS`
  (`diagnosis-sections.ts`) and `DiagnosisContextCoverage` (`types/api.ts`) **in one batch** before writing the section
  builder.
- **Blob-report import**: `server/utils/blob-report.ts` (parsing) and `import-evidence.ts` (recovered evidence);
  everything after parsing in `shared/handlers/import-runs.ts`; the endpoints `test-runs/import[.post]` and
  `import/check.post.ts`; the page `projects/[id]/import.vue` with `useBlobReportImport`.
- **Trace-file import**: `server/utils/trace-import.ts` rebuilds an execution from a trace's `context-options` and
  `error` events. The `importGroup` field of `test-runs/import.post.ts` gathers several traces into one run.
- **Quality report language**:
  - its code in `shared/reports/languages.ts`;
  - the `lang` enum of `server/api/reports/preview.get.ts` (a literal the test checks);
  - a `shared/reports/sentences.<code>.ts` implementing `ReportSentences` (copy `sentences.fr.ts`), registered in
    `REPORT_SENTENCES`.

  Validation, the MCP tool, the pickers and the CLI follow. `tests/unit/report-languages.test.ts` names the labels,
  metrics and gap titles the file lacks, and a new gap detector needs a sample in `tests/unit/gap-title-samples.ts`.
  The PDF's standard fonts write Windows-1252 only.

- **Issue automation criterion**:
  - the rule field and its check in `shared/integrations/automation.ts` (`AutoCreateRule`, `resolveAutoCreateRule`,
    `evaluateAutoCreate`, `describeAutoCreateRule`);
  - the fact it reads in `gatherAutoCreateFacts` (`shared/handlers/tracker-automation.ts`, shared with the demo
    preview);
  - the form in `app/utils/tracker-binding-form.ts` and `AutoCreateRulesEditor.vue`;
  - the table on `apps/docs/features/issue-automation.md`.

  The run trigger (`server/utils/integrations/automation.ts`) and the write-back scope (`policies.ts`,
  `tracker-run.ts`) read the rules and never re-implement them.

- **Finish-time side effects**: `runFinalizeSideEffects` (`server/utils/run-finalize-side-effects.ts`). Its comment
  gives the order of the steps; the rules are in
  [`server/api/test-runs/AGENTS.md`](server/api/test-runs/AGENTS.md#finish-time-side-effects).
- **Guide anchor, guided tour stop, role or language**:
  [`shared/guide-anchors/AGENTS.md`](shared/guide-anchors/AGENTS.md),
  [`app/utils/demo-tour/AGENTS.md`](app/utils/demo-tour/AGENTS.md).

## Key features

Projects created automatically on their first run · run ingest by JSON, multipart upload or live streaming (with
shard merge and crash recovery) · HTML reports, traces, videos and screenshots stored under `.data/storage/` (or S3)
with relative paths · flaky detection with root-cause classification and impact scoring · failure clustering with
semantic merge suggestions · AI diagnosis grounded in real SCM diffs, optionally in two stages · locator healing ·
timeline markers · notifications (email, Slack, Microsoft Teams and other webhooks, browser) · an MCP server for AI
agents · optional authentication with project roles and groups · retention and storage housekeeping · offline export
of an execution or a cluster as self-contained HTML, Markdown, JSON, a ZIP of the raw evidence, or a PDF.
