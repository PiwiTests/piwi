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
and `local` otherwise. A launcher names itself through two environment variables on the Playwright process:

| Variable | Value |
|---|---|
| `PIWI_ORIGIN` | `ci`, `ci-rerun`, `local`, `desktop`, `editor`, `preflight`, `bug`, `flake-lab`, `probe`, `bisect` or `reproduce` |
| `PIWI_ORIGIN_REF` | Optional: what the run was launched for, such as a dispatch, a cluster or a bug report id (letters, digits and `._:/#@-`, up to 200 characters) |

Piwi's own launchers set them: the desktop app (`desktop`, and `reproduce` or `bisect` with the cluster id), the
editors (`editor`, with a ref of their own on each test run, which they find the run by), `piwi preflight --run`
(`preflight`), `piwi bug --write` (`bug` with the report id), Flake Lab and probes. A
[re-run dispatched from the dashboard](/features/pr-feedback#re-run-from-the-dashboard) is recorded as `ci-rerun` once
Piwi recognizes it, and an imported report as `import`. You rarely set them yourself.

What each origin feeds:

- **Flake Lab and probe runs** feed nothing: they replay tests under conditions Piwi injected.
- **Bisect steps and reproductions** run at a commit chosen to investigate a failure. They notify like any run, but
  stay out of baselines, fix verification, flaky scores, selections, change coverage, the stored locators and test
  metadata, auto-heal, the bug-report lifecycle and the [automatic writes to an issue
  tracker](/features/issue-automation#the-runs-that-write).
- **`piwi bug` runs** do not move the bug report they were written for.
- **Local runs** (`local`, `desktop`, `editor`, `preflight`) count like CI runs, with two exceptions. An editor's CI
  failures come from the newest complete CI run on the branch, and a local run stands in only while the branch has
  none. An `editor` run, or a `local` or `desktop` run of part of the suite, fires no run, new-cluster, flakiness or
  performance [notification](/features/notifications#events), posts no
  [pull-request comment or commit status](/features/pr-feedback), starts no automatic AI diagnosis or auto-heal, and
  writes nothing to an [issue tracker](/features/issue-automation#the-runs-that-write) on its own.
- **Partial runs** (a `--grep`, a file filter, a selection) never count for change coverage, which asks whether a
  file was reached in the recent runs.

### Playwright configuration

The reporter also records browser project configs, worker count, the global timeout, and parallel settings.

### Browser configuration per test case

The reporter automatically captures each test case's Playwright project configuration — `projectName`, `browserName`, `channel`, `viewport`, and the rendering options `colorScheme`, `reducedMotion`, `forcedColors` and `contrast` (Playwright 1.63's standalone contrast option) — via `test.parent.project()`. This is stored in the `browser` field of every test case result and feeds the [environment diff](/features/evidence#one-execution-diagnosis-first) that compares a failing execution against its last passing one.

In the dashboard UI, every row of a run's Tests tab shows the browser icon, and `browser:chromium` in its [search](/reference/test-search) narrows the list to one project.

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

Five `piwi:`-prefixed annotations attach ownership to a test. They are ordinary Playwright annotations, so no new API is
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

Metadata shows as badges next to the test wherever it is listed, is searchable with `owner:`, `priority:` and `feature:`
on the Tests tabs ([test search](/reference/test-search)), and is carried into [pull-request feedback](/features/pr-feedback) so a failure comment names the team
that owns it. Unknown `piwi:` fields and unparseable values are ignored — a typo costs you the field, not the run.

The values are also re-validated server-side, because a payload can reach the ingest API without passing through the
reporter.

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
- **`didnotrun`** — a test that never actually executed. This covers two cases:
  - a test skipped as a side effect of an **earlier failure in a `describe.serial` group** (Playwright reports it as `skipped` with no annotation; the reporter reclassifies it);
  - a test that Playwright **never started because the run was cut short** (no `onTestEnd` fires for these — the reporter materializes them from the planned test list so they still appear, with zero duration and no error).

Each `didnotrun` case also carries **`didNotRunReason`**, so the dashboard can say _why_ a test never ran rather than just that it didn't:

- `previous-failure` — skipped because an earlier test (or hook) in its serial group failed, or because a `beforeAll` hook failed, which skips the rest of its group in any mode. The reporter also records **`blockedBy`**, the location of the failing test that blocked it — so the did-not-run case links to its cause, names the hook when the failure happened in one, and the failing test lists the downstream tests it stopped from running.
- `global-timeout` — the run's `globalTimeout` elapsed before the test could start.
- `max-failures` — the run reached its configured `maxFailures` budget.
- `interrupted` — the run was otherwise cut short (a worker crash or a cancellation).

The run-level counter `didNotRunTests` aggregates these, and the dashboard renders them as a distinct "Didn't run" segment/badge separate from skipped.

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
