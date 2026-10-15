# API contract drift

A plan to catch the API changes that break a front end, from the traffic the tests already make. The capture fixtures
record the **shape** of each JSON request and response (field names and types, never values). The dashboard keeps
those shapes per endpoint, compares a run's shapes with its baseline, and says what changed: in a clue on the failing
test ("`GET /api/cart` no longer returns `items[].price`, a number in the last passing run; first seen on commit
`abc1234`"), in the run's Changes tab, and in the pull-request comment. An API view lists every endpoint the suite
calls with its shape history, exports what the suite observed as an OpenAPI document, and compares it with the
project's declared OpenAPI.

**Status.** Proposed 2026-09-27. Nothing is built. The capture is opt-in (`captureApiShapes`). It adds an attachment,
a payload column on `test_runs_cases` and three tables; the attachment, the wire field, the option and the new
endpoints freeze at 1.0 (one new D entry in [`1.0-stabilization.md`](1.0-stabilization.md)).

**Summary.** When a backend renames a field, the front end breaks in a way end-to-end tests see only indirectly: a
price renders as `NaN`, a list is empty, a click waits for an element that never appears. The failure's error names a
locator or a timeout, not the API. Piwi already records every request a test's page makes (method, URL, status,
timing), but never its body, so the cause stays invisible. This plan adds the body's shape: a small type tree built in
the test worker from the parsed JSON, bounded in size, with keys that look like data collapsed so no identifier
leaves the machine. Shapes are deduplicated by hash, stored per execution and indexed per endpoint. A run's shapes are
compared with the baseline the Changes tab already picks, and a failing execution's shapes with the same test's last
passing execution, the way the page-structure diff works. Removed fields, changed types and newly nullable fields are
reported as breaking; added fields as additive. The first run that showed a new shape names the commit. The same
shapes give an observed OpenAPI document and a comparison with the declared one.

## What the reader gets

```
Failing execution · cart › shows the total
  ⚑ The API changed under this test
    GET /api/cart (200) no longer returns items[].price — a number in the last passing run.
    It now returns items[].unitPrice (number). First seen in run #812 on commit abc1234 (Rename price field).
    The test failed 1.2 s after that response.
```

```
Run #812 · Changes against #809 (main, same environment)
  API changes · 2 breaking · 1 additive
    GET  /api/cart        200   − items[].price (number)   + items[].unitPrice (number)     4 tests
    POST /api/orders      201   total: number → string                                      2 tests
    GET  /api/products    200   + items[].badge (string, optional)                          9 tests
```

```
API · Acme Mugs · main · 37 endpoints the suite calls
  GET /api/cart   200 · 3 shapes in 30 days · 14 tests · p90 120 ms · declared ✓ (1 mismatch)
    abc1234 · run #812 → now     { items: [{ id: string, unitPrice: number, qty: integer }], total: number }
    7f3e2d1 · run #640 → #811    { items: [{ id: string, price: number, qty: integer }], total: number }
  [Download observed OpenAPI]
```

- Part 1 alone records shapes and serves them through MCP.
- Part 2 adds the clue, the Changes tab section, the pull-request section and the AI context lines.
- Part 3 adds the API view, the observed OpenAPI document and the comparison with a declared OpenAPI.

## What exists

- **Network capture reads no bodies.** The capture fixtures listen to `requestfinished` on the page
  (`packages/reporter/src/internal/capture/capture-fixtures.ts`, `instrumentPage`), keep fetch, xhr, document and other,
  and record method, URL, status, duration, start time, content type and the backend's log and trace headers. Response
  bodies are read only by probe interception (`internal/probe/interception.ts`), to mutate them. Request bodies are
  never read.
- **Network rows are filtered on the server.** Every request with status 400 or more, plus the 50 slowest others, is
  kept in `network_requests` (`shared/utils/filter-network-requests.ts`), with the URL's query stripped and a
  `normalized_url` built by `normalizeRoute` (`packages/core/src/page-key.ts`: ids, UUIDs, ULIDs, JWTs and tokens
  collapsed; query keys kept with `<redacted>` values).
