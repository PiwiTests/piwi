# Dashboard app — architecture map

Reference for `apps/application/`: what exists and where. The **rules** for changing it live in
[`AGENTS.md`](AGENTS.md) — read that before editing.

This map describes structure and intent, not every file. Directory listings and the auto-generated
[`/_openapi.json`](#backend) are the authority on exact names.

## Shape

```
app/          Vue 4 SPA/SSR front end — pages, components, composables, utils, layouts
server/       Nitro back end — api/, routes/, utils/, database/, middleware/, tasks/
shared/       Types, constants, pure helpers shared by app + server + demo (`#shared/...`)
app/demo/     In-browser mirror of the server for the demo SPA
scripts/      Seed generation, demo media capture, DB query helper, the performance suite (`scripts/perf/`)
tests/        Playwright specs (`*.spec.ts`) + Vitest unit tests (`tests/unit/*.test.ts`)
types/        Front-end API response types (`api.ts`)
```

## Shared types & core

- `shared/types.ts` — the **wire contract**: `TestCasePayload`, `StreamEventPayload`, `TestRunSubmitPayload` and
  `TestRunFinishPayload`. Server endpoints import it directly via `#shared/types`; every ingest route and the demo map a
  wire test case to what `persistRunCases` stores with `mapWireCaseToRunCase` (`server/utils/map-wire-case.ts`).
- `shared/permissions.ts` holds the **authorization model**: `InstanceRole`, `ProjectRole`, `Permission`, the matrix
  `ROLE_PERMISSIONS`, a user's `AccessSummary` and the checks on it (`can`, `passesEarlyCheck`, `projectScopeFor`).
  Pure, imported by the server, the MCP tools, the demo and `useAuth`.
- `shared/project-run-scope.ts` is the **project run scope**: the runs a project page's filters pick (environments,
  branches, the branch policy, full runs only), its query keys (the analytics ones) and the in-browser matcher;
  `shared/handlers/project-run-scope.ts` turns it into the SQL every project tab's handler adds.
- The small wire **leaf shapes** (`BrowserConfig`, `TestStepEvent`, `SuiteConfigEntry`, `TestAnnotation`,
  `FilterDetails`, `TestSourceFrame`) live in `@piwitests/core/wire` and are re-exported here — one source of truth
  shared with the reporter. Per-case payloads stay app-side; the reporter's `WireTestCase` stays reporter-side. The two
  are kept compatible by `tests/unit/wire-shared-drift.test.ts`.
- `@piwitests/core` (`packages/core/`) is a private, **zero-dependency**, browser/worker/server-safe package holding
  pure cross-cutting logic: locator generation/scoring, ARIA parsing + element-match healing, locator-healing types, the
  wire leaves, and the locator-method list. It ships **TypeScript source** (no build step) — Vite/Vitest transpile it,
  the reporter's tsup inlines it. The app consumes it through thin `shared/*` re-export shims.

## Database

Drizzle ORM over **SQLite (libSQL)** or **PostgreSQL (postgres.js)**, chosen at runtime by `PIWI_DATABASE_URL`.

- `server/database/schema.sqlite.ts` and `schema.pg.ts` — the real schemas (edit both).
- `server/database/schema.ts` — a conditional re-export that picks a dialect at module init; type-checking uses the
  SQLite schema as canonical. Never edit it to add tables.
- `server/database/migrations/` (SQLite) and `migrations-pg/` (PostgreSQL, auto-run on startup).
- `server/database/migration-history.ts` — the startup check of the recorded migration history, and the repair of a
  database that ran another branch's migrations; `migration-targets.ts` holds its SQLite and PostgreSQL queries.

Tables, by area:

| Area               | Tables                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Core results       | `projects`, `test_runs`, `test_suites`, `test_cases`, `test_runs_cases`, `network_requests`                                   |
| Failure analysis   | `failure_clusters`, `failure_cluster_aliases`, `cluster_merge_suggestions`, `failure_diagnoses`, `failure_diagnosis_versions` |
| Evidence & storage | `files`, `trace_resources`, `trace_blobs`, `case_payloads`, `locator_snapshots`, `locator_usages`                             |
| Coverage           | `code_reach`, `coverage_fragments`, `test_coverage`, `run_coverage`                                                           |
| Metadata           | `tags`, `project_tags`, `markers`, `entity_links`, `app_settings`, `test_functions`, `test_selections`                        |
| Identity           | `users`, `api_keys`, `account_tokens`, `groups`, `group_members`, `role_bindings`                                             |
| Notifications      | `notification_channels`, `subscriptions`, `notification_deliveries`                                                           |
| Analytics          | `analytics_daily_rollups`, `analytics_dashboards`, `report_schedules`, `report_snapshots`                                     |
| Resources          | `test_run_resource_reports`, `resource_findings`, `resource_occurrences`                                                      |

Non-obvious ones:

- **`case_payloads`** — content-addressed storage for large per-execution text (`aria_snapshot`, `test_source`,
  `test_source_frames`): one row per unique content per project (SHA-256 `hash`, unique `(project_id, hash)`),
  referenced from `test_runs_cases.*_payload_id`. See the rule in `AGENTS.md`.
