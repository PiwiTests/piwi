# Run ingestion: agent guide

Rules for the routes the reporter calls (`setup`, `start`, `begin`, `events`, `finish`, `submit`, `upload`,
`case-files`, the imports) and what they write. Read [`../../../AGENTS.md`](../../../AGENTS.md) and
[`../AGENTS.md`](../AGENTS.md) first.

## Finish-time side effects

Every complete-run ingest path (`finish`, `upload` new-and-attach, `submit`) routes finalization through the one
probe-aware `runFinalizeSideEffects` (`server/utils/run-finalize-side-effects.ts`): the environment-incident check first
(`recordRunHealth`, `shared/handlers/run-health.ts`; a flagged run sends one `environment.incident` in place of the
verdicts), then regression signals, auto markers, flaky root causes, AI diagnosis, notifications, PR feedback,
auto-heal. A `finalizing` run reaches it through `settleFinalizingRun` (`server/utils/finalizing-runs.ts`), from its
report upload or the stale-run sweep. A probe-stamped run stays silent everywhere.

## Timed-out tests fold into `failedTests`

There is no `timedOutTests` column on `test_runs`. Timed-out cases (`'timedOut'` per-case from Playwright, stored as
`'timedout'`) fold into `failedTests` so `total = passed + failed + skipped + didNotRun`
reconciles and matches the UI. **Every ingest site MUST use the helpers in `shared/utils/test-counts.ts`** —
`sumFailedAndTimedOut(body.failedTests, body.timedOutTests)` for body-field sites (`finish`, `submit`, `upload` + the
demo `app/demo/api/reporter.ts` mirror) or `countFailedFromTally(insertedStatusCounts)` for per-status-tally sites
(`events` + its demo mirror). Never write `failedTests: body.failedTests` directly.

## Sharding

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
