# Run ingestion: agent guide

Rules for the routes that write runs (the reporter's `setup`, `start`, `begin`, `events`, `heartbeat`, `case-files`,
`finish`, `submit`, `upload` and `upload/results`, and the imports) and for what they write. Read
[`../../../AGENTS.md`](../../../AGENTS.md) and [`../AGENTS.md`](../AGENTS.md) first.

## Finish-time side effects

- **Every path that completes a run calls `runFinalizeSideEffects`** (`server/utils/run-finalize-side-effects.ts`):
  `finish`, `upload` (a new run, or a report attached to a streamed one), `submit`, the last shard of a sharded run
  (`finalizeShardedRun`), and `settleFinalizingRun` (`server/utils/finalizing-runs.ts`) for a `finalizing` run, from
  its report upload or the stale-run sweep. A new side effect goes in that helper, never in a route.
- **That helper decides which runs get which side effect.** A probe or flake-lab run gets none (the `run-health` use of
  `isEligibleRun`, `shared/run-eligibility.ts`), as an import gets none. After the project's repository is pinned
  (`pinProjectRepository`), the environment-incident check (`recordRunHealth`, `shared/handlers/run-health.ts`) runs
  before every verdict and is awaited: a run it flags sends one
  `environment.incident` event in place of its verdicts (regression signals, analysis, AI diagnosis, notifications,
  pull-request feedback, auto-heal). The comment on the helper lists the order of the rest and the use each step
  follows.

## Writing run cases

- **Run cases are written only through `persistRunCases`** (`server/utils/persist-run-cases.ts`, mirrored for the demo
  in `app/demo/api/reporter.ts`): every ingest route hands it the mapped cases, never an `insert` of its own.
- **A test's identity is stored as `storableRunCase` makes it** (`server/utils/storable-values.ts`): its file,
  describe path and title stay whole while together they fit one PostgreSQL index entry, past it each over 800 bytes
  keeps its head and a hash, as a project name over 800 bytes always does. A lookup by the names a client sends
  passes them through `storedTestIdentity` first (`storedIdentityForms` without the describe path), as
  `[id]/case-files` does (`tests/unit/stored-identity-lookups.test.ts`).

## Timed-out tests fold into `failedTests`

`test_runs` has no `timedOutTests` column. Playwright's `'timedOut'` (stored as `'timedout'`) counts as failed, so that
`total = passed + failed + skipped + didNotRun` reconciles and matches the UI.

- **Every ingest site counts failures through `shared/utils/test-counts.ts`**, never `failedTests: body.failedTests`:
  `sumFailedAndTimedOut(body.failedTests, body.timedOutTests)` where the body carries counters (`finish`, `submit`,
  `upload`, `batchShardTally` and the demo's `app/demo/api/reporter.ts`), `countFailedFromTally(insertedStatusCounts)`
  where the route counts the rows it inserted (`events` and its demo mirror).

## Sharding

How a run is identified:

- **The run label** comes from `resolveRunLabel` (`packages/reporter/src/internal/support/ci.ts`), which the reporter
  and `createGlobalSetup` both call: `PiwiDashboardOptions.runLabel` when set, else the CI pipeline's id (GitHub adds
  the run attempt), plus the CI job's id for a run that is not sharded, so parallel jobs of one pipeline stay apart.
- **The instance id** (`instanceId`) is `computeInstanceId(projectName, runLabel)`: a hash of the project and the run
  label when there is one, so every shard shares it, else of `hostname|projectName`.
- **A shard's identity** is Playwright's `config.shard`, or the `i/n` in `PIWI_SHARD`, which `piwi run --shard` sets
  because it narrows the tests itself and passes Playwright no `--shard`. The reporter reads both through
  `resolveShardInfo` (`packages/reporter/src/internal/support/shard-info.ts`) for `/setup`, `/start` and `/finish`. A
  run with no shard identity starts non-sharded and cancels every run of its instance id still initializing or
  running, never a finalizing one, which holds all its results (`tests/unit/finalizing-runs.test.ts`). A batch
  delivery also cancels the run its reporter streamed, a finalizing one too, when it names it with that run's stream
  token (`replacesRun`, `cancelReplacedRun`), which `/finish` leaves on a run it holds for its reports.

How the server merges shards:

- `/setup`, `/start`, `/submit` and `/upload` reuse the instance's active sharded run of the same `shardTotal` when
  `shardTotal > 1` (`findActiveShardedRun`, and `batchShardRun` for the two batch routes,
  `server/utils/sharded-runs.ts`). `/begin` on a run another shard already began joins it: the shard gets a stream
  token of its own and adds its planned tests to `totalTests`.
