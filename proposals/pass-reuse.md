# Pass reuse: skip the tests whose code has not changed since they passed

A design record for **pass reuse**: a run that skips each test whose recorded coverage shows that none of the code it
executed has changed since it last passed, and records that earlier pass in the run instead, with a link to it. The
coverage Piwi already stores per execution (every file a test ran, with the git blob id of the version it ran) is the
evidence; impact-from-diff, applied with each test's own base, is the rule.

**Status.** Proposed 2026-11-09. Nothing is built. The contracts it would add are entry D66 of
[1.0-stabilization.md](1.0-stabilization.md). Nothing here is on [`ROADMAP.md`](../ROADMAP.md) yet.

**Summary.**

- **The rule.** A test's pass at commit _C_ is reused by a run at the working tree _W_ when the impact of the change
  _C_ → _W_ does not select that test and does not widen to the whole suite, the run's fingerprint (Playwright and
  browser versions, the Playwright project, the target environment) matches the pass's, and the test is not excluded
  (flaky, quarantined, in an open cluster, too old a pass). It is the impact rule of
  [Impact from a diff](../apps/docs/features/change-impact.md), applied with each test's last pass as its base instead
  of one `--base` for the whole run.
- **Branches share evidence.** The key is the content of the code, not the branch. A pull request reuses the passes
  `main` recorded for every test whose code the pull request does not touch, and a merge to `main` reuses the passes
  its pull request just recorded.
- **Measured before it is built.** The first step needs no new capture: from the coverage already stored, Piwi
  computes how many executions of the last 30 days ran code identical to an earlier pass, and how many of those failed.
  The first number is the upper bound of the saving; the second is the rate at which reuse would have hidden a failure.
  Both decide whether the rest is built.
- **A plan, then the shards.** `piwi plan` decides once which tests run and which are reused, so every shard of a CI
  matrix works from the same answer; `piwi run --plan <id> --shard i/n` runs its part. A single job uses
  `piwi run <selection> --reuse`.
- **Reused results are not executions.** They count as passed in the run's verdict and the CI gate, and nowhere else:
  never in flaky scores, pass rates, durations, fix verification or coverage.
- **A loop that checks itself.** A share of the reusable tests runs anyway on every plan, and every full run is
  replayed against the plan it would have made. A reusable test that failed is counted, named, and taken out of reuse.

## Problem

- **Every run executes tests whose result is already known.** On `main`, most commits touch a few files; the suite
  re-runs thousands of tests whose executed code is byte for byte the code of their last pass. On a pull request, the
  same tests ran on `main` an hour earlier.
- **Impact-from-diff answers a narrower question.** `piwi run impact --base origin/main` runs what a pull request
  changes relative to its base, which is right for the pull request's own job. It does not help the merge to `main`,
  the nightly run, a branch that merged `main` in, or a run whose tests last passed at different commits.
- **Playwright's `--only-changed` and `--last-failed` know less.** The first maps changed test files through the import
  graph of the test files and ignores application code; the second reruns what failed last time on one machine.
  Neither knows which application code each test ran.
- **Piwi already holds the evidence.** Since [unified code coverage](unified-code-coverage.md), each execution stores
  the coverage fragments it recorded, each fragment naming its file and the git blob of the version it ran
  (`test_runs_cases.coverage_payload_id` → `coverage_fragments.blob`). Line-level impact
  ([D59](1.0-stabilization.md)) already reads a diff against that coverage. Reuse is the same reading with one more
  input: which commit each test last passed at.

## What exists

| Piece | Where | What pass reuse takes from it |
| --- | --- | --- |
| Per-execution coverage with blob ids | `coverage_fragments` (`blob`, `functions`, `lines`), `test_runs_cases.coverage_payload_id`, `getExecutionsCoverage` and `incompleteCoverageTests` (`server/utils/coverage.ts`) | The files and functions a pass ran, at the version it ran |
| Impact resolution | `resolveImpact` (`server/utils/selection-impact.ts`): direct, frames, code reach and route edges; widening on unmapped files and frames-only files; documentation exemption | The rule itself, run once per source commit |
| Line-level narrowing | `lineImpact`, `sameBlob` (`shared/line-impact.ts`), the `changes` field of `POST /selections/impact` | A changed file whose changed lines the pass did not run does not invalidate it |
| Diff collection | `gitChange` (`packages/reporter/src/cli/select.ts`), `diffImpactInput` (`@piwitests/core/suspect-lines`) | The change list per source commit, with base blobs |
| Selections, shards, fail-fast | `shared/selection/` (`materialize.ts`, `shard.ts`), `piwi select` / `piwi run` | Reuse filters a resolved selection before it is sharded and materialized |
| Shards merged into one run | the run label (`guide/ci.md#sharding`) | The shards of a plan report into one run |
| Environment snapshots | `WireEnvironmentSnapshot` ([D65](1.0-stabilization.md)) | Playwright and browser versions for the fingerprint |
| Partial-run rules | `test_runs.is_full_run`, `filter_details` | What a run with reused results counts for |
| Capabilities | [capabilities-opt-out.md](../adr/capabilities-opt-out.md) | An instance-wide switch, off by default |