- **`locator_snapshots`** — one row per locator call site (`test_case_id` + `location`), upserted each run with the
  latest element attributes and pre-computed ranked alternatives. Unique index on `(test_case_id, location)`;
  `last_seen_run_id` FK is `ON DELETE set null`.
- **`locator_usages`** — the locator index: one row per (test case, Playwright project, branch, call site, action,
  canonical chain, page), read from the steps of each ingested execution; `branch` is `''` for the default branch, and a
  view of another branch replaces the default rows of the tests that ran on it. `page` is the page key the call ran
  on, joined by call site and chain from the execution's `piwi-locator-pages` list (stored through `case_payloads` as
  `test_runs_cases.locator_pages_payload_id`, so a rebuild keeps it; `server/utils/locator-pages.ts`), `''` when
  unknown; `arrival` says a call ran there before any locator interaction. Feeds "Who uses this?", the project's
  Locators page and the extension's Tested elements (`GET /api/projects/:id/locator-index`).
- **Coverage** (`server/utils/coverage.ts`, `server/utils/code-reach.ts`) — which code each test executed, per
  repository-relative file and runtime (`browser`, `server`). `coverage_fragments` holds one file's coverage as one test
  recorded it (function and executed line ranges, the git blob they refer to), content-addressed per project (unique
  `(project_id, hash)`); each execution names its fragments through `test_runs_cases.coverage_payload_id` (a
  `case_payloads` row); `test_coverage` holds, per test case, branch and runtime, the fragments of its latest run with
  coverage, and `code_reach` their files (or the reporter's `codeReach` list for a test without coverage), replaced the
  same way. `branch` is `''` for the default branch, and a view of another branch reads, per runtime, the branch's rows
  of the tests that have some. `run_coverage` holds a run's coverage per file, merged across shards, and
  `test_runs.server_coverage_gaps` the backends whose part of it is missing (one restarted during the run, or was
  unreachable at its end; `#shared/run-coverage-gaps`). Branch rows go with
  the Test Map's branch rows (`graph:sweep`, 30 days); fragments nothing references go in the orphan sweep.
- **`account_tokens`** — single-use SHA-256-hashed tokens for reset/invite/verify, with a purpose enum and TTL enforced
  at query time.
- **`notification_deliveries`** — an outbox: `dedupeKey` unique for idempotency, `status`, `attempts` + `scheduledFor`
  for progressive retry: five retries, after 1/5/15/60/240 min (`server/utils/outbox.ts`).
- **`resource_findings`** — one row per project and finding identity (`shared/resource-fingerprint.mjs`: verdict,
  kind, scope and where it was opened, line included), with the runs it was first and last seen in, ordered by start
  time; `resource_occurrences` holds each run's showing with the run's branch. Written on finalize by
  `shared/handlers/resource-findings.ts`, which also fixes a finding after five clean full runs of the default branch,
  moves a finding to its new line when an edit above it shifted it (the same identity without line numbers, closest
  line first), and tells the gate and the pull-request comment which findings are new to the base branch.
- **`test_run_resource_reports`** — one row per run and shard with that reporter's resource report, upserted whole by
  its finish so concurrent shards never overwrite each other; read folded in shard order
  (`shared/handlers/resource-reports.ts`).
- **`entity_links`** — external URLs (Jira, GitHub…) attached to a run, execution or test case via three nullable FK
  columns with `ON DELETE CASCADE`, mirroring the `files` pattern. Provider auto-detected by `shared/link-detect.ts`.

## Backend

Nitro file-based routing under `server/api/`, plus `server/routes/` for non-`/api` routes. The auto-generated
**OpenAPI 3.1** spec at `/_openapi.json` and the in-app reference at `/docs` are the authoritative endpoint list — this
is only the shape of it.

| Family                                                                  | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-runs/`                                                            | Ingest (`submit`, `upload`, `import` + `import/check`), the streaming protocol (`setup`, `start`, `[id]/events`, `[id]/finish`, `[id]/case-files`), run detail, SSE `stream`, network requests, comparison, deletion, `[id]/resources` (the report each reporter sent, one `test_run_resource_reports` row per shard rebuilt on ingest by `shared/resource-report.ts`, and the costliest executions; `shared/handlers/run-resources.ts`)                                                                                                                                                                                                                                                                                                                         |
| `test-cases/`, `test-run-cases/`                                        | Stable test-case detail/history/traces; per-execution detail, execution-scoped diagnosis (`diagnose`, `diagnosis`, `diagnosis-context`), locator healing, DOM snapshots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `projects/`                                                             | List (heavy stats), `menu` (slim sidebar list, one SELECT), `overview`, detail, CRUD, members, flaky tests, spec health, trends, SCM                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `failure-clusters/`, `cluster-merge-suggestions/`, `failure-diagnoses/` | Cluster detail and triage, AI diagnosis (`diagnose`, `context`, `commits`, `commit-diff`, `base-commit`), semantic merge suggestions, diagnosis version history and feedback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `analytics/[widget]`                                                    | Cross-project analytics widgets backing `/analytics`; `analytics/scope` (how a scope resolves), `analytics/dashboards` (saved dashboards CRUD, `duplicate`, `[id]/widgets/[key]` cached 60 s by `server/utils/dashboard-widget-cache.ts`), `analytics/widgets/preview` (the editor's unsaved widget); handlers in `shared/handlers/dashboards.ts`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `auth/`, `users/`                                                       | Login/logout/me/setup, OAuth, password reset & change, email verification, invites, user + API-key management                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `channels/`, `subscriptions/`, `notifications/stream`                   | Notification destinations, per-project subscriptions, SSE delivery stream                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `settings/`                                                             | AI, SMTP and other admin settings (secrets never returned; env-managed flags exposed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `files/`, `traces/`, `markers/`, `links/`, `tags/`, `search`, `admin/`  | Artifact download, trace checks, timeline markers, entity links, tags, global search, admin stats/cleanup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `projects/[id]/test-functions`, `test-functions/[id]`                   | The browser extension's function catalog — CRUD, plus `test-functions/extract` (AI: pasted source → a proposed catalog entry, unsaved draft) and `test-functions/validate-proposal` (no AI call — parses/validates a pasted-back AI reply against the same schema, for instances with no AI configured; mirrored in demo mode since it's AI-free)                                                                                                                                                                                                                                                                                                                                                                                                                |
| `extension/connect`, `extension/url-patterns`                           | Connecting the browser extension: an RFC 8628 device authorization (`connect` → `connect/token` polled by the extension; `connect/request` + `connect/decision` behind the `/extension/connect` page), which creates the API key on the first poll that sees the request approved (`server/utils/extension-connect.ts`, table `extension_device_codes`); and every URL pattern the caller can see                                                                                                                                                                                                                                                                                                                                                                |
| `projects/[id]/url-patterns`                                            | A project's URL patterns (`project_url_patterns`): list, replace, add one, and `suggestions` from the origins the suite visited; handlers in `shared/handlers/url-patterns.ts`, editor `ProjectUrlPatternsForm`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `projects/[id]/bug-reports`, `bug-reports/[id]`                         | Bug reports from Piwi Picker (`bug_reports`, `bug_reproductions`): send (multipart, screenshots in storage under `bug-reports/<id>/`), list, read, update, `reproductions`, `spec` (the failing test with the project's `generated_specs`) and `screenshots/:index`; handlers and the run lifecycle (`applyBugReportLifecycle`, from `runFinalizeSideEffects`) in `shared/handlers/bug-reports.ts`; pages `projects/[id]/bug-reports.vue`, `bug-reports/[id].vue`                                                                                                                                                                                                                                                                                                |
| `projects/[id]/selections`, `selections/[key]`                          | Named, data-driven test selections — CRUD, `[key]/resolve` (definition → matching tests + `playwright test` command, with `shard` duration-balancing, what `piwi select` / `piwi run` call), `preview` (ad-hoc definition), `suggestions` (proposed `slow`/`feature` tags + a mined smoke suite), `impact` (changed files → affected tests, what `piwi run impact --base` calls) and `analytics` (per-selection health + drift-from-last-run + unselected-test coverage). Resolver + CRUD in `shared/handlers/selections.ts`, suggestions in `shared/handlers/selection-suggestions.ts`, analytics in `shared/handlers/selection-analytics.ts`, impact in `server/utils/selection-impact.ts`; definition shape/validation/materialization in `shared/selection/` |
| `health`, `version`, `apps/desktop/`                                    | Readiness probe (200/503 with DB check), build info, desktop-shell helpers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `server/routes/mcp.post.ts`                                             | The MCP server endpoint (tool defs in `shared/mcp-tools.ts`, handlers in `server/utils/mcp/`; `describe_piwi` and `get_release_notes` live in `server/utils/mcp/about-piwi.ts` and read the docs and CHANGELOG bundled as Nitro server assets, parsed by `shared/docs-corpus.ts` and `shared/changelog.ts`, with the pieces and setup decisions in `shared/piwi-ecosystem.ts`)                                                                                                                                                                                                                                                                                                                                                                                   |
| `server/routes/oauth/`, `server/routes/.well-known/`                    | The OAuth authorization server MCP clients sign in through: discovery metadata (RFC 9728, RFC 8414), dynamic client registration, `authorize` (stores the request, redirects to the `/oauth/consent` page backed by `api/oauth/authorizations/[id]`), `token` (code with PKCE, refresh rotation) and `revoke`; logic in `server/utils/mcp-oauth.ts`, pure helpers in `mcp-oauth-helpers.ts`, tables `oauth_clients`, `oauth_authorization_requests`, `oauth_grants`                                                                                                                                                                                                                                                                                              |
| `server/routes/__piwi/`                                                 | Desktop session bootstrap, guarded by `server/middleware/desktop-guard.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Key server utilities (`server/utils/`):

| File / folder                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persist-run-cases.ts`                                        | The single write path for run cases — every ingest site goes through it                                                                                                                                                                                                                                                                                                                                                                                   |
| `blob-report.ts`                                              | Reads a Playwright blob report (`report.jsonl` + `resources/`) into run + `RunCaseInput`s for the import endpoint                                                                                                                                                                                                                                                                                                                                         |
| `trace-import.ts`                                             | Rebuilds one execution from a bare `trace.zip` — title, browser, timing and error from the trace's own headers                                                                                                                                                                                                                                                                                                                                            |
| `archive-reader.ts`                                           | The server's ZIP half of the import parsers (the demo supplies its own), inflating entries on demand                                                                                                                                                                                                                                                                                                                                                      |
| `import-evidence.ts`                                          | Recovers ARIA snapshot / source snippet from `error-context`, and console entries from the trace, for imported executions                                                                                                                                                                                                                                                                                                                                 |
| `upload-limits.ts`                                            | Effective multipart ceiling (`PIWI_IMPORT_MAX_BYTES`), shared by `upload` and `import` and surfaced to the import page                                                                                                                                                                                                                                                                                                                                    |
| `case-payloads.ts`                                            | Content-addressed payload upsert/inline/resolve                                                                                                                                                                                                                                                                                                                                                                                                           |
| `locator-healing.ts`                                          | Shared `upsertLocatorSnapshots`, `getLocatorHealing`, `saveLocatorPick` (server + demo)                                                                                                                                                                                                                                                                                                                                                                   |
| `locator-usages.ts`                                           | Shared locator index: step indexing on ingest, "Who uses this?", `getLocatorIndex` (server + demo)                                                                                                                                                                                                                                                                                                                                                        |
| `code-reach.ts`, `coverage.ts`                                | Code reach (the code index, a file's reach, latest-run replacement per test, branch and runtime) and coverage storage (fragments, per-execution payloads, test and run coverage, their reads, retention) (server + demo)                                                                                                                                                                                                                                  |
| `source-at-blob.ts`                                           | A file's source at the git blob a coverage names, through the project's SCM provider (`fetchBlob`, else the file at a run's commit when its blob id matches), kept per blob; the demo serves its canned files instead (`getDemoSourceAtBlob`)                                                                                                                                                                                                             |
| `suspect-lines.ts`                                            | Suspect lines of an execution or a failure cluster: the regression context's range, its changes from source control and the coverage, joined by `@piwitests/core/suspect-lines`, kept five minutes; the database reads and the join live in `#shared/handlers/suspect-lines` (server + demo)                                                                                                                                                              |
| `mcp/coverage-tools.ts`                                       | The coverage MCP tools (`get_coverage`, `compare_coverage`, `get_coverage_loss`) over the coverage insights: a failure's path against its last pass, a test's path varying with the tests before it (the `order` flaky root cause), what quarantining tests leaves uncovered, whether a test reached target lines; the pure comparisons live in `shared/coverage-insights.ts`, the database reads in `#shared/handlers/coverage-insights` (server + demo) |
| `project-access.ts`                                           | `getProjectScope`, `requireProjectAccess`, `requireResolvedProjectAccess`, entity resolvers                                                                                                                                                                                                                                                                                                                                                               |
| `route-required-permission.ts`, `route-permission-match.ts`   | Read `x-required-permission` from compiled route metas; rou3 matching                                                                                                                                                                                                                                                                                                                                                                                     |
| `ai-*.ts`                                                     | Provider abstraction, diagnosis, context building + limits, research stage, embeddings, images, system prompt, function-catalog extraction from pasted code (rules/schema/prompt-builder live in `shared/test-function-extract-prompt.ts` — one source for the AI-calling endpoint, the dashboard's no-AI-credits "copy prompt" flow, and the MCP `create_test_function` tool description)                                                                |
| `cluster-*.ts`                                                | Similarity, semantic adjudication, naming, reconciliation                                                                                                                                                                                                                                                                                                                                                                                                 |
| `scm/`                                                        | Repo history, diffs and patch validation for AI diagnosis; on the desktop app, `local-git.ts` reads a linked clone                                                                                                                                                                                                                                                                                                                                        |
| `notifications/`                                              | `match.ts` (subscription matching → outbox rows), `dispatch.ts` (`sweepOutbox`, HMAC-SHA256 `X-Piwi-Signature`), `emit.ts`, `run-notifications.ts`                                                                                                                                                                                                                                                                                                        |
| `email.ts`, `account-tokens.ts`, `rate-limit.ts`, `crypto.ts` | SMTP transport + templates, single-use tokens (reset 1 h / verify 24 h / invite 72 h), in-memory sliding window, AES-256-GCM                                                                                                                                                                                                                                                                                                                              |
| `export-request.ts`, `export-assets.ts`                       | Offline-export endpoints' shared plumbing: format parsing, download headers, size budget, storage-backed asset reader                                                                                                                                                                                                                                                                                                                                     |
| `trace-reconstruct.ts`                                        | Rebuilds a full trace ZIP from a slim blob + the shared resource pool (pooled screenshots and frames back under their entry names); used by the file endpoint and by exports                                                                                                                                                                                                                                                                              |
| `trace-manifest.ts`                                           | The slim blob's manifest: what went to the shared pool (`resources`, and screenshots and screencast frames by content hash in `pooledEntries`); the one reader and path helper                                                                                                                                                                                                                                                                            |
| `retention.ts`                                                | Nightly pruning of runs, notification history, diagnosis versions and orphan payloads                                                                                                                                                                                                                                                                                                                                                                     |
| `compute-regression-signals.ts`                               | `isNewRegression` / `isNewFlaky` signals                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `server/tasks/notifications/sweep.ts`                         | Nitro scheduled task — sweeps the outbox every minute                                                                                                                                                                                                                                                                                                                                                                                                     |
| `otel.ts`, `server/plugins/opentelemetry.ts`                  | OpenTelemetry tracing, on when an OTLP endpoint is set: a span per request (and per request the server makes to itself during SSR), a span per SQL statement through `@kubiks/otel-drizzle`, `Server-Timing: traceparent` on responses                                                                                                                                                                                                                    |

Import orchestration is shared, not mirrored: `shared/handlers/import-runs.ts` owns everything after parsing, with
the server and demo supplying an `ImportPort` for the parts that genuinely differ.

Offline export follows the same split: `shared/export/` collects the bundle, renders the self-contained HTML and
Markdown, and writes the ZIP (fflate, so it runs in the demo's service worker too); server and demo differ only in the
`ExportAssetReader` that fetches evidence bytes. `server/utils/trace-zip.ts` is unrelated — it stores rather than
deflates and exists for trace-blob reconstruction.

A failed execution's `.piwibug` (Piwi Picker's bug report file) is the same split again:
`shared/handlers/execution-bug-report.ts` reads the execution and writes the archive, every entry stored, through the
same `ExportAssetReader`; the conversion of the stored steps into a steps document is `bugReportFromExecution` in
`@piwitests/core/execution-steps`, and the archive's text files come from `bugReportTextFiles`
(`@piwitests/core/bug-report`), which Piwi Picker writes its own archives with.

## Front end

### Pages (`app/pages/`)

`/` dashboard home · `/projects` + `/projects/[id]` · `/projects/[id]/test-functions` (the browser extension's
function catalog — add by hand, via AI extraction from pasted code, or — with no AI configured — copy a prompt for
your own AI chat and paste its reply back in) · `/projects/[id]/selections` (test selections — builder with live
preview and the runnable command) · `/projects/[id]/coverage` (a file's coverage, `?file=`: its source with how many
tests ran each line, the tests of a selected line or range and the nearest test to copy for a line none runs, a
version selector; worded by `app/utils/file-coverage.ts`, linked from the execution page's Coverage rows, the
suspect lines and the Test Map's file nodes) · `/test-runs/[id]` · `/test-cases/[id]` (stable
case across runs) · `/test-run-cases/[id]` (one execution) · `/failure-clusters/[id]` · `/analytics` (the viewer's default dashboard) + `/analytics/d/[id]` (one dashboard, `?tv=1` for TV mode) + `/analytics/dashboards` · `/settings/*` ·
`/docs` (in-app API reference) · `/mcp` · `/login`, `/forgot-password`, `/reset-password` (public, layout-free).

**Failure pages.** `/test-run-cases/[id]` (one execution) and `/failure-clusters/[id]` read top to bottom in one
column. Both open on `SituationBlock`: an identity kicker, the headline as the page's `h1`, then labelled rows in the
order of `SITUATION_ROWS` (`app/utils/situation-rows.ts`), the explanation, then the action, then the context (Most
likely `StoryLine`, Situation, State `ClusterStateLine`, Next `NextStepLine`, Cluster, Issue `IssueLine`,
Occurrences, What changed `WhatChangedLine`, The suite; a page fills the rows it has) and a facts line
(`ExecutionFactsLine`, `ClusterFactsLine`) holding Details and Raw error. On the execution page a meta line under the
headline (`ExecutionMetaLine`) says since when it fails, on which commit, and whether a newer execution of the test
failed again or passed, and the Cluster row names the cluster, then its ticket (`SituationParts` in the lead of
`IssueLine`); the cluster page has an Issue row instead. A test that passed on retry takes its headline from its
failed attempt's row (`FailureVerdict.attempt`), which the meta line names and links. The rows are built in the
handlers the demo shares (`shared/handlers/test-cases.ts`, `shared/handlers/failure-clusters.ts`) from
`shared/situation.ts` (with `shared/latest-execution.ts` over `getNewerExecutions`), `shared/cluster-state.ts` and
`computeNextStep` (`shared/next-step.ts`); `useNextStepActions` turns the Next row's action id into behavior on both pages, copying
the change the row shows (`buildNextStepChange`, `app/utils/next-step-change.ts`). Both pages choose Most likely
and word where the Next step's change comes from with `shared/most-likely.ts` (`pickMostLikely`,
`nextStepSourceLine`), one rule for the two; a test that did not run gives its reason as Most likely instead
(`DidNotRunLine`, from `describeDidNotRun` in `shared/did-not-run.ts`), and its Next opens the blocking failure or
the run (`open-blocker`, `open-run`). Under the block, the execution page shows `EvidenceTabs` (opening on the tab
`useEvidenceHint` picks from the leading clue), the `Toolbox` (More ways to fix: one folded section per way to fix, the
one the next step points at open) and History (`HistoryStrip`). The cluster page shows the section the next step points
at as a card of its own (`Toolbox` with `lead`; the sections, their order and the step each serves are in
`app/utils/fix-sections.ts`), then `ClusterInvestigation` when there is a diff to browse (with the cluster's suspect
lines in `SuspectLinesList`, marked in its diff), `ClusterAffectedTests` (its
selection picks the execution the evidence shows, with several tests), `EvidenceTabs`, More ways to fix with the other
sections folded, then the history, folded to one line each: `ClusterOccurrenceTrend` (a `ChartCard` with `foldKey`,
opened by the occurrence sparkline) and `ClusterActivity`. Both
pages provide a section locator (`clusterSectionLocatorKey`) so a clue or an AI citation reveals the evidence it cites,
and `useEvidenceHint` hands the evidence card what Most likely cites, whose tabs and timeline rows it marks
(`citedItemIds`, `app/utils/timeline-rows.ts`). Both What changed lines say what the suspect lines say
(`SuspectLinesSentence`, worded by `app/utils/suspect-lines.ts`), from the suspect-lines endpoints, fetched in the
browser after the page mounted.
`/bug-reports/[id]` opens on the same block with Situation, State, Next and The suite. `npm run app:measure` holds the
two failure pages to their budgets (text styles, controls above the fold, the Next step beside what it copies).

### Components (`app/components/`)

Domain subfolders, all auto-imported **without a folder prefix** (`pathPrefix: false`), so names are globally unique:

| Folder                                                                  | Scope                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`                                                               | Cross-page primitives and widgets — see below                                                                                                                                                                                   |
| `run/`                                                                  | Run detail: summary, cases table, workers timeline, comparison, slow endpoints, failure groups, reports, the Resources tab (`RunResources`, formatting in `app/utils/resources.ts`)                                             |
| `test-case/`                                                            | Single-execution detail: the facts line, the evidence tabs and their cards (timeline, screen, source, network, console, state, performance, attempts, locators), the did-not-run line, clues; the test page's flakiness tab     |
| `cluster/`                                                              | Failure-cluster detail: the state, what-changed and facts lines, the occurrence sparkline and trend, the affected-tests selector, investigation + baseline picker, commit browser, activity, fixed-before matches               |
| `diagnosis/`                                                            | AI diagnosis panel: context preview + coverage strip, result with evidence citations, export                                                                                                                                    |
| `integrations/`                                                         | Issue trackers: the Issue line both failure pages share, the create and link dialogs, the Jira connection, the project binding and its field defaults, the integration activity                                                 |
| `project/`                                                              | Project detail charts, flaky list, cluster list, SCM changes, subscribe bell, the tests panel of a file's coverage page                                                                                                         |
| `analytics/`                                                            | Cross-project widgets (component map in `app/utils/analytics-widgets.ts`), and the dashboard page: `DashboardPage`, `DashboardBody` (view, editor, TV mode), `DashboardSwitcher`, `AddWidgetSlideover`, `WidgetConfigSlideover` |
| `bug-reports/`                                                          | Bug report detail (Piwi Picker): the reported steps (`BugStepText`, from core's step parts), the evidence, the generated spec                                                                                                   |
| `gaps/`                                                                 | Test Map: the feature graph and map views, the node inspector, the scenario gaps panel                                                                                                                                          |
| `notifications/`, `reports/`                                            | Notification channels and subscription scope; quality reports: the schedule form and list, previews, snapshots                                                                                                                  |
| `home/`, `layout/`, `settings/`, `apps/desktop/`, `apps/docs/`, `demo/` | Home filters; app shell/nav; settings surfaces; desktop-only cards; in-app API reference; demo-only banner, simulator and guided tour                                                                                           |

Shared building blocks worth knowing before writing new markup (`AGENTS.md` makes reuse a rule):

- **Structure** — `SectionCard` (standard icon/title/count/subtitle header, `actions` + `footer` slots),
  `CollapsibleSectionCard` (same contract + required `storageKey`, cookie-persisted fold state via `useFoldedState`,
  `#folded` peek slot), `FoldableSummary`, `DetailPageLayout` (summary + tabs + panels with correct flex height at `lg`+,
  single-document scroll below).
- **States** — `EmptyState`, `LoadingState`, `ErrorState` (with an `action` slot).
- **Connection requests** — `ConnectRequestCard` (the logo-and-card page, with its loading and error states) and
  `ConnectRequestButtons` (Deny / Allow), driven by `useConnectRequest`: the page a signed-in user answers a client's
  request on, Piwi Picker's and the editors' (`/extension/connect`) and an MCP client's OAuth sign-in (`/oauth/consent`).
- **Piwi Picker install hint** — `PickerInstallHint` (one line on what the extension does on that page, the store of
  this browser and _Don't show again_), driven by `usePickerInstallHint`: shown only in a browser the extension exists
  for (`pickerStoreFor`), never in the desktop window, and never once the extension marked the page
  (`@piwitests/core/picker-marker`, which it does on its connected instance's pages). Placed where the extension is the
  next step: an empty bug reports list, an empty test function catalog, the Locators page's empty check box.
- **Filters** — `FiltersBlock` (the bordered _Filters_ block every page's filters sit in, folding to a summary on a
  phone), `FilterBar` (environment, branch, branch policy via `BranchPolicySelect`, full runs only) and
  `HiddenRunsNote` (what the filters hide, with the action that shows it).
- **Data display** — `StatTile` + `StatTileGrid` (auto-fitting, no per-page breakpoints), `TableScroller`,
  `FilterToolbar`, `ChartCard` (header + `legend`; `foldKey` folds it to one line), the SVG chart primitives `ChartFrame` (self-measuring plot area,
  y-axis) / `ChartTooltip` / `ChartMarkerLines` / `ChartLegend` / `ChartMarkerTooltip`, `MiniRunBars`,
  `DurationValue` (tight `210ms` via
  the pure `splitDuration`), `CodeBlock`, `MarkdownPreview`, `DiffPatch` / `DiffFile`, `CoverageSourceView` (a source
  file with the lines a coverage ran and the executable lines it did not marked, the functions that ran linked above
  it, an optional per-line annotation column; the line numbers alone without the source), `LocatorCode` (a locator
  expression syntax-highlighted through `@piwitests/picker-dom`'s `tokenizeLocator`), `ErrorText` (error text with
  its ANSI colors rendered — a one-line `line` preview for lists and cells, or the full `block`), `DeferredTooltip`
  (a `UTooltip` built on the pointer's first entry, for a tooltip repeated on every row of a list).
- **Test lists** — `TestRow` + `TestRowGroup` (one test or group header, read the same in every list),
  `TestSearchInput` (the search box of the run and project Tests tabs: qualifiers, completion of the term under the
  caret, Ctrl+F through `useFindShortcut`) and `SearchHighlight` (marks what a search matched). The language lives in
  `shared/test-search.ts` — parser, in-memory matcher, highlight ranges, completion — with its SQL form in
  `shared/utils/test-search-sql.ts` for the paged catalog; run and file order and the File / File + Describe rows in
  `app/utils/test-list-order.ts`.
- **Navigation & actions** — `NavbarActions` (every `UDashboardNavbar` `#right` group; labels collapse to icons below
  `xl`), `BreadcrumbNav` (drop-in for `UBreadcrumb` and the page title of every detail page — the navbar never
  repeats it; only the current crumb truncates, middle levels hide below `2xl`, ancestors collapse into a dropdown
  below `sm`), `OpenInIdeLink` +
  `OpenInIdeSettingsModal`, `DocLink`, `LinkChip` / `EntityLinks`.
- **Help & settings** — `HelpHint` (topic keys from `app/utils/help-content.ts`), `SettingsField`, `EnvManagedBadge`,
  `EnvManagedAlert`.
- **Domain widgets** — `RunStatusBadge`, `StatusChip` (status icon + label in one badge, for detail summaries),
  `TestStatusBar`, `TagBadge` / `TagsSelect`, `BrowserBadge`, `MarkerBadge` / `MarkerFormModal`,
  `ZoomableImage` (a click / keyboard-accessible image with a hover "Enlarge" affordance) driving
  `ScreenshotLightbox` (full-screen, keyboard-navigable, with an actual-size zoom toggle for large captures and a
  details panel naming the test, the step and the error raised on the page — `LightboxImage` in
  `app/utils/lightbox.ts`),
  `VideoPlayer`, `TraceListItem`, `LocatorHealingPanel` / `LocatorAlternativeRow`,
  `SnapshotLocatorPicker`, `EnvironmentDiffCard`, `DataLocationCard`.
- **Failure pages** — `SituationBlock` (the labelled block the failure pages and a bug report open on: its rows in
  `SITUATION_ROWS`, the status color on its left edge), `FailureHeadline` (the one-line headline, its locator in a chip when it
  is the `h1`), `StatusChip` in the block's identity kicker, `StoryLine` (Most likely), `NextStepLine` (the one
  recommended step, its actions emitted as ids the page handles through `useNextStepActions`), `Toolbox` (More ways
  to fix, one folded section per way) and `HistoryStrip` (this test's recent executions as a row of squares).

### Composables & utils

`app/composables/` covers cross-component state and behaviour — auth and dashboard shell, run streaming
(`useRunStream`, `useNotificationStream`), diagnosis (`useClusterDiagnosis`, `useStreamingDiagnosis`,
`useDiagnosisNotification`), timeline (`useTimelineModel`, `useTimelineViewport`, and `useExecutionTimeline`, an
execution's failure timeline under one key for its Timeline and Network tabs), fold/tree state
(`useFoldedState`, `useFoldableSummary`, `useTreeViewCookie`), settings derivation (`useSettingsNav`,
`useSettingsEnvState`), analytics scope, the run page's retry command (`useRunRetryCommand` — one failing set and one
shared mode for every copy button on the page), IDE preferences (`useOpenInIde`), desktop detection (`useIsDesktop`,
`useTauri`), demo helpers (`useDemoTour`, the guided tour's state and its driver.js run), and small utilities
(`useCopy` / `useCopyRich` — use these instead of hand-rolling `navigator.clipboard`, `useAiStatus`, `useChartTooltip`).

`app/utils/` holds pure helpers: `index.ts` (`formatDuration`, `splitDuration`, `getStatusColor`, `getFileApiPath`,
`formatRelativeTime`, `createSortHeader`, `formatBytes`, `errorMessage`, patch/commit helpers, cluster colour maps),
`page-error.ts` (`showPageLoadError`: a detail page whose entity does not load shows `app/error.vue`, inside the
dashboard layout, and answers with the API's 404 or 403),
`performance-hints.ts`, `ide-links.ts`, `help-content.ts`, `settings-metadata.ts`, `openapi.ts` / `openapi-console.ts`,
`status-palette.ts` (`STATUS_PALETTE` / `statusPalette` — the test outcome colors every bar, chart, history cell,
timeline bar and filter chip uses, backed by the `--color-status-*` tokens in `assets/css/main.css`), `pass-rate.ts`
(the one threshold set and color scale for every colored pass rate, heatmap cells included), `duration-tone.ts` (the
one tone of a timeline duration that stands out in its test, by the rule of
`shared/duration-standout.ts`: at least 1 s, and a third of the test or much slower than its usual time over the
last passing runs; that module also holds the much-slower rule, the usual durations the timeline sends, and the step
match key the Attempts tab's `shared/attempt-diff.ts` compares attempts with), `chart.ts` (the
per-chart series definitions the plots and their legends share, and the tick/stack/bar geometry behind the SVG
charts). `retry-command.ts` (`buildRetryCommand` — `file-line` / `grep` / `file` modes,
shell-escaped, capped at 4096 chars; `buildTitleGrepFlag` — the regex-escaped, shell-quoted `-g` flag the fix plan and
auto-heal verify commands add) and `locator-edit.ts` (`buildLocatorEdit` — rewrite the failing locator call on a
source line) now live in `shared/` so the server and demo share them (the fix plan builds the same verify command and
edits); thin `app/utils/` re-export shims keep them auto-imported. Locator-line edits become a git-applyable unified
diff via `shared/heal-edit.ts` (`buildHealEdit` / `buildUnifiedLineDiff`), and `shared/callsite-location.ts`
(`parseCallsiteLocation`) parses a captured `file:line:col` (drive-letter-safe). `app/utils/demo-tour/` holds the
demo's guided tour as data: the tours (`TOUR_PROFILES`), their words (one `copy.<code>.ts` per language, registered in
`TOUR_COPY`), the tour languages, the `**bold**` markup and the prompt's stored state.

The coverage insights (`#shared/coverage-insights`) reach the UI where the project's coverage capability is active,
and render nothing elsewhere: a failed execution's Coverage section compares it with the test's last passing run
(`CoverageDivergencePart`, a file both ran at one version unfolding to `CoverageDivergenceSource`), the test page's
`PathVariationCard` names the earlier test a path depends on, and every quarantine action previews the code only its
tests run (`CoverageLossPreview`; beside a bare button, `CoverageLossPopover` on hover or focus), read through
`useCoverageLoss` when the action is about to be taken. Their wording is `app/utils/coverage-insights.ts`. Both AI
contexts, the server's and the demo's, carry the divergence through `coverageDivergenceContext`
(`#shared/handlers/coverage-insights`).

## Demo SPA

`PIWI_DEMO_MODE=true` builds a client-only SPA: a PWA service worker (`app/service-worker/demo-sw.ts`) intercepts
`/api/` and serves it from in-browser sql.js (WASM SQLite) through Drizzle, persisted in IndexedDB. `app/demo/api/router.ts`
dispatches to per-domain handlers that mirror the server; `app/demo/db.client.ts` is shared by SW and main thread.
Live updates use a BroadcastChannel instead of SSE. The demo build also mounts the guided tour (`public.demoTour`):
`DemoTour` in `app.vue` asks a first-time visitor's role and walks that role's seeded screens with a driver.js popover
on a `data-tour` element of each, driven by `useDemoTour`; the tours are `TOUR_PROFILES` and their words one
`copy.<code>.ts` per language, both in `app/utils/demo-tour/`. Rules and invariants: see `AGENTS.md`.

## Key features

Auto-created projects on first submission · run ingest by JSON, multipart upload or live streaming (with shard merge and
crash recovery) · HTML reports, traces, videos and screenshots stored under `.data/storage/` with relative paths ·
flaky detection with root-cause classification and impact scoring · failure clustering with semantic merge suggestions ·
AI diagnosis grounded in real SCM diffs, optionally two-stage · locator healing · timeline markers · notifications
(email, Slack, webhook, browser) · an MCP server for AI agents · optional auth with project roles and groups ·
retention and storage housekeeping · offline export of an execution or a cluster as self-contained HTML, a ZIP of the
raw evidence, or a printed PDF.