- Each shard's counters add up with SQL `+`, and the run settles only once `shardsFinished` reaches `shardTotal`
  (`finalizeShardedRun`, which runs the side effects once). `cancelInstanceRuns()` with `isShardedRun: true` cancels
  only the instance's non-sharded runs.
- **A shard's end is recorded only through `recordShardEnd`** (`server/utils/shard-spans.ts`, the server and the demo):
  its span joins `metadata.shards` and the run's start and duration become the first start to the last end, in one
  write that shards of one run make one at a time (`tests/unit/sharded-run-setup.test.ts`).
- **A shard's resource report replaces the one it sent before, whole**: one `test_run_resource_reports` row per run
  and shard (`saveResourceReportPart`, `shared/handlers/resource-reports.ts`), never merged into another shard's row.

### Stream tokens

- **The streaming routes authenticate with the run's stream token**, not `requireAuth`: `[id]/begin` (with the setup
  token `/setup` returned), then `events`, `heartbeat`, `live-resources`, `case-files` and `finish`. `/setup` and
  `/start` authenticate the caller and hand the token out, and so does `/upload/results` for a batch run it holds
  `finalizing` until its files are in, its repeated delivery a new one in place of the first (`renewHeldRunToken`), as
  a repeat of it to `/upload` or `/submit` does, its files unread (`tests/unit/batch-run-in-parts.test.ts`). A
  token is kept only as its digest (`streamTokenDigest`, `shardTokenDigest`): in `test_runs.stream_token`, in the
  in-memory run state (`runEventBus`, `server/utils/run-events.ts`) and, for a shard, in the run's
  `metadata.shardTokens`, which project members can read.
- **A requested run starts only with its run token, and its origin is the server's** (`server/utils/run-tokens.ts`):
  `/setup` and `/start` take it in place of `requireAuth` and spend it (`spendRunToken`) only once every check passed,
  report into the request's project, stamp `request` (`withRequestOrigin`) and set `requester_id`. `sanitizeMetadata`
  drops a `request` origin the reporter sends, every later write of the reporter's metadata goes through
  `carryRequestOrigin`, and `runOrigin` reads `request` before any lab stamp (`tests/unit/run-tokens.test.ts`).
- **A run takes files only with a token of its own**: `case-files` takes those of a running run, or of a run held
  `finalizing` (by `/upload/results`, or by a `/finish` whose reports are on their way), with its stream token, never
  with an API key, and `settleFinalizingRun` drops the token (`tests/unit/batch-run-in-parts.test.ts`). An upload
  with `runId` attaches reports alone.
- **A new streaming route authenticates with `authorizeStreamToken`** (`server/utils/stream-auth.ts`). It accepts the
  run's own token or any of its shard tokens, from the cache or the database (`validateAndReviveRun` with its
  `isShardToken` callback, which also revives an interrupted run). Never compare a token against the stored set
  directly: `matchesShardToken` and `matchesStreamToken` refuse a presented digest.
- **A streaming route whose token is in its body refuses what it can before it reads the body**: `begin`, `events`,
  `finish` and `live-resources` call `requireStreamingRun` (`server/utils/stream-auth.ts`) first, which answers the 404
  of a missing run, the 409 of one the route does not take and the 401 or 403 of the token header as the route does
  after reading the body, and the body-limit middleware holds the body to the route's cap (`server/utils/body-limit.ts`,
  10 MB for `events`, 32 MB for the others; `tests/unit/stream-route-bodies.test.ts`, `tests/unit/body-limit.test.ts`).
- **The reporter sends those routes' token twice, in the body and in `X-Piwi-Run-Token`** (`RUN_TOKEN_HEADER`,
  `@piwitests/core/wire`): its setup token to `begin`, its stream token to the others. The header is required of a
  run whose `reporter_version` (from `/setup`, `/start` or `begin`) is 0.65.0 or later (`sendsRunTokenHeader`); the
  token of an older or unknown reporter's run is checked in the body alone. Keep the body's token checked too: an
  older dashboard reads only it.
- **A path that ends a run drops its cached state** (`runEventBus.cleanup`), as `/finish`, the stale-run sweep and
  `cancelInstanceRuns` do: `authorizeStreamToken` trusts the cache without reading the run's status, so a run left in
  it takes events after it ended (`tests/unit/cancelled-run-stream.test.ts`).
