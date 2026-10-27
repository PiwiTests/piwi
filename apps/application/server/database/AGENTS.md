# Dashboard database: agent guide

Rules for the schema, the migrations and the queries of the dashboard (`server/database/`, and every Drizzle query in
`server/` and `shared/handlers/`). Read [`../../AGENTS.md`](../../AGENTS.md) first.

## Schema, migrations and queries

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

## `test_runs_cases`: one row per attempt, project and repetition

`test_runs_cases` holds one row per attempt of a test, per Playwright project and per `--repeat-each` repetition: its
unique key is `(test_run_id, test_case_id, repeat_each_index, retries, browser_name)`. A repetition is a test result of
its own with its own retries, as in Playwright, and a row without one reads `repeat_each_index` 0. Read the rows
through `shared/utils/test-counts.ts`: a run's counters with `distinctRunCountsFromAttempts` (each repetition counts
once), each repetition's last attempt with `finalAttempts`, a test's outcome in a run with `testOutcomes` or
`decidesOutcome` (failed when one of its repetitions failed). A test's attempts are the rows of one repetition: never
take the highest retry across repetitions as its last attempt, nor a pass in one repetition as a retry pass of another.
`lastAttempts` (`@piwitests/core/status-classify`) and the SQL of `latestRunStatusSql`
(`shared/handlers/latest-run-status.ts`) follow the same rule.