- **Endpoint keys agree.** The Test Map's route nodes (`routeNodeKey` in `shared/graph.ts`), slow endpoints
  (`shared/handlers/analytics/slow-endpoints.ts`) and the run's endpoint aggregation all key on method plus
  `normalized_url`.
- **API tests are observed.** Since 2026-10-14 the capture fixtures hand out every `APIRequestContext` behind a proxy
  (`packages/reporter/src/internal/capture/api-requests.ts`): those `playwright.request.newContext()` creates, the
  `request` fixture's among them, and each browser context's own `page.request`. Each call is a `piwi-network` entry
  without a `resourceType`, with its response's `X-Piwi-Logs`, `X-Piwi-Trace` and `X-Piwi-Coverage` read.
- **Per-execution payloads.** Large per-execution data goes through `case_payloads` (content-addressed per project),
  with a payload column on `test_runs_cases`; `apps/application/AGENTS.md` has the checklist, and `piwi-page-inventory`
  and `piwi-locator-pages` follow it.
- **Reporter options.** An option is declared with JSDoc in `public/options.ts`, given a default, an env key and a
  fallback row in `internal/config/env.ts`, and bridged into the worker's environment; `capturePageInventory` is forced
  off when `collectPerformanceMetrics` is false. `reference/reporter-options.md` is generated from those.
- **Baselines.** `selectBaselineRun` (`server/utils/branch-baseline.ts`) picks the run-level baseline (same environment
  and branch, then the fallback branch, then any), used by the Changes tab (`computeRunInsights`,
  `shared/handlers/run-insights.ts`), regression signals, the gate and PR feedback. Per-execution diffs (environment,
  page structure) rank the same test's passing executions with `rankBaselineCandidates` (`shared/baseline-order.ts`).
- **Clues.** `buildFailureClues` (`shared/failure-clues.ts`) adds rules to a `FailureClueRule` union and `RULE_ORDER`,
  at most 8 clues; `loadFailureClueInput` (`shared/handlers/test-cases.ts`) loads the evidence, including the
  environment and page diffs. `reference/clues.md` must list every rule id (checked by `tests/unit/docs-drift.test.ts`).
- **The Changes tab** (`app/components/run/ChangesView.vue`) shows new failures, fixed, still failing, newly flaky,
  slower and faster, commits since the baseline and environment changes.
- **The pull-request comment** (`buildPrComment`, `shared/pr-feedback.ts`) lists new failures, pre-existing, flaky, new
  clusters, fixed, then uncovered changes.
- **Declared surface.** The Test Map stores declared routes from `piwi.manifest.json`, the instrumentation's
  `/__piwi/manifest` and a per-project OpenAPI URL (`projects.openapi_url`). `parseOpenApiSpec` (`shared/openapi.ts`)
  keeps path, method and numeric response codes only, not schemas. Declared patterns go through
  `normalizeManifestPattern` (`shared/graph.ts`), which maps placeholders to `:id` or `:uuid` and drops the query, so a
  declared key and an observed key with a `:ulid` segment or a query do not join.
- **The AI context** lists failed and slow requests from the fixtures, and up to two masked response-body excerpts of
  failed requests from the trace (`server/utils/ai-context.ts`).
- **The backends.** The Nitro instrumentation sees response bodies before serialization (its data-fault hook,
  `integrations/nitro/src/index.ts`); the ASP.NET Core middleware writes its headers before the body and has no body
  access.
- **No per-endpoint page exists.** Slow endpoints are a table on the project page and an analytics widget; the Test Map
  has a node inspector.
- **Privacy.** `guide/privacy.md` states what is not captured (input values, storage values, inventory field contents)
  and that sensitive headers and token-shaped strings are masked in traces. It says nothing about fixture network
  bodies, because none are read.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | A shape holds field names, JSON types and a string format hint (`date-time`, `date`, `uuid`, `email`, `uri`), never a value. | Enough to see a rename or a type change; nothing that identifies a user or a record. |