- **The live view routes authenticate with the run's live view key, and nothing else does** (`liveViewRelay.authorize`,
  `server/utils/live-view.ts`). `setup` mints one, for a project with `live_view` on and a reporter that asked
  (`liveView: true`, any run's: outside CI its workers stream only once shared), and the desktop build none
  (`liveView.refused: 'local'`: no teammate reaches it); it is held as its digest, in memory, opens that run's
  `[id]/live-view` alone while the project's setting is on (rechecked on each stream), and ends with the run (its finish
  or cancel; an interruption closes the streams and keeps it once it streamed) or the setting, a key that ended
  answering 410 or 404 rather than 401 (`refuseLiveViewKey`; `tests/unit/live-view-routes.test.ts`). At their bounds
  the keys that never opened a stream go first (`tests/unit/live-view-relay.test.ts`).
- **A run keeps its live view keys' digests, never a key** (`live_view_key_digests`, `storeLiveViewKey` in `setup`),
  and no response carries them. Both routes authorize through `authorizeLiveViewKey`: a key the relay does not hold
  (a restart, the setting turned off and on) is taken back only for that run, compared in constant time, while it is
  initializing, running or interrupted, its project's setting on, within a day of its creation.
- **A live view frame is relayed, never kept**: no frame reaches the database, a log line, an error message or an
  export, and the relay holds one waiting frame per viewer at most (`tests/unit/live-view-relay.test.ts`).
- **A run's shard tokens are merged, never replaced**, in the cache and in `metadata`. Every shard's setup token stays
  valid until that shard calls `/begin`, which swaps it for the shard's stream token: read the set with
  `knownShardTokens` (cache and metadata together) and write it back with `withShardTokens`.
- **A shard still in its global setup keeps its run waiting**: `/setup` lists its setup token's digest in
  `metadata.shardSetupTokens`, its `/begin` takes it out (`withShardSetupTokens`), and the stale-run sweep gives a
  running run listing one the hour of a run in its global setup (`tests/unit/sharded-run-setup.test.ts`).

## Adding a field to test run data

The full chain, in order:

1. **Wire contract**, `shared/types.ts`: `TestCasePayload` and `StreamEventPayload` for a per-case field;
   `TestRunSubmitPayload`, `TestRunStartPayload` and `TestRunFinishPayload` for a run-level one.
2. **Schema**: both `schema.sqlite.ts` and `schema.pg.ts`, then `npm run db:generate && npm run db:generate:pg`. Large
   per-case text goes through `case_payloads`, never a new inline `test_runs_cases` column
   ([`server/database/AGENTS.md`](../../database/AGENTS.md#queries)).
3. **Front-end types**, `types/api.ts`.
4. **Server write path.** Per case: `mapWireCaseToRunCase` (`server/utils/map-wire-case.ts`, the one mapping from the
   wire to a row, used by `submit`, `upload`, `[id]/events` and the demo) and `server/utils/persist-run-cases.ts`
   (`RunCaseInput` and the insert). Per run: each route that writes the run (`setup`, `start`, `[id]/begin`,
   `[id]/finish`, `submit`, `upload`) and `batchShardRun` for a sharded batch.
5. **Server read path**: `getTestRun` (`shared/handlers/test-runs.ts`, behind `[id].get`), `getTestRunCase` and
   `getTestCase` (`shared/handlers/test-cases.ts`, behind `test-run-cases/[id].get` and `test-cases/[id].get`), and the
   column list of `[id]/stream.get` when the live run view shows it. The demo serves the same shared handlers.
6. **Reporter** (`packages/reporter/src/`): `CollectedTestCase` (`types/collected.ts`) and `WireTestCase`
   (`types/wire.ts`); collected in `public/reporter.ts` (`onTestBegin` / `onTestEnd`); projected in
   `internal/submit/serializer.ts`, by `toWireTestCase` per case and by `serializeRun` for the run body of `uploadJSON`
   and `uploadWithFiles`. A run-level field the streaming path sends also goes in the `/setup` body
   (`public/global-setup.ts`), the `/start` and `/begin` bodies (`internal/streaming/stream-manager.ts`) or the
   `/finish` body (`internal/submit/run-submitter.ts`).
7. **Demo**: `scripts/generate-demo-seed.mjs` (seed it), `app/demo/api/reporter.ts` (the demo's ingest),
   `app/demo/simulator.ts` (stream it).
8. The UI components that show it.
9. `npm run app:seed:demo`.

`shared/types.ts` is the wire contract, and the server imports it directly. The reporter shares only the **leaf
shapes**, through `@piwitests/core/wire` (bundled in, so no monorepo path leaks into the published `.d.ts`), and keeps
its own `WireTestCase`, held to the server's payloads by `tests/unit/wire-shared-drift.test.ts`. **Never `import`
`apps/application/shared` from the reporter**: use `@piwitests/core`.
