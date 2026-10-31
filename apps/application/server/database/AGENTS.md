# Dashboard database: agent guide

Rules for the schema, the migrations and the queries of the dashboard (`server/database/`, and every Drizzle query in
`server/` and `shared/handlers/`). Read [`../../AGENTS.md`](../../AGENTS.md) first. The two dialects, the files of this
folder and the tables: [`ARCHITECTURE.md`](../../ARCHITECTURE.md#database).

## Schema and migrations

- **Change the schema in both dialects.** Edit `schema.sqlite.ts` and `schema.pg.ts`, then run
  `npm run db:generate && npm run db:generate:pg`. `server/database/schema.ts` only re-exports the dialect that
  `PIWI_DATABASE_URL` selects at startup: a new table adds its name to its export list (and its row types when code
  needs them), and nothing else goes there.
- **Generate every migration; never write one by hand or edit `_journal.json`.** The migrator applies only the
  migrations the journal lists, and drizzle-kit builds the next one against the latest `meta/NNNN_snapshot.json`, which
  a hand-made change leaves behind. SQL that drizzle-kit cannot derive (a data backfill) goes in a custom migration:
  `npm run db:generate -- --custom --name=<name>` and `npm run db:generate:pg -- --custom --name=<name>`, then write
  its SQL in the generated files.
- **Never change a committed migration**, not even to fold the base branch's migration into it under the same name or
  date. A database records each migration it ran, and startup runs a changed migration again only if all it does is
  create tables, columns, indexes and constraints: a data change in it never reaches a database that already ran it. A
  new schema change is a new migration.
- `tests/unit/migration-history.test.ts` fails on a journal whose dates do not strictly increase (both dialects), and
  when a fresh SQLite database no longer matches the latest snapshot.

### Migrations across a merge of the base branch

A database records each migration it ran (a row of `__drizzle_migrations`, keyed by the migration's journal date).
Startup compares those rows with the journal (`applyMigrations`, `server/database/migration-history.ts`). A history
that diverged (rows from another branch, a migration dated before the latest one applied, a file changed after it ran)
is repaired in one transaction, and rolled back unless the result matches the latest snapshot. A repair can fail, so a
merge keeps the branch's history as stable as it can:

- **The base branch added no migration: keep the branch's migrations as they are.** Regenerating gives them new names
  and dates, and every database that ran the old ones then needs a repair.
- **The base branch added migrations** (a conflict in `_journal.json` or a `meta/NNNN_snapshot.json`, or two files
  with the same number): the branch's migrations must be dated after them. From `apps/application/`, in **both**
  folders:

  ```bash
  git diff --relative --name-only --diff-filter=A origin/main... -- server/database/migrations server/database/migrations-pg
  git rm <each file listed>        # the branch's own .sql files and snapshots
  git checkout origin/main -- server/database/migrations server/database/migrations-pg
  npm run db:generate && npm run db:generate:pg
  ```

  drizzle-kit regenerates schema changes only: recreate each custom migration of the branch as above, and paste its
  SQL back.

- **Never resolve a `_journal.json` or snapshot conflict by hand** (keeping both sides' entries, renumbering `idx`,
  reordering them). The Drizzle migrator applies by date: it skips an entry dated before one a database already ran
  (startup then has to repair that database), and the test above fails on dates out of order.

## Queries

- **A partial index serves a query only when the query repeats its condition with literals**:
  ``sql`${testRunsCases.status} = 'passed'` ``, not `eq(testRunsCases.status, 'passed')`. PostgreSQL's cached generic
  plans and SQLite's planner cannot match a bound parameter to the index's constant, so the query reads every row. The
  capability probes (`shared/handlers/setup-status.ts`) and the `fixme` count (`fixmeSkipPredicate`) rely on this.
- **`test_runs.origin` and `test_runs.commit_sha` derive from the run's `metadata`.** Every insert or update that
  writes `metadata` writes `origin: runOrigin(<the same value>)` and `commit: runCommit(<the same value>)` beside it
  (`updateRunMetadata`, `server/utils/run-metadata.ts`, does both), as `branch` follows `resolveRunBranch`. A query
  reads a run's origin from the column (`notLabRun(testRuns.origin)`, `runOriginIn(testRuns.origin, …)`,
  `eligibleRunSql`), never from the metadata text. `tests/unit/run-origin-column.test.ts` fails on a write that leaves
  either out.
- **A SQLite statement whose result rows have no columns runs through `db.$client.executeMultiple`**, never
  `db.run`: libSQL's `execute` steps such a statement once and leaves it open. `PRAGMA incremental_vacuum` is one:
  stepped once, it frees a single page and holds the write lock until the statement is garbage-collected, and every
  write on another connection fails with `SQLITE_BUSY` meanwhile (`reclaimSpace`, `server/utils/retention.ts`).
  `executeMultiple` waits for an open transaction, as writes do (`server/database/sqlite-connections.ts`).
- **Dates are Unix timestamps in SQLite**, in seconds (`mode: 'timestamp'`) or in milliseconds
  (`mode: 'timestamp_ms'`) depending on the column: check its mode before comparing it in raw SQL.
- **Large per-case text goes through `case_payloads`** (content-addressed, deduplicated per project), never a new
  inline text column of `test_runs_cases`: `upsertCasePayloads` on write, `inlineCasePayloads` or
  `resolveCasePayloadContents` on read (`server/utils/case-payloads.ts`). The older inline columns stay readable
  (readers take the payload, else the inline value), and the demo's ingest still writes the ARIA snapshot and the test
  source inline, which keeps that fallback exercised. Unreferenced payloads are deleted by `server/utils/retention.ts`.

## `test_runs_cases`: one row per attempt, project and repetition

A row is one attempt of a test, in one Playwright project and one `--repeat-each` repetition: the unique key is
`(test_run_id, test_case_id, repeat_each_index, retries, browser_name)`. A repetition is a test result of its own with
its own retries, as in Playwright, and a row without one reads `repeat_each_index` 0.

- **Read the rows through `shared/utils/test-counts.ts`**: a run's counters with `distinctRunCountsFromAttempts` (each
  repetition counts once), each repetition's last attempt with `finalAttempts`, a test's outcome in a run with
  `testOutcomes` or `decidesOutcome` (failed when one of its repetitions failed).
- **A test's attempts are the rows of one repetition.** Never take the highest retry across repetitions as its last
  attempt, nor a pass in one repetition as a retry pass of another. `lastAttempts` (`@piwitests/core/status-classify`)
  and the SQL of `latestRunStatusSql` (`shared/handlers/latest-run-status.ts`) follow the same rule.