| D2 | Object keys that look like data become a map: keys matched by `normalizeRoute`'s id, UUID, ULID, token and JWT rules, emails, or an object with more than 50 keys. | A response keyed by user id or email would otherwise send identifiers as field names. |
| D3 | Shapes are built in the test worker and bounded: JSON bodies up to 1 MB, depth 8, 200 keys per object, 2,000 nodes per shape, 3 samples per endpoint, status and direction per test. Beyond that the shape is marked truncated. | The body never leaves the worker, and the cost is capped per test. |
| D4 | Capture is opt-in (`captureApiShapes`, `PIWI_CAPTURE_API_SHAPES`), forced off with `collectPerformanceMetrics: false`. The default is revisited once the bench measures it. | Reading bodies costs a protocol round trip per response. A capture option starts off, as the page inventory did. |
| D5 | An endpoint is `METHOD path` with `pageKey` normalization (no query), plus the status and the direction (request or response). A GraphQL `POST` keys on its `operationName`. | Query values change nothing about the shape; statuses have different bodies; every GraphQL operation shares one URL. |
| D6 | Shapes are content-addressed by the hash of their canonical form and stored once per project. | The same shape is seen by many tests on many runs. |
| D7 | Run drift compares with the run-level baseline (`selectBaselineRun`). A failing execution compares with the same test's last passing execution (`rankBaselineCandidates`). | The same baselines the Changes tab and the page-structure diff use, so the reader sees one story. |
| D8 | Breaking: a field present in every baseline sample and absent from every current one; a changed type; a field that is newly null; a new status for the same call. Additive: a new field, a field newly optional. | A field seen only sometimes (an optional field, an empty list's items) must not be reported as removed. |
| D9 | The observed OpenAPI document is an export, never a declared surface. | Feeding it back as declared would make "declared, never hit" meaningless. |
| D10 | Declared and observed endpoints join on method and a path whose placeholders are all `:param`. | The two normalizations differ today (`:id`/`:uuid` against `:id`/`:uuid`/`:ulid`/`:token`/`:jwt`). |

## Part 1 — Shapes

### 1.1 The shape model

`packages/core/src/api-shape.ts`, pure and dependency-free:

- `ApiShape` is `{ t: 'string', f? } | { t: 'number' } | { t: 'integer' } | { t: 'boolean' } | { t: 'null' } |
  { t: 'object', p: Record<string, { s: ApiShape, n: number }>, of: number } | { t: 'map', v: ApiShape } |
  { t: 'array', i: ApiShape | null } | { t: 'union', o: ApiShape[] } | { t: 'truncated' }`. For objects, `n` counts the
  samples a field appeared in and `of` the samples merged, which gives optional fields without guessing.
- `shapeOf(value, limits)` builds a shape from parsed JSON (D2, D3). `integer` is a number with no fraction in every
  sample; a later fractional sample merges it to `number` without reporting a change.
- `mergeShapes(a, b)` unions two shapes (object fields add their counts, `null` with a type gives a union, an empty
  array's `null` items merge into the other side's).
- `canonicalShape` and `shapeHash` give a stable string (sorted keys) and a SHA-256 over it.
- `diffShapes(before, after)` returns `ShapeChange { path, kind: 'removed' | 'added' | 'type' | 'nullable' |
  'optional' | 'format', before?, after?, severity: 'breaking' | 'additive' }`, with paths like `items[].price`
  (D8).
- `shapeToJsonSchema` and `jsonSchemaToShape` convert to and from the JSON Schema subset OpenAPI 3.1 uses (`type`,
  `properties`, `required`, `items`, `additionalProperties`, `oneOf`/`anyOf`, `enum` as its type, `format`).

### 1.2 Capture on the page

In the capture fixtures, with `captureApiShapes` on:

1. In the existing `requestfinished` handler, for a fetch or xhr response whose content type is `application/json` or
   ends in `+json`, and whose `content-length` (or body length) is at most 1 MB, read `response.body()`, parse it and
   build its shape. A request with a JSON body (`request.postDataJSON()`) gets a request shape the same way. The work
   joins `sink.pendingHandlers`, which `flushSink` already awaits.
2. For GraphQL (a `POST` whose JSON body has a string `query`), the endpoint key gets `#<operationName>`, or `#anonymous`.
3. Per test, samples are merged per `(key, status, direction)`, at most 3 each (D3). A parse error or a non-JSON body
   skips the response without failing the test.
4. At the end of the test, the fixture attaches `piwi-api-shapes`:
   `{ v: 1, shapes: Record<hash, ApiShape>, uses: [{ key, status, direction, hash, samples, at }] }`, with `at` the
   first sample's time relative to the test's start, which the clue needs.

The dogfood fixtures in `apps/application/tests/fixtures.ts`, which reimplement the network capture, call the same
shape functions so the dashboard's own suite exercises them.

### 1.3 Capture in API tests

The proxy that records API calls (`api-requests.ts`, built for coverage) already wraps the `APIRequestContext` methods
(`fetch`, `get`, `post`, `put`, `patch`, `delete`, `head`) and hands each call's `APIResponse` to `recordApiCall` in
`capture-fixtures.ts`, where each response with a JSON content type is shaped the same way (`response.body()` is
buffered by Playwright, so reading it does not consume it for the test); the call's `data` option is added to `ApiCall`. The request body is
shaped from the `data` option when it is an object. API tests then get shapes, and nothing else changes for them.

### 1.4 Wire and storage

1. The reporter parses the attachment into the wire's `apiShapes` field. On the server it is stored per execution
   through `case_payloads`, with an `api_shapes_payload_id` column on `test_runs_cases` and the usual retention rule.
2. `api_shape_defs (project_id, hash, shape, size)`, unique on `(project_id, hash)`: each shape once (D6).
3. `api_shape_uses (project_id, test_case_id, branch, key, status, direction, hash, first_seen_run_id, first_seen_at,
   last_seen_run_id, last_seen_at)`, unique on `(test_case_id, branch, key, status, direction, hash)`, indexed on
   `(project_id, key)`: which tests saw which shape, built on ingest like `locator_usages`.
4. `run_api_shapes (run_id, key, status, direction, hash, samples)`: the shapes of one run, written when the run
   finalizes, for run-to-run comparison and "first seen".
5. Retention: `run_api_shapes` rows go with their run; `api_shape_defs` rows no use and no payload references are swept
   with the orphan payloads.

## Part 2 — Drift

### 2.1 Run against baseline

`computeRunInsights` gains `apiChanges`: for each `(key, status, direction)` in both the run and its baseline, the
merged shapes are compared with `diffShapes`. Keys only in this run are listed as "new endpoints" (additive); keys only
in the baseline are not changes (the run may simply not have run those tests). Each change carries the tests of this
run that saw the new shape.

### 2.2 First seen

For a changed key, the earliest run on the same branch whose `run_api_shapes` holds the new hash names the change:
"first seen in run #812 on commit `abc1234` (Rename price field)", from the run's `metadata.scm`.

### 2.3 The clue

A new rule `api-shape-changed` in `shared/failure-clues.ts`. `loadFailureClueInput` adds, for the failing execution,
the changes between its shapes and those of the same test's last passing execution (D7), limited to requests whose
`at` is before the failure time. The clue is strong when a breaking change is found, and cites the network entry.
Stories (`buildStory`) gain a pairing: an `api-shape-changed` clue with a locator or assertion failure after it reads
"the page changed because the API did". Listed in `reference/clues.md`.

### 2.4 Changes tab, pull request, AI, MCP

- **Changes tab.** An **API changes** section after Environment changes in `ChangesView.vue`: breaking first, each row
  with the key, status, the change, the first-seen commit and the tests.
- **Pull request.** A section in `buildPrComment` after Fixed, listing breaking changes (at most 10) and counting
  additive ones. It follows the `api-drift` capability.
- **AI context.** A line per breaking change of the failing execution in `server/utils/ai-context.ts`, capped with the
  other network lines.
- **MCP.** `get_api_changes { runId | testRunCaseId }`.

## Part 3 — The API view and contracts

### 3.1 The view

An **API** page (`/projects/:id/api`), opened from the project menu beside Locators, Selections and Test functions,
and from each row of the slow endpoints table on the Performance tab. It is fed by `GET /api/projects/:id/api?branch=`:

- Each endpoint the suite calls: key, statuses, shape versions in the window with their first and last runs and
  commits, the tests that call it, and its timing from the slow-endpoints handler.
- An endpoint's page shows the current shape as a tree (optional fields marked, formats shown), the diff between any two
  versions, and the tests.

### 3.2 Observed OpenAPI

`GET /api/projects/:id/api/openapi.json?branch=` builds an OpenAPI 3.1 document: paths from keys (`:param` becomes
`{param}`), operations per method, `requestBody` from request shapes, responses per status with an
`application/json` schema from `shapeToJsonSchema`, and `x-piwi-observed: { tests, lastSeenAt }` on each operation.
A download button on the view; the MCP tool `get_api_contract` returns one endpoint's part.

### 3.3 Declared against observed

When the project has an OpenAPI URL:

1. `parseOpenApiSpec` also keeps JSON response and request schemas, resolving local `$ref`s under
   `#/components/schemas` (depth 8, same 5 MB and 2,000-route caps), converted with `jsonSchemaToShape`.
2. They are stored per declared route in `api_declared_shapes (project_id, key, status, direction, shape)`, refreshed
   with the declared surface (`refreshOpenApiSurface`).
3. Joined on D10's key, `diffShapes(declared, observed)` gives mismatches: a field observed but not declared, a required
   field never observed, a type that differs, a status observed but not declared. The view shows them per endpoint.
4. With the Test Map on, a new detector `contract-mismatch` turns them into gaps in the Gaps tab, with the usual triage
   and precision loop.

## Delivery

| PR | Content | Needs |
|---|---|---|
| 1 | Core shape model with tests | — |
| 2 | Page capture, the option, the attachment and wire field; the dogfood fixtures | 1 |
| 3 | Storage: payload column, `api_shape_defs`, `api_shape_uses`, `run_api_shapes`, retention, demo seed, `get_api_changes` | 2 |
| 4 | Drift: insights, Changes tab, clue and story, PR section, AI lines, capability `api-drift` | 3 |
| 5 | API view and observed OpenAPI, `get_api_contract` | 3 |
| 6 | API tests: the `request` fixture wrapper | 2 |
| 7 | Declared against observed: schema parsing, `api_declared_shapes`, view, the Test Map detector | 5 |

Each PR carries its docs. PR 6 can land any time after PR 2.

## File-by-file checklist

### PR 1 — core
- `packages/core/src/api-shape.ts` (new), export in `packages/core/package.json`.
- `packages/core/tests/api-shape.test.ts`: maps from id-like keys and emails, bounds and truncation, merge counts,
  integer to number, empty arrays, every `diffShapes` kind, JSON Schema round trips.

### PR 2 — capture
- `packages/reporter/src/public/options.ts` (`captureApiShapes` with JSDoc), `internal/config/env.ts` (default, env key,
  fallback row, bridge), `internal/capture/api-shapes.ts` (new), `capture-fixtures.ts`, `attachments.ts`
  (`piwi-api-shapes`), collected and wire types, serializer, `public/reporter.ts`; `packages/core/src/wire.ts`.
- `apps/application/tests/fixtures.ts`.
- Docs: `guide/capture-fixtures.md` (a row), `guide/privacy.md` (shapes: names, types and formats only; map
  collapsing), `reference/reporter-options.md` (generated).
- Tests: a fixture server with JSON, `+json`, oversized, invalid and GraphQL responses; request bodies; bounds.

### PR 3 — storage
- Schema (SQLite and PG) and generated migrations; `persist-run-cases.ts`; `server/utils/api-shapes.ts` (new: uses and
  run shapes); `run-finalize-side-effects.ts`; `retention.ts`; `submit.post.ts`, `upload.post.ts`,
  `map-complete-event.ts`; `shared/types.ts`.
- Demo: `scripts/generate-demo-seed.mjs` with a renamed field in one run, `app/demo` handlers.
- `shared/mcp-tools.ts`, `server/utils/mcp/tools.ts` (`get_api_changes`).

### PR 4 — drift
- `shared/handlers/run-insights.ts`, `app/components/run/ChangesView.vue`.
- `shared/failure-clues.ts` (`api-shape-changed`, story), `shared/handlers/test-cases.ts` (loader),
  `apps/docs/reference/clues.md`.
- `shared/pr-feedback.ts`, `server/utils/scm/pr-feedback.ts`, `server/utils/ai-context.ts`.
- `shared/capabilities.ts`, `shared/handlers/setup-status.ts`, `app/utils/setup-capabilities.ts`,
  `shared/piwi-features.ts`.
- Docs: `features/api-drift.md` (new), `features/run-changes.md`, `features/pr-feedback.md`, `features/evidence.md`
  (the clue), `navigation.ts`.

### PR 5 — the API view
- `server/api/projects/[id]/api.get.ts`, `api/openapi.json.get.ts` (new), `shared/handlers/api-shapes.ts` (new),
  `app/pages/projects/[id]/api.vue` (new), `app/components/project/ApiEndpointDetail.vue` (new), the project menu in
  `app/pages/projects/[id]/index.vue`, `ProjectSlowEndpoints.vue` (row links).
- `get_api_contract` MCP tool. Docs: `features/api-drift.md`.

### PR 6 — API tests
- `capture-fixtures.ts` (`recordApiCall`, on the existing proxy), `internal/capture/api-shapes.ts`.
- Docs: `guide/capture-fixtures.md`. Tests: a spec using `request.get` and `request.post` against the fixture server.

### PR 7 — declared against observed
- `shared/openapi.ts` (schemas, `$ref`), `server/utils/surface-manifest.ts`, schema and migrations for
  `api_declared_shapes`, `ApiEndpointDetail.vue`, `shared/handlers/scenario-gaps.ts` (`contract-mismatch`),
  `apps/docs/reference/gap-detectors.md`.

## Verification

1. A fixture app whose `GET /api/cart` returns `price`, and a test that renders the total. Run it green, then rename
   the field on the server and run again: the test fails; the execution's first clue is `api-shape-changed` naming
   `items[].price`; the Changes tab lists the change with the commit; the pull-request comment lists it.
2. Return a list that is sometimes empty: no removed-field report for `items[]`.
3. Return an object keyed by user ids: the shape shows a map, and no id appears in the payload (checked by a test that
   searches the stored JSON for the ids).
4. Run the dashboard's own suite with shapes on: every Nitro endpoint it calls appears in the API view; the observed
   OpenAPI document validates as OpenAPI 3.1.
5. Point the fixture project at an OpenAPI file that declares `price` as required: the endpoint shows the mismatch.
6. `npm run reporter:bench` with the option on and off; the result goes into the option's docs.

## Risks

- **Cost.** Reading bodies adds a protocol round trip per JSON response. The size cap, three samples per endpoint per
  test, the opt-in default and the published bench bound it.
- **Noise from optional data.** A field that appears only for some records looks removed when those records are absent.
  D8's rule (present in every baseline sample, absent from every current one) and merging across the run's executions
  keep this down; the view shows sample counts.
- **Field names as data.** Map detection (D2) covers ids, emails and wide objects; a map with few, word-like keys
  (`{ "draft": …, "sent": … }`) stays an object, which is correct for its shape.
- **Stale baselines.** A baseline run without shapes (the option was off) gives no drift, and the section says "no
  shapes in the baseline" rather than "no changes".

## Open questions

1. **Server-side shapes from the Nitro instrumentation.** It could emit shapes for requests the browser never makes
   (server-to-server calls). Recommendation: not now; the browser's view is what breaks the front end.
2. **Where the API view lives.** Recommendation: its own page from the project menu, as Locators is, since it is a
   catalog with a detail view; the Performance tab links into it. Revisit if the project page gains an Insights tab.
3. **Default on.** Recommendation: decide after the bench on the dogfood suite and one real project.

## Not in this plan

- Contract tests generated from observed shapes (Pact-like). The observed OpenAPI document can seed them elsewhere.
- Value-level checks (a price that became negative). Values never leave the worker.
- Non-JSON bodies (XML, form data, protobuf, server-sent events).
- Alerting on additive changes.
