---
title: Test metadata
description: "What the reporter records with every run and test without configuration: source control, CI, browser, suites, annotations, tags, locks, ownership, timeouts and skips."
lang: en-US
---

# Test metadata

The [reporter](/guide/reporter) records more than pass or fail. This page lists what it collects on its own, what each
field drives in the dashboard, and how to add your own metadata or turn collection off.

## Automatic metadata collection

Without any configuration, the reporter records the following with every run. [Disabling automatic collection](#disabling-automatic-collection) turns the collectors off.

### SCM information (Git)

When `collectScmInfo` is enabled (default), the reporter collects:

- Commit hash and message
- Branch name
- Author name
- Remote URL, without the user name or token a URL can carry (`https://gitlab-ci-token:…@host/…`), which
  [Source control](/guide/source-control#which-repository) uses to find the repository
- The pull-request number and the pull request's target branch, on a pull-request build

The branch is resolved through a fallback chain so a CI pull-request build never records the literal
`HEAD` git reports on a detached checkout: an explicit `PIWI_BRANCH` override, then the CI provider's
branch variables (`GITHUB_HEAD_REF`/`GITHUB_REF_NAME`, `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`/
`CI_COMMIT_REF_NAME`, `CIRCLE_BRANCH`, and the equivalents for Travis, Azure, Jenkins and Bitbucket),
then the local git checkout. On a pull-request build the target branch (`GITHUB_BASE_REF`,
`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, `TRAVIS_BRANCH` on a Travis pull-request build, `SYSTEM_PULLREQUEST_TARGETBRANCH`,
`BITBUCKET_PR_DESTINATION_BRANCH`, `CHANGE_TARGET`, or `PIWI_BASE_BRANCH` to name it yourself) is
recorded as the run's **base branch**, which [baselines](/guide/concepts#baseline-last-green-run) fall
back to when the branch has no history of its own.

### CI information

When `collectCiInfo` is enabled (default), the reporter auto-detects:

| Platform        | Collected fields                                          |
|-----------------|-----------------------------------------------------------|
| GitHub Actions  | Run ID, run number, workflow, actor, repository, ref, SHA |
| Jenkins         | Build number, build URL, job name                         |
| GitLab CI       | Pipeline ID, pipeline URL, job ID, job URL, job name      |
| CircleCI        | Build number, build URL, job name, workflow               |
| Travis CI       | Build number, build URL, job number                       |
| Azure Pipelines | Build number, build ID, build URL, job name               |
| Bitbucket Pipelines | Build number, build URL, pipeline UUID, step UUID, repository |

These seven platforms get rich per-provider fields. The **run label** that ties [sharded](/guide/ci#sharding) runs together comes from the provider's build id: `GITHUB_RUN_ID`, `CI_PIPELINE_ID`, `CIRCLE_WORKFLOW_ID`, `TRAVIS_BUILD_ID`, `BUILD_BUILDID`, `BUILD_ID`, `BUILDKITE_BUILD_ID`, `TEAMCITY_BUILD_ID`, `BITBUCKET_BUILD_NUMBER`, `SEMAPHORE_WORKFLOW_ID`, `APPVEYOR_BUILD_ID` or `DRONE_BUILD_NUMBER`; set `runLabel` when your CI is not among them.

### Run origin

Whatever the collectors, every run records what launched it as `piwiOrigin`, so analyses that compare runs can leave
out the ones that say nothing about the branch's current state. The reporter records `ci` when it detects a CI provider
and `local` otherwise. A launcher names itself through these environment variables on the Playwright process:

| Variable | Value |
|---|---|
| `PIWI_ORIGIN` | `ci`, `ci-rerun`, `local`, `desktop`, `editor`, `preflight`, `bug`, `flake-lab`, `probe`, `bisect` or `reproduce` |
| `PIWI_ORIGIN_REF` | Optional: what the run was launched for, such as a dispatch, a cluster or a bug report id (letters, digits and `._:/#@-`, up to 200 characters) |
| `PIWI_RUN_REF` | Optional, with `PIWI_ORIGIN`: the launcher's name for the run itself, recorded as `piwiRunRef` (same characters as `PIWI_ORIGIN_REF`) |

Piwi's own launchers set them: the desktop app (`desktop`, and `reproduce` or `bisect` with the cluster id), the
editors (`editor`, with a ref of their own on each test run, which they find the run by), `piwi preflight --run`
(`preflight`), `piwi bug --write` (`bug` with the report id), Flake Lab and probes. The desktop app also names each
run it starts with `PIWI_RUN_REF`, so two runs started for the same cluster each find their own Piwi run. Every run
outside CI records a `piwiRunRef`, with `@piwitests/reporter` 0.68.0 or later: the one given, else an editor's
`PIWI_ORIGIN_REF`, else one of its own, `local-<pid>-<time>`. A
[re-run dispatched from the dashboard](/features/ci-rerun) is recorded as `ci-rerun` once
Piwi recognizes it, an imported report as `import`, and a run a person asked for from the dashboard as `request`,
by the server from the request token that started it: a `request` the reporter sends is dropped. You rarely set them
yourself.

A run whose workers connect to an editor or the desktop app, which steer it at their breakpoints (a run either of them
started, or one [started in a terminal](/features/terminal-runs) that follows an editor), also records
`piwiInteractive`: the editor's name (else the `PIWI_ORIGIN` its launcher set) as `client`, and the run's name there
as `ref`.

What each origin feeds:

- **Flake Lab and probe runs** feed nothing: they replay tests under conditions Piwi injected.
- **Bisect steps and reproductions** run at a commit chosen to investigate a failure. They stay out of baselines, fix
  verification, flaky scores, selections, change coverage, the stored locators and test metadata, the bug-report
  lifecycle and a failure cluster's occurrences (its count, its last seen run, the wake of a snooze), and have no
  outbound effect: no [notification](/features/notifications#events), no
  [pull-request comment or commit status](/features/pr-feedback), no automatic AI diagnosis or auto-heal, and no
  [automatic write to an issue tracker](/features/issue-automation#the-runs-that-write).
- **`piwi bug` runs** do not move the bug report they were written for.
- **Local runs** (`local`, `desktop`, `editor`, `preflight`) count like CI runs, with four exceptions. An editor's CI
  failures come from the newest complete CI run on the branch, and a local run stands in only while the branch has
  none. An `editor` run's failures join their clusters without counting as occurrences. An `editor` run, or a `local`
  or `desktop` run of part of the suite, fires no run, new-cluster, fixed, regressed, flakiness or
  performance [notification](/features/notifications#events), posts no
  [pull-request comment or commit status](/features/pr-feedback), starts no automatic AI diagnosis or auto-heal, and
  writes nothing to an [issue tracker](/features/issue-automation#the-runs-that-write) on its own. No local run, and
  no `piwi bug` run, sends [`test.stuck`](/features/stuck-tests#the-notification), complete or not.
- **Partial runs** (a `--grep`, a file filter, a selection, `--last-failed`, `--only-changed` or `--test-list`) never count for change
  coverage, which asks whether a file was reached in the recent runs, nor as a commit's end-to-end coverage.

### Playwright configuration

The reporter also records browser project configs, worker count, the global timeout, and parallel settings. A sharded
run keeps the configuration of the shard that began it, and each shard's own worker count under `shards`.

### Browser configuration per test case

The reporter automatically captures each test case's Playwright project configuration — `projectName`, `browserName` (a `devices` preset's `defaultBrowserType` when the project sets none), `channel`, `viewport`, and the rendering options `colorScheme`, `reducedMotion`, `forcedColors` and `contrast` (Playwright 1.63's standalone contrast option) — via `test.parent.project()`. This is stored in the `browser` field of every test case result and feeds the [environment diff](/features/evidence#one-execution-diagnosis-first) that compares a failing execution against its last passing one.

In the dashboard UI, every row of a run's Tests tab shows the browser icon (from the channel, else the engine, else the project name), and `browser:<project name>` in its [search](/reference/test-search) narrows the list to one project.

### Suite hierarchy (describe blocks)

The reporter traverses the test's parent chain (`test.parent`) to build a `suitePath` array — the list of describe-block names from the root to the test's immediate parent. Each level's `suiteConfig` (mode: `parallel` | `serial` | `default`, plus any suite-level `annotations`) is captured alongside the path. This data is sent in both streaming and batch submission payloads and stored in the `test_suites` and `test_cases` tables.

In the dashboard UI, the test run detail page offers a **Tree** view that groups test cases by their suite hierarchy, with expandable/collapsible describe nodes showing mode badges and annotation counts.

### Test annotations (Playwright marks)

The reporter captures Playwright test marks set via `test.info().annotations` (e.g. `@fixme`, `@slow`, `@skip`) and sends them as `testAnnotations` in every test case payload. These are stored per-run on the `test_runs_cases` table and rendered as badges on the test case row and test case detail page. A `@slow` mark combined with a test's duration history powers the **stale `test.slow()`** detection in [Timeout opportunities](/features/slow-tests#timeout-opportunities).

### Test tags

The reporter reads each test's tags (`TestCase.tags`) and sends them as `tags`. Playwright already folds together both
ways of declaring one, so either works:

```typescript
test('checkout applies the discount @smoke', async ({ page }) => { /* … */ })

test('checkout applies the discount', { tag: ['@smoke', '@critical'] }, async ({ page }) => { /* … */ })
```

Tags are stored twice: on the execution (`test_runs_cases.tags`, what that run saw) and on the test case
(`test_cases.tags`, the latest declaration). The leading `@` is stripped on the way in, so a tag reads the same however
it was written — filter for `smoke` or `@smoke` and you get the same rows. Removing a tag from a spec clears it on the
next run that reports the test.

Tags drive the `tag:` qualifier of the Tests tabs' [search](/reference/test-search), the tag filter on the flaky
leaderboard, and the `requireTags` rule of the [CI gate](/guide/ci#blocking-a-merge).

#### Tag limit

Piwi keeps at most 20 tags per test, each cut to 60 characters, in the order Playwright lists them; duplicates count
once. A test that declares more keeps its first 20 and loses the rest. The reporter warns about it once as the run
begins, naming the tests (20 at most), and records them on the run: the run page shows "Tags cut at 20 on N tests",
with the tests in its Details. When more than 20 tests lost tags, the page shows "at least 20 tests", the number it
lists, since merging a run's reports (shards, or a payload sent in batches) can count a test twice. The dashboard does
the same for a run sent without the reporter, or imported from a blob report.

Which tags are cut depends on Playwright's order. Playwright 1.64.1 builds `TestCase.tags` from the config's `tag`
first, then each `describe` from the outermost in (the @-words of its title, then its `tag` option), then the @-words
of the test title, and the test's own `tag` option last. So a tag in the test's `tag` option is the first to go. To
keep the tags that matter:

- keep config and `describe` tags few;
- put the tags that matter in the test title (`test('checkout @SHOP-T123', …)`), which comes before the `tag` option;
- for the one identifier that matters most, use an [external test ID](#external-test-ids) instead of a tag.

#### Keys in test tags

A tag can name the issue a test is tracked in (`SHOP-1234`) or the test case it covers (`SHOP-T123`). Two patterns, under
**Project → Settings → Integrations → Keys in test tags**, tell Piwi which tags are which:

- **Issue key**: a tag naming an issue, such as `^[A-Z][A-Z0-9]+-[0-9]+$`.
- **Test case key**: a tag naming a test case, such as `^SHOP-T[0-9]+$`.

A pattern is a regular expression without flags, tested against the tag without its `@`, at most 200 characters. Anchor
it with `^` and `$` and use letters, digits, character classes and quantifiers only, with no groups or `|`:
`^SHOP-T[0-9]+$` matches `SHOP-T123` and not `SHOP-1234`. A pattern that breaks that rule, does not compile, or matches
an empty tag (and so every tag) is refused. Leave a field empty to turn it off; both are off by default, and neither
needs a tracker connection. Saving needs the same role as the rest of the project's settings.

When both patterns are on, the section lists the tags of the project's last complete run (the whole suite, finished;
partial, lab and private runs are skipped) that both patterns match, each with a test that carries it. Piwi would read
such a tag as an issue and as a test case, so anchor the patterns until the list is empty. It lists 20 tags at most.

### Test locks

Playwright 1.63 lets a test or a `describe` declare a **lock** — a named shared resource the runner never lets two
holders run at once:

```typescript
test('writes an order', { lock: 'database' }, async ({ page }) => { /* … */ })

test.describe('payments', { lock: ['database', 'external-api'] }, () => { /* every test inside inherits both */ })
```

The reporter reads the lock names and sends them as `locks`, stored on the execution (`test_runs_cases.locks`) and
denormalized onto the test case (`test_cases.locks`, the latest declaration) — the same treatment as tags. They power
the [Timeline tab's lock lanes and *Locks* table](/features/ui-overview#test-run-detail), the `lock:` search qualifier on
the Tests tabs and *Group by lock* on a run's, lock badges on every test row, and two [clues](/features/evidence#clues) (a lock's previous holder failed;
a lock was held on two shards at once).

Capture is **best effort**. Playwright exposes locks only to an in-process reporter — there is no public API property,
and the tele protocol that backs blob reports and `merge-reports` carries none — so a run recorded live has its locks
and a run [rebuilt from a blob import](/guide/importing-runs) has none. Locks also serialize only within one
`npx playwright test` process: two `--shard` runs are separate processes and can hold the same lock at the same time,
which the cross-shard clue points out.

### Ownership metadata (`piwi:` annotations)

Six `piwi:`-prefixed annotations attach ownership to a test, and a seventh, `piwi:id`, its [external ID](#external-test-ids). They are ordinary Playwright annotations, so no new API is
involved:

```typescript
test(
  'checkout applies the discount',
  {
    tag: '@critical',
    annotation: [
      { type: 'piwi:owner', description: '@checkout-team' },
      { type: 'piwi:priority', description: 'critical' },
      { type: 'piwi:feature', description: 'Checkout' },
      { type: 'piwi:link', description: 'https://issues.example.com/PROJ-412' },
    ],
  },
  async ({ page }) => {
    /* … */
  },
)
```

| Field | Accepts |
|---|---|
| `piwi:owner` | Any text — a team handle, a squad name, an email |
| `piwi:priority` | `critical`, `high`, `medium` or `low` (anything else is ignored) |
| `piwi:feature` | Any text — the product area, for grouping across spec files |
| `piwi:link` | An absolute `http(s)` URL; other schemes are dropped rather than stored |
| `piwi:bug` | The id of the Piwi bug report the test reproduces (`37` or `#37`); written by the spec a [bug report](/features/report-a-bug) generates |
| `piwi:issue` | The issue the test's failures are tracked in: its absolute `http(s)` URL or its key (`SHOP-412`). Repeat the annotation to name several, up to 10; a failure cluster is [linked to it](#issues-the-tests-declare) |
| `piwi:id` | The test's ID in your test management tool, see [External test IDs](#external-test-ids) |

Metadata shows as badges next to the test wherever it is listed, is searchable with `owner:`, `priority:` and `feature:`
on the Tests tabs ([test search](/reference/test-search)), and is carried into [pull-request feedback](/features/pr-feedback) so a failure comment names the team
that owns it. Unknown `piwi:` fields and unparseable values are ignored — a typo costs you the field, not the run.

The values are also re-validated server-side, because a payload can reach the ingest API without passing through the
reporter.

### Issues the tests declare

A `piwi:issue` annotation names the issue a test's failures are tracked in, by its URL or its key:

```typescript
test(
  'pays with a saved card',
  {
    annotation: [
      { type: 'piwi:issue', description: 'https://acme.atlassian.net/browse/SHOP-412' },
      { type: 'piwi:issue', description: 'SHOP-415' },
    ],
  },
  async ({ page }) => {
    /* … */
  },
)
```

It stays apart from `piwi:link` and from Playwright's own `{ type: 'issue' }`, which suites use for any related page.
When a [run that writes to the ticket](/features/issue-automation#the-runs-that-write) finishes, on a project
[bound](/features/issue-tracking#the-project-binding) to a Jira connection and a Jira project, Piwi links each failure
cluster to the issues its failing tests name ([Issue tracking](/features/issue-tracking#links-the-tests-declare)):

- **Only issues of the bound Jira project.** A key needs the shape `SHOP-412` with the binding's project as its
  prefix, a URL must point at the connection's site, and Jira must return the issue under that key and project, so an
  issue moved to another project is dropped. Anything else is dropped, not stored as a plain link. A binding without a
  Jira project links nothing.
- **One lookup per run**, of at most 50 keys, the most named first, within 10 seconds. With Jira down or slow, nothing
  is linked, and the next failing run that names the issue tries again.
- **At most 10 per cluster**, the first linked staying; links pinned by hand or filed by Piwi do not count. The other
  keys of the bound project its tests named in that run, neither linked nor removed, show as *and N more named by its
  tests* at the end of its links. A cluster already linking a key, by any route, gets no second link to it.
- The link's chip says *From the test's annotation*.
- **Removing one keeps it off.** A link from the tests removed on the dashboard or through the MCP tools is not linked
  to that cluster again, even once the issue moves; a merge keeps the removal on the surviving cluster and a split
  copies it to the new one. Pinning the issue on that cluster by hand lifts it.
- **Read-only.** No [policy](/features/issue-tracking#keep-the-ticket-honest) or [rule](/features/issue-automation)
  comments on it, moves it or updates its description, its status never resolves or reopens the cluster, and the issue
  body Piwi writes does not list it. The sync refreshes its status and removes it once the issue leaves the bound
  project.
- **It counts as tracked.** The cluster's known issue is its latest ticket filed or pinned, else the oldest link from
  its tests that is not Done, else the oldest one. Automatic creation files no issue for it, it leaves *Needs ticket*,
  and the pull-request comment and the `cluster.*` notifications name it.
- Pinning it with *Link an issue* turns it into a pinned link, which the write-backs then act on.

### External test IDs

Piwi recognizes a test by its file, its describe blocks and its title. Renaming a test, or moving it to another file or
describe block, would otherwise start a new test with no history: no flakiness stats, failure clusters, quarantine or
trends. When your tests already have an ID in a test management tool, give it to Piwi: a test with an **external ID**
is matched on that ID first, and a renamed or moved test keeps its history, under its new title and place.

Declare it with a `piwi:id` annotation:

```typescript
test('Log in with Email', { annotation: { type: 'piwi:id', description: '12526' } }, async ({ page }) => {
  /* … */
})
```

Or, when the ID is already in every title, read it from there with the reporter's `externalId.pattern`:

```typescript
reporter: [
  ['@piwitests/reporter', { externalId: { pattern: /^(\d+),\s*/, stripFromTitle: true } }],
],
```

| Option | Default | Does |
|---|---|---|
| `pattern` | none | A regular expression (or its source as a string) applied to the test's own title. The ID is its first capture group, or the whole match without a group. Also `PIWI_EXTERNAL_ID_PATTERN`. |
| `stripFromTitle` | `false` | Show the title without the ID in the dashboard, next to the ID. The title stored and matched on stays whole, so commands that select tests by title keep working. |
| `onDuplicate` | `'report'` | Two tests declaring the same ID are listed in the console before the first test runs, and on the run page. `'fail'` also fails the run. Also `PIWI_EXTERNAL_ID_ON_DUPLICATE`. |

- A `piwi:id` annotation wins over the pattern. Put it on the test, not on a `describe` block, where every test inside
  would declare the same ID.
- The ID is read from the annotations declared on the test, never from one added at run time with
  `testInfo.annotations.push()`.
- An ID is up to 120 characters, case-sensitive.
- The first run that declares an ID gives it to the existing test it matches by file, describe blocks and title, so
  turning the option on keeps every history. A test that already has an ID never takes another one: a test whose ID
  changed in your test management tool starts a new history, which you can join to the old one by merging them.
- Imports of older runs and Flake Lab runs match tests by their ID but never rename, move or give an ID to a test.
- **Duplicates:** an ID names one test. Tests declaring the same ID are matched by file, describe blocks and title, as
  if they had none, until each has its own. The same test in several Playwright projects is one test, not a duplicate.
  With `--shard`, each shard only sees its own tests: the dashboard also checks across shards and lists what it finds
  on the run page.
- The ID shows before the title in the test lists, on the test's page and on the execution page; click it to copy
  it. Search for it with `id:` ([test search](/reference/test-search)).
- **Test ID link:** in the project's settings (General), give the address of a test in your test management tool,
  with `{id}` where the ID goes (`https://tcm.example.com/case/{id}`). The ID chip then opens the test there.
- Pull-request comments, notifications and exports name a test by its ID and title: `12526 · Log in with Email`.
- **Merging two tests:** a rename or a move that was not matched (before the test had an ID, for example) leaves the
  history in two halves. On the test's page, project managers can use **Merge…** to pick the other half: its
  executions, quarantine, failure clusters, locators, coverage, bug reports and links move to this test, and the
  other test is deleted. Two tests that ran in the same run are two tests, and are never merged. This cannot be
  undone.

### Expected failures (`test.fail()`)

The reporter sends each test's `expectedStatus` as Playwright reports it (`failed` for a `test.fail()` test), stored on
`test_runs_cases.expected_status`; for a reporter or an import that does not send it, the server derives it from the
`fail`, `skip` and `fixme` annotations. The status follows Playwright: an expected failure that failed counts as passed,
and one that passed counts as failed, with "Expected to fail, but passed.". That second row is shown as **Looks fixed**
rather than as a failure: it joins no failure cluster, the pull-request comment tells you to remove `test.fail()`, and
the `bug.looks_fixed` [notification event](/reference/notification-events) fires once, on the first run of a branch
where it passes. A test that runs in several browser projects looks fixed only when it passed in all of them.

### Per-test timeout

The reporter records each test's effective per-test timeout (`TestCase.timeout`) and sends it as `timeout` (milliseconds) on every test case payload, stored on `test_runs_cases.timeout`. `0` means the test has no timeout (unbounded); runs reported by an older reporter that predates this field store `null`.

Together with the test's duration history this drives the **Timeout opportunities** analysis (see [Slow tests & wasted time](/features/slow-tests#timeout-opportunities)), which flags tests whose timeout far exceeds their real p95 duration so failures and hangs stop wasting time waiting.

### Skipped vs "didn't run"

The reporter distinguishes two outcomes that Playwright both reports as `skipped`:

- **`skipped`** — an intentional skip via `test.skip()` / `test.fixme()` (static, conditional, or runtime). These always carry a `skip`/`fixme` annotation, so the skip reason (when provided) is preserved in `testAnnotations` and shown on the test case. The annotation also decides the grey the status bars draw: a `fixme` skip is counted apart from a plain `skip` (it stays part of `skippedTests`), so a test switched off as known broken does not blend into the deliberate skips.
- **`didnotrun`** — a test that never actually executed. This covers three cases:
  - a test skipped as a side effect of an **earlier failure in a `describe.serial` group** (Playwright reports it as `skipped` with no annotation; the reporter reclassifies it);
  - a test of a project whose **[project dependency](https://playwright.dev/docs/test-projects#dependencies) failed**, such as the tests that need a `setup` project's login (Playwright runs none of them);
  - a test that Playwright **never started because the run was cut short** (no `onTestEnd` fires for these or the previous case — the reporter materializes them from the planned test list so they still appear, with zero duration and no error).

  A test declared skipped (`test.skip()`, `test.fixme()`, a skipped `describe`) is `skipped` even when the run stopped before reaching it.

Each `didnotrun` case also carries **`didNotRunReason`**, so the dashboard can say _why_ a test never ran rather than just that it didn't:

- `previous-failure` — skipped because an earlier test (or hook) in its serial group failed, or because a `beforeAll` hook failed, which skips the rest of its group in any mode. The reporter also records **`blockedBy`**, the location of the failing test that blocked it — so the did-not-run case links to its cause, names the hook when the failure happened in one, and the failing test lists the downstream tests it stopped from running.
- `dependency-failure` — not run because a test failed in a project its project depends on (`dependencies`), directly or through another project. `blockedBy` holds the location of that failing test, as for `previous-failure`.
- `global-timeout` — the run's `globalTimeout` elapsed before the test could start.
- `max-failures` — the run reached its configured `maxFailures` budget.
- `interrupted` — the run was otherwise cut short (a worker crash or a cancellation).

The run-level counter `didNotRunTests` aggregates these, and the dashboard renders them as a distinct "Didn't run" segment/badge separate from skipped.

### Test errors

The reporter sends a failed test's errors as one text, with the call log Playwright writes. What may be a secret in it
is written `<hidden>`:

- the text a fill or a typing typed, and the value of a credential header a request's log writes;
- the values an assertion quotes of a password field, or of a field whose locator names a secret (`Mot de passe`);
- a credential's shape wherever it stands, colored or not: a JWT, a bearer token, a service's key such as `sk_live_…`,
  `ghp_…` or `AKIA…`, a key or a token Piwi issues such as `pd_…`.

Each step's error, and the error line of a hook or a fixture that failed, are hidden the same way. The dashboard hides
them again as it stores a result, whatever sent it. An error that holds no secret is kept as it is, so it joins the
[failure cluster](/features/failure-clusters) it did. An error stored before the dashboard hid a credential's shape
has it hidden at the first start of the version that does, its failure cluster kept.

### Errors outside the tests

The reporter keeps the errors Playwright reports beside the tests (its `onError`), each with its message, the frames of
its stack and the place it was thrown, named relative to the Playwright config's folder:

- a global setup or global teardown that threw;
- a spec file that did not load: a syntax error, an import that failed, a `test()` call where none is allowed. `No
  tests found` and a web server that did not start come the same way, before any test runs, and the run then has none;
- a worker fixture whose teardown threw, with the tests the worker ran;
- the failure budget (`maxFailures`) that stopped the run.

The first 20 go with the run's end, as its `runErrors`, each message and stack cut to 4,000 characters, with what may
be a secret hidden as in a [test's error](#test-errors), and also a credential in a URL, a cookie or a JSON field, and a
value shaped like a token. A sharded run adds each shard's to the others'. The run page shows them under its header,
and the MCP `get_run` tool returns them as `runErrors`. A [blob report you import](/guide/importing-runs) keeps them
the same way.

### Test output

The reporter keeps what each attempt wrote to stdout and stderr (`TestResult.stdout` and `stderr`): the test's
`console.log` lines and what the code it ran printed, text or bytes read as UTF-8. Each stream has what may be a
secret hidden, as above, colored or not, and the value it gives a name like a credential's (`password: '…'`,
`API_KEY=…`), and past about 64 KB keeps its first and last lines, cut at a line break, with a line saying how many
lines and characters were cut between them. The dashboard stores each stream once per project however many
executions wrote it, and shows it on the execution's **Output** tab ([Failure evidence](/features/evidence)), in its
[offline export](/features/offline-export) and through the MCP `get_test_run_case` tool. An
[imported blob report](/guide/importing-runs) keeps each attempt's output the same way.

### Worker lanes

The reporter sends each attempt's worker twice: Playwright's `workerIndex`, the worker process, which is new every time
Playwright starts one (after a failed test, or for a test that needs another project or other worker options), and
its `parallelIndex`, the lane the process runs in, which the process started in its place keeps. The dashboard names a
worker by its lane, from 1 in each shard: **Worker 2** on the run's Timeline, in the Tests list's **Worker** sort, on
the execution page, in its [offline export](/features/offline-export) and in a `test.stuck`
[notification](/reference/notification-events), and `worker: 2` in the MCP `get_run` and `get_test_run_case` tools.
A [blob report you import](/guide/importing-runs) keeps both. A run from a reporter that sends no lane names a worker
by its process, and its Timeline works the lanes out from when each process ran; the MCP tools then give its
`workerIndex` in place of `worker`.

### Hooks

Playwright 1.59 and later give every hook step to a test: a `beforeAll` or `afterAll` hook and the setup of a worker
fixture are steps of the test they ran for. The run's timeline draws them inside that test's bar, as its setup and
teardown sections, never on a lane of their own. A worker fixture that throws as its worker shuts down, after its last
test, is one of the [errors outside the tests](#errors-outside-the-tests).

## With custom metadata

```typescript
export default defineConfig({
  reporter: [
    ['@piwitests/reporter', {
      serverUrl: 'http://localhost:3000',
      projectName: 'my-project',
      projectDescription: 'End-to-end tests for the main application',
      environment: 'staging',
      relatedIssue: 'PROJ-123',
      tags: ['regression', 'critical'],
      customData: {
        version: '1.2.3',
      },
    }],
  ],
})
```

## Disabling automatic collection

```typescript
export default defineConfig({
  reporter: [
    ['@piwitests/reporter', {
      serverUrl: 'http://localhost:3000',
      projectName: 'my-project',
      collectScmInfo: false,
      collectCiInfo: false,
      collectPerformanceMetrics: false,
    }],
  ],
})
```

## Related

- [Reporter](/guide/reporter): install and configure the reporter
- [Reporter options](/reference/reporter-options): every option and its `PIWI_*` variable
- [Core concepts](/guide/concepts): test case, execution and the other terms these fields attach to