Coverage at `functions` or `lines` is what makes a pass usable: a fragment keeps its blob only with line numbers
(`fileEntry` in `@piwitests/core/coverage`), so `coverage.browser: 'files'` records reach without the version it
reached. Server coverage ([server coverage](../apps/docs/features/server-coverage.md)) adds the backend files; without
it, a changed server file maps to no test, and the rule below runs every test.

## The rule

A **source** is an execution _E_ of test _T_ that may stand in for a later one. _E_ qualifies when:

1. It passed on its first attempt, in a run that was neither private, imported, a Flake Lab run nor a `piwi bug` run.
2. Its coverage is complete (not in `incompleteCoverageTests`) and every file of it carries a blob.
3. Its run came from a clean checkout of a commit _C_ (the reporter records whether the tree was dirty; a dirty tree
   has no commit to diff from).
4. Its run's fingerprint equals the current one: `@playwright/test` version, the browser revisions, the Playwright
   project's name and resolved `use` options (the `browser` field already captured per test case), and the target
   environment (the run's `environment`, or the `baseURL` origin when none is set).
5. It is younger than `maxAge` (14 days by default).

_T_ is **reused** in a run at working tree _W_ when it has a source _E_ at commit _C_ and:

1. The impact of _C_ → _W_ does not select _T_, read against _E_'s own coverage (not the test's latest coverage), at
   line level where the change carries base blobs.
2. That impact did not widen: every changed file maps to some test, or is documentation, or matches the project's
   `inertPaths`. A lockfile, the Playwright config, a `.env` file, an added file that no test reaches: each maps to no
   test, so each runs everything, as it does for impact.
