# External test IDs

A proposal to let a test keep its history when it is renamed or moved, by matching it on the ID the team already
gives it in its test management tool. It records the design agreed on
[PiwiTests/platform#847](https://github.com/PiwiTests/platform/issues/847), the stages, and the questions left open.

**Status.** Stages 1 to 3 built (see [As built](#as-built)); stage 4 not started.

**Summary.** Piwi matches a test to its stored test case on the file path, the describe path and the title. Any rename
or move creates a new test case, and flakiness, failure clusters, quarantine and trends restart from zero. This
proposal adds an optional **external ID**, declared with a `piwi:id` annotation or read from the title with a pattern
set in the reporter options. When a test has one, the server matches it on that ID first, and updates the stored file,
describe path and title of the test case instead of creating a new one. The ID is stored in a new
`test_cases.external_id` column with a unique index per project, shown as a chip before the title in the dashboard, and
searchable with `id:`. Two tests declaring the same ID are reported before the first test runs and fall back to
today's matching; failing the run instead is opt-in.

## Terms

Each term below has one meaning throughout the document.

- **Test case**: a `test_cases` row, Piwi's record of one test across runs. Its primary key is `test_cases.id`, which
  12 tables reference.
- **Natural key**: the file path, describe path and title of a test, the values Piwi matches on today.
- **External ID**: the ID a team gives a test in its own test management tool (for example `12526`), declared with
  `piwi:id` or read from the title. Stored in `test_cases.external_id`. Named "external" because "id" is already taken
  twice: `test_cases.id` / `testCaseId` across the server, and Playwright's `TestCase.id`, a hash of file, project and
  title that changes on every rename (precisely the unstable value this proposal works around).
- **Display title**: the title without the external ID, sent when the reporter is asked to remove it.
- **Duplicate external ID**: two tests with **different natural keys** declaring the same external ID in one run. The
  same test running in several Playwright projects (chromium, firefox) has a single natural key, so it is not a
  duplicate.

## Problem

- **A rename or a move loses the history.** Fixing a typo in a title, rewording it, moving a test to another file or
  describe block: each creates a new test case. Flakiness stats, failure clusters, quarantine state and trends start
  from zero, and the old test case stops receiving executions.
- **Teams with a test management tool already have a stable ID.** In the suite behind the issue (about 1,100 tests),
  every title starts with one: `test('12526, Log in modal: Log in with Email', …)`. Piwi ignores it.
- **Fixing it by hand is not realistic.** Merging two test cases means moving rows in the 12 tables that reference
  `test_cases.id`.

## What exists today

- **Matching**: `apps/application/server/utils/persist-run-cases.ts` (`persistRunCases`, around line 482) builds the
  natural key, looks it up in the cache and inserts a test case on a miss. Every ingest path goes through it: streaming
  batches (`server/api/test-runs/[id]/events.post.ts`), `submit`, `upload` and archive imports.
- **Cache**: `apps/application/server/utils/test-case-cache.ts`, a per-project in-memory map from natural key to test
  case id, loaded once per process and single-instance by design.
- **Index**: `idx_test_cases_file_path_title` on (project, file, describe path, title) is **not unique**.
- **`piwi:` annotations**: `piwi:owner`, `piwi:priority`, `piwi:feature`, `piwi:link`, `piwi:bug`, parsed by
  `parseTestMetadata` in `packages/core/src/test-meta.ts`. The server parses them again on ingest, because a payload
  can reach the API without going through the reporter.
- **The stored title is matched back against the source code**:
  - probe plans match a running test on file path + title (`packages/reporter/src/internal/probe/plan.ts:65`);
  - `piwi select --format grep` builds a `--grep` from stored titles.
- **Run-level data quality notes**: `metadata.ingestHealth`, written with `updateRunMetadata` and shown in
  `app/components/run/RunHeader.vue`.
- **Precedents reused below**: the `leakCheck: 'report' | 'fail'` reporter option; the partial unique index
  `idx_quarantined_tests_active`; the `IssueKeyChip.vue` chip.

## Design

### 1. Declaring the external ID (reporter)

Two sources, either one per test.

**Annotation** `piwi:id`, next to the other `piwi:` annotations:

```ts
test('Log in with Email', { annotation: { type: 'piwi:id', description: '12526' } }, async ({ page }) => {
  /* … */
});
```

**Pattern** on the title, in the reporter options (`PiwiDashboardOptions`, `packages/reporter/src/public/options.ts`):

```ts
reporter: [
  ['@piwitests/reporter', { externalId: { pattern: /^(\d+),\s*/, stripFromTitle: true } }],
],
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `pattern` | `RegExp \| string` | none | Applied to the test's own title, not the describe path. The ID is the first capture group, or the whole match when the pattern has no group. A string is compiled with `new RegExp(value)`. Can also be set with `PIWI_EXTERNAL_ID_PATTERN`. |
| `stripFromTitle` | `boolean` | `false` | Also send a display title: the title with the whole match removed, then trimmed. Only applies to an ID read by the pattern. |
| `onDuplicate` | `'report' \| 'fail'` | `'report'` | What a duplicate external ID does, see [3](#3-duplicate-external-ids). Same values as `leakCheck`. |

Rules:

- **The annotation wins** over the pattern when a test has both: a declared value beats an inferred one, as
  annotations already win over a supplied `testMeta`.
- **Static annotations only**: the ID is read from `TestCase.annotations` (declared on the test or on its describe
  block), never from annotations added at runtime with `testInfo.annotations.push()`. The duplicate check runs in
  `onBegin`, before any test, and the ID must not depend on whether the test ran (a skipped test keeps its history
  too).
- A `piwi:id` on a **describe block** reaches every test inside it, so they all declare the same ID and are reported as
  duplicates. The documentation says to put it on the test.
- **Normalization** in `@piwitests/core` (`normalizeExternalId`, next to `parseTestMetadata`): a string, trimmed, at
  most 120 characters (the cap of `owner` and `feature`), no control characters; anything else means no ID. The server
  runs the same function.
- An **invalid pattern** (a string that does not compile) logs one error at start and turns external IDs off for the
  run. It never fails the run.
- If removing the match leaves an empty string, no display title is sent.
- `parseTestMetadata` already ignores unknown `piwi:` types, so `piwi:id` does not leak into the metadata badges.

### 2. Payload

Two optional fields on each test case of the wire format (`packages/reporter/src/types/wire.ts`, streaming and submit
shapes):

- `externalId?: string | null`
- `displayTitle?: string | null`

**`title` stays the full title.** The reporter must not remove the ID from it:

- probe plans and `piwi select --format grep` match the stored title against the source code, and a shortened title
  matches nothing;
- on the first run with the option on, existing test cases have no external ID yet and can only be found by natural
  key. With a shortened title the natural key changes, and **every test would lose its history on day one**, the
  opposite of the goal.

Server side (`server/utils/map-wire-case.ts` → `RunCaseInput`): the external ID is the `piwi:id` of
`testAnnotations` when present, else `normalizeExternalId(externalId)`. Reading the annotation again keeps a payload
sent without the reporter, or by an older reporter, working. The display title is normalized and capped like `title`.

Compatibility:

- **New reporter, older server**: the two fields are ignored (the ingest endpoints do not reject unknown fields).
- **Older reporter, new server**: no field is sent, `piwi:id` annotations still work through the server, the pattern
  does not.

### 3. Duplicate external IDs

**Detection in the reporter, in `onBegin`**, before any test runs:

- Walk `suite.allTests()`, compute each test's external ID, group by ID and compare natural keys (relative file path,
  describe titles, title; the Playwright project is left out).
- For each ID declared by more than one natural key: print one warning listing every location, and **send no external
  ID for any of these tests** in this run. They are matched by natural key, as today, which is what the issue asks
  for.
- Send the list with the run (`metadata.externalIdDuplicates`, capped at 50 IDs), so the run header shows it next to
  the ingest note.
- With `onDuplicate: 'fail'`: the same, and `onEnd` returns `{ status: 'failed' }` so the run exits non-zero. The tests
  still run: a reporter cannot stop a run before it starts, and their results are still worth keeping.

Warning:

```
piwi: external ID 12526 is declared by 2 tests; this run matches them by file and title:
  tests/login.spec.ts:12  Log in modal › 12526, Log in with Email
  tests/auth.spec.ts:40   12526, Log in
Give each test its own ID, or set externalId.onDuplicate: 'fail' to fail the run instead.
```

**What the reporter cannot see**, and the server covers:

- with `--shard`, `onBegin` only sees the tests of its own shard, so two tests with the same ID in different shards
  are only visible to the server (with `merge-reports`, `onBegin` sees the merged suite and the check is complete);
- payloads that do not come from the reporter.

**Server rule, per run**: every ID listed by the reporter is ignored for the whole run. Beyond that, the first test to
use an external ID in the run gets the test case; a later test with the same ID and a different natural key is matched
by natural key without its ID, and the ID is added to `metadata.externalIdDuplicates` (through `updateRunMetadata`, so
concurrent batches add up). Which test comes first depends on shard timing; the run note makes the problem visible
until the IDs are fixed.

### 4. Storage

On `test_cases`, in both `schema.sqlite.ts` and `schema.pg.ts`, migrations generated with
`npm run db:generate && npm run db:generate:pg` (never hand-written):

- `external_id text`, nullable;
- `display_title text`, nullable;
- `idx_test_cases_external_id`: **unique** index on `(project_id, external_id)` `WHERE external_id IS NOT NULL`, in
  the same form as `idx_quarantined_tests_active`.

**`test_cases.id` stays the primary key**:

- 12 tables reference it;
- an external ID is optional (most projects will not declare one) and can change (a team moving to another test
  management tool renumbers its tests);
- the unique index brings what a primary key would for this use: a fast lookup, and at most one test case per ID in a
  project. The external ID becomes the first value the server matches on, before the natural key.

No migration of existing data is needed: existing test cases get their external ID on the first run that declares it
(step 2 below).

### 5. Matching on the server

In `persistRunCases`, replacing the lookup and insert around line 482. For each execution, with `key` its natural key
and `ext` its external ID (none when the ID is listed as a duplicate for the run):

1. **`ext` known in the project**, on test case A:
   - A's natural key equals `key`: use A.
   - A already has an execution in this run under another natural key: duplicate (see [3](#3-duplicate-external-ids)),
     continue at step 4 as if `ext` were absent.
   - Otherwise it is a **rename or a move**: update A's `file_path`, `suite_path`, `suite_id`, `title` and
     `display_title`, update the cache, use A.
2. **`ext` unknown, `key` known**, on test case B: store `ext` on B and use B. This is how existing test cases get
   their ID on the first run, and how a test whose ID changed in the test management tool keeps its history.
3. **`ext` unknown, `key` unknown**: insert a test case with `ext`.
4. **No `ext`**: today's behaviour, unchanged.

The history follows without any copy: executions, quarantine, failure clusters, locator snapshots and the other
tables reference `test_cases.id`, not the title. Executions keep no copy of the title, so past runs show the new one.

**An ID is never removed automatically.** A test that stops declaring its ID is matched by natural key, and its test
case keeps the ID. If another test declares that ID later, it takes over the test case and its history, which is what
the ID means.

**Display title**: set on insert, rename and step 2, and kept in sync by `syncTestCaseMetadata`, because it changes
when `stripFromTitle` is turned on or off while the title stays the same.

**Cache** (`test-case-cache.ts`): per project, natural key → test case id as today, plus external ID → { test case id,
natural key }. The load selects `external_id`; a rename removes the old natural key and adds the new one.

**Collision with another test case** (not handled automatically): `ext` points to A, but `key` already belongs to
another test case C, usually one created by a rename before the ID was declared. Use A. C keeps its history and no
longer receives executions. When the cache loads two rows with the same natural key, the one with an external ID
wins. Merging C into A means moving rows in 12 tables: a later, manual "merge test cases" action (stage 4).

### 6. Concurrent inserts (to fix first)

`persistRunCases` reads the cache, then inserts after an `await`, and the streaming endpoint calls it without a
per-project lock (`server/api/test-runs/[id]/events.post.ts:125`). Two batches arriving together with the same new
test, for example the chromium and firefox executions of a new test in two shards, or two CI runs at once, can both
miss the cache and insert **two test cases with the same natural key**, since `idx_test_cases_file_path_title` is not
unique. Today the duplicate is silent; with the unique index on `external_id`, it would become a failed batch.

Fix, before the rest:

- resolve test cases (cache lookup, insert, rename) under a **per-project lock** (`createKeyedLock` from
  `server/utils/keyed-lock.ts`), single-process like the cache;
- insert with `onConflictDoNothing` on the external ID index, then read the existing row back, as the guard at the
  database level.

### 7. Display

**ID chip** before the title: a new `app/components/shared/TestIdChip.vue`, in the same family as `IssueKeyChip.vue`
(`UBadge color="neutral" variant="subtle" size="xs"`, plus `font-mono tabular-nums`):

- **before the title**, so IDs line up in a column in long lists, easier to scan than at the end of titles of
  different lengths;
- **monospace and neutral**, so it reads as an identifier, not as a tag or a status;
- **click copies the ID** (`useCopy`), with the tooltip "External test ID · click to copy";
- `@click.stop`, so it never triggers the row's own link.

**Label**: one helper in `shared/` returns `displayTitle ?? title`, and every screen showing a test goes through it.
A screen not updated yet shows the full title, which still contains the ID: repetitive, never wrong.

First screens:

- run tests list (`app/components/run/TestCasesList.vue`);
- project tests list;
- test case page (`app/pages/test-cases/[id].vue`);
- flaky tests (`app/components/project/FlakyTestsList.vue`);
- failure clusters.

39 server files select `testCases.title`; the remaining ones follow in stage 4. Text outputs (pull-request comments,
notifications, exports, MCP) write `12526 · Log in modal: Log in with Email`.

The demo data gives a few tests an external ID, so the chip shows in the demo.

### 8. Search, API and MCP

- **`id:` qualifier** in test search (`shared/test-search.ts`, `shared/utils/test-search-sql.ts`): matches the whole
  value, and repeated it matches any of the values, like `owner:`. Run and project tabs.
- Test case objects in the API gain `externalId` and `displayTitle`.
- MCP tools returning test cases include `externalId`, and test lookups accept an external ID.

## Alternatives considered

- **Pattern as a server setting** (`PIWI_TEST_CASE_ID_PATTERN`, as the issue suggests). Rejected: the pattern belongs
  to the naming convention of the test code, so it is versioned with it and can differ per repository, and the
  reporter needs it anyway to report duplicates before the run. The server only validates the ID it receives.
- **Pattern in the `'@piwi'` section of the Playwright config** (`packages/reporter/src/public/piwi-config.ts`, also
  read by the editor service). Possible later if the IDE extensions need the ID without the dashboard; today only the
  reporter reads it.
- **Remove the ID from `title` in the reporter.** Rejected, see [2](#2-payload).
- **External ID as the primary key.** Rejected, see [4](#4-storage).
- **Fail the run on a duplicate by default**, as Playwright refuses two tests with the same title in one file.
  Rejected as the default: a duplicate ID is a problem with Piwi's data, not a failing test, and failing a whole CI run
  over a copied ID is out of proportion. Available with `onDuplicate: 'fail'`.
- **Merge test cases automatically** on a collision. Rejected for now, see [5](#5-matching-on-the-server).

## Decisions taken

- Annotation name: `piwi:id`.
- Column and payload field: `external_id` / `externalId`.
- Both sources; the pattern is a reporter option, not a server setting.
- Removing the ID sends a display title; `title` stays the full title.
- Failing on duplicates is opt-in (`onDuplicate: 'fail'`); the default reports them.
- `test_cases.id` stays the primary key; the external ID has a unique index per project.

## Open questions

- Should the duplicate note also reach the project page, since a duplicate repeats on every run until it is fixed?
- **Link template** per project (`https://tcm.example.com/case/{id}`) to make the chip a link to the test management
  tool: in which settings page, and should it reuse the provider detection of `LinkChip.vue`?
- Should an ID that moves back and forth between two natural keys (partial runs, each with only one of the two tests)
  be reported?

## Rollout

Each stage ships on its own.

1. **Concurrent inserts** ([6](#6-concurrent-inserts-to-fix-first)). No visible change.
2. **Matching**: core normalizers, reporter option and annotation, payload fields, duplicate check and run note,
   schema and migrations, server matching and cache. Value: history kept across renames and moves.
3. **Display and search**: `TestIdChip`, display title on the first screens, `id:` search, API and MCP fields, demo
   data, documentation.
4. **Later**: link template, text outputs and remaining screens, manual merge of two test cases.

## As built

What differs from the design above, or what it left open:

- **One matching module for the server and the demo**: `apps/application/server/utils/test-case-match.ts`
  (`resolveTestCases`, `loadTestCaseIndex`), called by `persistRunCases` through `testCaseCache.resolve`, which holds
  the per-project lock, and by the demo's ingest. The metadata sync moved to `test-case-metadata-sync.ts`, shared
  the same way.
- **Explicit `null`**: the reporter always sends `externalId` once it settled the IDs, `null` included. The server
  trusts that field, `null` meaning "no ID" (none, or set aside as a duplicate), and reads `piwi:id` from the
  annotations only when the field is absent (older reporter, payload built by hand). This is how a duplicate the
  reporter found stays without an ID on the server, although its annotation still says `piwi:id`.
- **Server duplicate check across batches**: the index remembers the last run that matched each ID; after a restart,
  the check asks the database whether the test case already has an execution in the run.
- **Run page**: the facts line says "N duplicate test IDs" (warning colour), and the Details popover lists each ID
  with its tests, next to the ingest note. Help topic `run.externalIdDuplicates`.
- **The chip** leads the row (before the describe path), so the IDs line up. Shown in the run tests list, the
  project catalog, flaky tests and the test case page header. MCP `get_test_case` returns `externalId`.
- **Search**: `id:` only; a free word does not look in the external ID (the in-memory matcher and the SQL one would
  disagree on whole-value against contains).
- **Demo**: the checkout specs' tests have IDs `CHK-<spec><case>` (`demoExternalId` in
  `shared/demo/demo-test-meta.mjs`), seeded and sent by the run simulator.

## Tests

- **Core**: `normalizeExternalId`, `piwi:id` parsing, pattern extraction (capture group, no group, string pattern,
  invalid pattern, removal leaving nothing).
- **Reporter** (`packages/reporter/tests`): duplicate check (same ID in two files; same test in two Playwright projects
  is not a duplicate; `piwi:id` on a describe block); annotation wins over the pattern; `onDuplicate: 'fail'` sets the
  run status; `title` is sent unchanged with `stripFromTitle`.
- **Server unit** (`apps/application/tests/unit`): rename; move to another file; move to another describe block; step 2
  on an existing test case; ID changed; duplicate in one batch; duplicate across batches; collision with another test
  case; no ID, behaviour unchanged; two concurrent batches with the same new test create one test case;
  `migration-history.test.ts`.
- **E2E** (`apps/application/tests`, next to `test-case-history.spec.ts`): a test renamed between two runs keeps its
  executions; a duplicate shows the run note; the chip and `id:` search on the project tests tab.

## Documentation

- `apps/docs/reference/test-metadata.md`: `piwi:id` in the `piwi:` annotations table, and a section on external IDs
  (pattern, display title, duplicates).
- `apps/docs/guide/reporter.md`: the `externalId` option.
- `apps/docs/reference/test-search.md`: the `id:` qualifier.