3. _T_ is not excluded: quarantined, in an open failure cluster, flaky (any failed or retried execution in its last 20
   on any branch), new or renamed (no source), tagged `@no-reuse` (or the project's `noReuseTags`), or drawn for
   verification (below).

The rule inherits impact's assumption, stated in the same words in the docs: a line a test did not run cannot change
that test's path. Three inputs sit outside it, and the design answers each:

| Input the coverage does not see | Answer |
| --- | --- |
| Test-side code (spec helpers, page objects, fixtures) | Today a changed support file maps through failure frames only, which widens. The test-side reach capture (delivery step 5) maps it per test. Until then, a change to a helper runs everything: safe, fewer hits. |
| Code that runs without a function being called (module top level, auto-registered components, glob imports) | Line-level impact already reads a change outside every function as reaching every test of the file; an added file maps to no test and widens. |
| State outside the repository (database seeds, third-party services, time) | Not observable by reuse. `maxAge`, the verification share and the audit of full runs bound how long a wrong reuse can stand; a scheduled full run stays the reference. |

## Design

### 1. The forecast, from data already stored

Before any wire change, a server-side analysis answers "would this pay, and would it be safe" on the project's own
history. For each execution of the window (30 days, the default branch and the pull-request branches apart), it looks
for an earlier first-attempt pass of the same test and Playwright project whose fragments name the same files with the
same blobs.

- **Reusable share**: executions that ran code identical to an earlier pass, and the test time they took. This is an
  upper bound: it ignores unmapped changes and test-side files, which only lower it.
- **Identical-code failures**: reusable executions that failed. Each is a failure that happened with no change of the
  code it ran, so it was caused by the test, the data or the environment. That is the rate at which reuse would have
  hidden a failure, and, as a by-product, the strongest flakiness evidence Piwi can produce: it feeds the flaky
  classifier as a signal of its own whether or not reuse is ever turned on.

Shown on the Selections tab as a card ("63% of last month's test time ran code identical to an earlier pass; 4 of
11,200 such executions failed, all of them in 2 tests already marked flaky"), and through the MCP tool
`get_reuse_forecast`. Needs coverage at `functions` or `lines`; with none, the card says what to turn on.

### 2. The plan

```
npx @piwitests/reporter plan full --reuse [--shards-for 8m] [--json]
npx @piwitests/reporter run --plan <id> --shard 2/4
npx @piwitests/reporter run full --reuse            # one job: plan and run in one step
```

`piwi plan` resolves a selection (`full`, a saved key, or `impact`), then:

1. Reads the commit, the cleanliness of the tree and the fingerprint locally.
2. Asks the dashboard for the **source commits**: for each resolved test, its newest qualifying source; the commits
   are grouped and at most 8 are kept, the ones that cover the most tests. A test whose source is on another commit
   runs.
3. For each source commit, makes the commit available (`git cat-file -e`, else `git fetch --depth=1 origin <sha>`,
   which works in a shallow CI clone) and sends `git diff --full-index --unified=0 <sha>` as impact's `changes`.
   A commit it cannot fetch is dropped, and its tests run.
4. The dashboard runs the rule per source commit and stores the **plan**: the tests to run, the tests reused with
   their source execution, the verification draw, and the reasons. It answers with the plan id, the counts, the
   estimated duration of what runs, and, with `--shards-for`, the shard count that fits the duration (from the summed
   test durations and the shards' measured start-up time).

`piwi run --plan <id> --shard i/n` fetches the plan, takes its shard of the tests to run (duration-balanced and
lock-aware, as `piwi run --shard` is today), and sets `PIWI_PLAN` so the reporter attaches the run to the plan. Every
shard reads the same stored plan, so no test is dropped or run twice when another run lands between two shards'
start. A plan expires after 24 hours.

When the dashboard is unreachable, `piwi run --reuse` runs everything, as `piwi run` already falls back to the full
suite; `--strict` makes it exit 2.

### 3. Recording reused results

One new table, both dialects:

```
reused_results
  id, run_id FK, test_case_id FK, playwright_project, source_execution_id FK (set null),
  source_run_id, source_commit, plan_id, created_at
```

Written once when the run attaches to its plan, not per shard. A reused result is not a `test_runs_cases` row: every
query that counts executions (pass rates, flaky scores, durations, the catalog's aggregates, retention's budgets)
stays correct without a filter. The run gains a `reused_count` column beside its counters.

| Surface | A reused result |
| --- | --- |
| Run status and verdict | counts as passed |
| Run page | its own section: "3,120 reused", each with its source run, commit, age and the reason it held |
| CI gate | passed; `--max-reused <n|%>` caps it, `--require-executed <tag>` forces a tag's tests to run, `--require-selection` counts a reused test as run unless `--require-executed` names it |
| Pull-request feedback | the summary line: `1,240 passed · 3,100 reused (code unchanged since they passed)` |
| Flaky scores, pass rate, durations, analytics | not counted |
| Fix verification | never verifies a fix |
| Coverage (change coverage, the Test Map, uncovered changes) | not counted: the partial-run rule applies |
| Notifications, issue automation | nothing is sent for a reused result |
| `is_full_run` | 0 for the run; `GET /api/test-runs/:id` gains `reused` with the count and the plan id, so "the suite is green at this commit" reads executed + reused |

### 4. Safety

- **Verification share.** Each plan runs a share of its reusable tests anyway (`verifyShare`, 5% by default), drawn
  from a seed stored with the plan, weighted toward the oldest sources. Their outcomes measure the false-reuse rate on
  live data.
- **Audit of full runs.** When a full run of the default branch ends, the dashboard computes the plan it would have
  made for it and compares: a test it would have reused that failed is a **false reuse**.
- **What a false reuse does.** The test is excluded from reuse until it has 20 consecutive first-attempt passes, with
  the evidence on its page; the project's Settings show the false-reuse rate of the last 30 days; above
  `maxFalseReuseRate` (0.1% by default), reuse turns itself off for the project and notifies the project admins.
- **Off by default, twice.** A `pass-reuse` capability, off until an administrator turns it on, and a per-project
  setting. Reuse never applies to a run that did not ask for it with `--reuse` or `--plan`.

### 5. Test-side reach

Test-side code (spec helpers, page objects, fixtures) is where most suites change most often, and the frames-only edge
makes every such change widen. The reporter records, per test, the repository files its worker loaded on the Node side:

- the in-repository modules the worker had loaded before the test started, attributed to every test of that worker,
  and those it loaded during the test, attributed to that test (file level, over-approximating, so a test is never
  missed);
- excluding `node_modules`, and reading ESM modules through a `module.registerHooks` resolve hook where Node offers it,
  falling back to `require.cache`.

Stored as `code_reach` rows with `runtime: 'node'`, it is read by impact as well as by reuse: `piwi run impact` and
`piwi preflight` stop widening on a changed page object. A function-level variant (precise V8 coverage of the worker
through `node:inspector`) is measured by the bench before it is offered.

### 6. Agents and editors

- MCP: `get_reuse_forecast`, and `plan_run` (`{ projectId, selection, reuse }` → the plan's counts, tests to run,
  reasons and command). The `run-the-right-tests` skill offers reuse for a full-suite check after a refactor.
- The editors' **Run what changed** runs the plan's tests to run, on the developer's machine, with the plan computed
  against the dirty tree: a local run that is never a source (rule 3), so nothing it reuses leaks back into CI.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Reuse is impact with a per-test base, not a new dependency model | One rule to trust, test and document; every precision gain in impact (line level, test-side reach, CSS coverage) improves reuse too |
| D2 | The key is content (commit diff and blobs), never the branch | A pull request reuses `main`'s passes and the merge reuses the pull request's, which is where most of the saving is |
| D3 | Sources are first-attempt passes from clean checkouts with complete, blob-carrying coverage | A retried pass is flake evidence, a dirty tree has no commit to diff, and a file without a blob cannot be compared |
| D4 | Uncertainty runs the test: an unmapped change widens, a commit that cannot be fetched runs its tests, an unreachable dashboard runs everything | The failure of the feature must be a slower run, never a hidden failure |
| D5 | Reused results live in their own table and count only toward the run's verdict and the gate | Execution statistics stay true without every query learning a new status |
| D6 | A plan is resolved once and stored; shards read it | Shards started minutes apart must agree on what runs |
| D7 | The forecast ships first and alone | It measures the saving and the risk on the project's own data before any wire change, and its identical-code failures are useful on their own |
| D8 | Off by default: a capability and a per-project setting, and only for runs that ask | A test tool that skips tests silently loses trust |

## Delivery

| PR | Content | Visible result |
| --- | --- | --- |
| 1 | The forecast: the analysis, the Selections tab card, `get_reuse_forecast`, identical-code failures as a flaky signal | "how much would reuse save here, and how often would it have been wrong" |
| 2 | The engine: sources, the fingerprint and clean-tree flag on the wire, per-source-commit impact against the source's coverage, `plans` storage, `POST /api/projects/:id/plans`, `piwi plan`, `piwi run --plan` and `--reuse`, the capability and project setting | a full run that executes only what changed |
| 3 | Recording and surfaces: `reused_results`, `reused_count`, the run page section, the gate flags, the pull-request summary line, the demo's handlers | reuse visible and enforceable |
| 4 | Safety: verification share, the audit of full runs, false-reuse exclusion, the rate and the automatic switch-off | reuse that checks itself |
| 5 | Test-side reach (`runtime: 'node'`), read by impact and reuse | fewer widened plans; `piwi run impact` stops widening on helpers |
| 6 | `--shards-for`, `plan_run`, the editors' Run what changed, the docs page `features/pass-reuse.md` | the plan as the entry point of every run |

PRs 2 to 4 ship together behind the capability: reuse without its safety loop is not offered.

## Open questions

1. **The flaky exclusion window.** Twenty executions on any branch is a guess; the forecast's identical-code failures
   should set it per project.
2. **Third-party hosts.** A test whose requests leave the `baseURL` origin depends on a service the coverage cannot
   see. Exclude such tests by default, or leave it to `noReuseTags`?
3. **Carrying coverage forward.** A reused test's coverage still describes the new commit for every file it ran
   (none changed). Counting it for the Test Map and change coverage would keep those views full on reuse runs, at the
   cost of a second meaning for "reached in recent runs".
4. **Sources from local runs.** A desktop or editor run on a clean checkout qualifies under the rules above, but it ran
   on a developer's machine against a developer's environment. Restrict sources to CI runs at first?
5. **Visual comparisons.** A `toHaveScreenshot` test depends on the browser revision and the fonts of the machine;
   the fingerprint covers the first. Exclude snapshot tests by default?

## Not in this plan

- Caching anything but a pass: a failure is always run again.
- Static analysis or a build-time dependency graph: the evidence stays what the tests were seen to run.
- Reusing results across projects or instances.
- Other test frameworks.
