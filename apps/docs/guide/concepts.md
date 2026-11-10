---
title: Core concepts
description: "The vocabulary the docs and the dashboard share: project, run, test case, execution, failure cluster, baseline, analytics dashboard, the Test Map and its gaps."
lang: en-US
---

# Core concepts

Piwi reuses Playwright's vocabulary where it can, but a dashboard that keeps history needs a few
distinctions Playwright doesn't have to make — most importantly between *a test* and *one run of that
test*. This page defines the words the rest of the documentation and the UI use.

## The object model

<figure>
  <img src="/diagrams/data-model-grid.svg" alt="A project as a grid: test runs are columns, test cases are rows, and each cell holds that test case's executions in that run; one failure cluster spans failed executions of two test cases across two runs">
  <figcaption>A project holds one suite's results. A failure cluster groups executions, not test cases: it can span several of each.</figcaption>
</figure>

Read it in two directions:

- **Down** — "what happened in this run?" A run holds executions; each execution points at the test it
  is an attempt of.
- **Across** — "how has this test behaved?" A test case holds every execution of itself, in every run,
  over time. That's the axis flakiness, pass rate, and duration trends are computed on.

## Results

### Project

A named container for one suite's results — usually one repository, or one suite within it. Projects
are created automatically the first time results are submitted under a new `projectName`; you never
have to pre-register one.

A project carries its own tags, [role grants](#role-and-group), SCM connection, default branch, capability
decisions, and AI-diagnosis instructions. Retention is instance-wide. Its **status** is the outcome of its latest run,
or of the latest run in its [status filter](/features/branches#the-project-status) when it has one.

### Test run

Everything one `npx playwright test` invocation produced: counts, duration, the HTML report, CI and
git metadata, and every execution inside it.

Two things commonly surprise people:

- **Shards merge into one run.** Ten `--shard` jobs produce one run, not ten. The reporter derives a
  stable *run label* from your CI's pipeline ID and every shard submits against it; the run stays
  `running` until the last shard finishes. See [CI & sharding](./ci).
- **A run can be watched while it happens.** With streaming enabled (the default), the run row appears
  when the suite starts and fills in test by test, so a failure is browsable before CI finishes.

A **requested run** is one a person asked for from the dashboard and ran on their own machine: only they see it,
and it stays out of everything the team sees. See [Run on my machine](/features/run-on-my-machine).

A run **ran to its end** when it passed, failed or hit Playwright's global timeout. A project's health (Home's
Project health table and stat strip, the project header) reads only such runs: a run still in progress, interrupted
or cancelled shows in every list and in the trend bars with its status, and in none of those figures.

### Test case

The **identity of a test across time**, keyed by project + file path (relative to the folder holding your
Playwright config, whatever directory Playwright runs from) + `describe` path + title. It is not a row you submit — it's created and reused as results arrive, so renaming a test creates a new one
and moving a spec file does too.

A test case is browser-independent: `login.spec.ts › signs in` is one test case whether it ran on
Chromium, Firefox, or all five projects in your matrix.

This is the object at `/test-cases/:id` — pass rate, duration trend, and the list of every execution.

On a test's own pages (its page and Trend tab, the project's Tests tab, selections and spec health), a **run** of the
test is one result per run, Playwright project and `--repeat-each` repetition: its final attempt. A retry is never a
run of its own, and a test that failed, then passed on its retry, is one flaky run.

### Execution

**One attempt of one test case, in one run, on one browser.** Retries are separate executions, not a
field on one: a test that failed twice and passed on the third attempt contributes three executions to
the same run. So is each browser in a project matrix.

So is each `--repeat-each` repetition, which Playwright runs as a test of its own, with its own retries:
`--repeat-each=3` contributes three executions of the test, more with retries. The run counts each
repetition once, as Playwright's summary does, and a test failed in a run when one of its repetitions
failed, whatever the others did.

A test is **flaky** in a run when its last attempt passed after an earlier attempt failed or timed out. A
retry alone does not make it flaky. When one test of a `describe.serial` group fails, Playwright retries the
whole group: the tests that passed before and a `test.fail()` test that failed as expected pass again, and a
test that did not run behind the failure passes, none of them flaky. The last attempt decides: a test that
passed, then failed on the group's retry, counts as failed, where Playwright's summary calls it flaky.

Every view reads a result the same way: the run page and the run list, a test's history, status and Trend tab, the
catalog, the analytics, the notifications, the exports and the MCP tools. Piwi stores the verdict with each result's
last attempt as it ingests it, and gives the results and the flaky counts of runs stored by an earlier version theirs
when it upgrades.

A test is **interrupted** when the run's interruption (Ctrl+C, a crashed worker) cut it short. It counts in no
outcome: neither passed, failed, skipped nor did not run, and in no pass rate. The dashboard, the exports and the
notifications draw it in a neutral slate labelled *Interrupted*, and a count bar names the gap it leaves.

This is the object at `/test-run-cases/:id` — the error, steps, trace, screenshots, console, network,
Web Vitals, and (for a failure) the diagnosis view. When the docs say *execution* or *test-run case*,
this is what they mean; when they say *test case*, they mean the identity above it.

The distinction matters in practice: "this test is flaky" is a statement about a **test case**, and
"here is the stack trace" is a statement about one **execution**.

### Pass rate

**The passed results over the results that passed or failed.** A timed-out result counts as failed. A skipped,
did-not-run or interrupted result is in neither term, so a suite that skips tests by design, or a run stopped
halfway, is rated on the tests that ran to an outcome. A flaky result, passed on a retry, counts as passed. With no
passed or failed result there is no pass rate: the dashboard shows a dash, never 0% or 100%.

Every pass rate follows this one rule: a run's, a project's, Home's, a test's, the
[test pass rate metric](/reference/metrics) of Analytics and the quality reports, and a share link's README badge.

### Flaky rate

**A test's flaky runs over its runs that passed or failed**, the results the [pass rate](#pass-rate) divides by. A
flaky run passed on a retry, so it is one of the passed runs; a skipped, did-not-run or interrupted run is in neither
term. With no passed or failed run there is no flaky rate: the dashboard shows a dash.

A file's or a spec directory's flaky rate divides its tests' runs the same way: the Trend tab of a test, the file
headers of the project's Tests tab and the Spec health widget all follow this rule.

Other numbers about flakiness divide differently and are not a flaky rate: the [flakiness score](#flakiness-score), a
run's share of flaky tests (the `flakiness.spike` notification), and Flake Lab's **flaky N%**, shown beside a flaky
test in an editor and on Home. That one is the share of the test's recent runs that passed or failed (those the
flaky ranking reads) in which it failed or passed on a retry.

### Baseline (last green run)

Several views answer "what changed?" — the Changes tab and run insights, the regression signals on a
test, the CI gate and pull-request feedback, the bisect window, the environment and visual diffs, and
the git diff behind an AI diagnosis. They all compare against a **baseline**: the same test's, or the
project's, most recent passing run — chosen by **environment first, then branch**.

For a whole run, the ladder is walked **within the run's environment label** first, then again without
it. On each pass: the most recent passing run **on the same branch**, else on the **base branch** the
run's branch forked from (the pull request's target branch when the reporter captured one, else the
project's default branch), else on any branch. So a `staging` run on `feature/x` compares with the last
passing `staging` run on `feature/x`, then the last passing `staging` run on `main`, then any passing
`staging` run, and only then with a run from another environment. A run whose branch is unknown only
has the "any branch" rung; a run with no environment label only walks the branch ladder. The Changes
tab names the run it picked and the rung that applied ("No passing staging run exists on feature/x; the
last passing run on the default branch main in staging"), and lets you pick a different **base branch**
or one specific run — see [What changed in a run](/features/run-changes#the-baseline). When no earlier
full run passed, the Changes tab and the MCP `get_run_insights` tool fall back to the last failed run,
found by the same ladder; the regression signals, the CI gate and pull-request feedback do not.

The environment, visual and page diffs compare one execution against the same test's last passing
execution on the same browser, with the same environment-first order: a `development` failure is diffed
against the last passing `development` run, then the same branch, then whatever is most recent. When no
passing run from the same environment exists, the card says which environment the baseline came from
("compared with a production run; no passing development run of this test exists") and leaves the
environment label out of the diff.

The **default branch** is resolved per project: an explicit setting in **project settings**, else the
repository's default branch read from the SCM provider, else `main`. The **base branch** of a
pull-request run is the branch the CI provider says the pull request targets (`GITHUB_BASE_REF` and its
equivalents), or `PIWI_BASE_BRANCH` when you set it — see [Branches](/features/branches).

Two derived flags are stored on the last attempt of each test in a run (of each repetition with
`--repeat-each`), never on an earlier attempt of a retried test:

- **New regression** — passed in the baseline, fails now.
- **New flaky** — passed in the baseline with no failed attempt, flaky now.

### Environment

A free-text label on a run (`production`, `staging`, a preview URL, whatever you use), set with the
reporter's `environment` option or `PIWI_ENVIRONMENT`. It's a **scoping** dimension, not a
configuration one: flaky analysis, analytics, and timeline markers can all be narrowed to a single
environment so a staging suite's noise doesn't blend into production's numbers.

### Environment incident

A **test run** whose failures come from the environment under test being down or broken (staging refusing
connections, a host that no longer resolves, a crashing browser), not from the tests or the code. Piwi flags it when
the run finishes, or a person marks it, and leaves it out of flaky scores, baselines, fix verification and the CI
gate, which answers *inconclusive*. See [Environment incidents](/features/environment-incidents).

### Tags & ownership

Two ways to say what a test *is*, both declared in the spec file and both read by the reporter.

**Tags** come from Playwright itself — `@smoke` in a title or the `{ tag: [...] }` option. Piwi stores them with the
leading `@` stripped, on the execution (what that run saw) and on the test case (the latest declaration). They are how
you slice the test-case catalog and the flaky leaderboard, and what the [CI gate](./ci#blocking-a-merge)'s
`--require-tag` rule matches on.

**Ownership metadata** comes from four `piwi:` annotations — `owner`, `priority`, `feature` and `link`. Where a tag
groups tests, this says who answers for one. It shows as badges wherever the test is listed and is carried into
[pull-request feedback](/features/pr-feedback), so a failure comment names the team rather than leaving a reviewer
to guess.

Both are optional and neither changes how a test runs. Details and the exact accepted values are in
[Test metadata → Test tags](/reference/test-metadata#test-tags).

**When a test declares no owner, Piwi reads your repository's CODEOWNERS instead.** Asking every team to annotate every
test is how ownership features die; the repository already records who owns which files, and Piwi can read it because it
runs inside your network with a token it already has. So ownership works on day one with no test edits, and a
`piwi:owner` annotation still wins wherever a team wants to be explicit.

That derived owner is used in [pull-request comments](/features/pr-feedback), on the flaky leaderboard, and by the
`owners` [notification filter](/features/notifications#subscriptions), which routes a run only to the team whose tests broke.
A public repository's CODEOWNERS is read without a token; a private one needs an
[SCM token](./source-control), and without it ownership falls back to annotations alone.

## Live runs

The words every tool uses for a run while it goes ([Watch a run](/features/watch-a-run)).

### Run number

**A run's id on the instance it reports to, `#78`, and its page there.** The reporter learns it as the run starts and
tells it to the editor or the desktop app that follows the run, so every tool links the same page.

### Run name

**The name a run carries before it has a number** (`piwiRunRef` in its metadata): the one its launcher gave it, an
editor's ref, a run request's id, else `local-<pid>-<time>` for a run outside CI. A CI run has none: its number names
it. See [Test metadata](/reference/test-metadata#run-origin).

### Worker

**One of the run's Playwright processes, named by its lane, `Worker 2`.** A lane is Playwright's `parallelIndex`,
counted from 1 in each shard; a worker Playwright starts again after a failure takes the same lane.

### Stop

**A test standing at a call, waiting to be answered:** at a breakpoint, after a step, at a Pause, at the line it was run
to, at `page.pause()`, or at a failure held for a look. Each tool names it by why it stopped, in the same words
(**Stopped at a breakpoint**, **Paused**, …).

### Hold failures

**Whether a failed test waits at its line for an answer, in one run.** It is the run's own: on from the start of a run
started with breakpoints, a debug run or a reproduction, off otherwise, and any tool that follows the run turns it on
or off, the editors, Piwi Picker's Runs window, the desktop app, or an agent (`run_follow`). Off, a failure goes on at
once, as without Piwi. A run nobody attends never holds one: a Flake Lab run, a bisect, a lab job, a run with
`--repeat-each` above 1 that does not stop at its first failure (`--max-failures=1`) and UI mode go on past each
failure. Each tool shows it as the last one set it: the desktop app's switch turns it off as the app's last window closes only when no other tool set it since.

### Presence, driving a stop

**Who else is on a run, and who acts at its stop.** Each tool says which others have the run open (a Runs window, the
desktop app, an agent that follows it), who watches each worker's page, and who drives a stop. One drives at a time: an
agent drives a stop it asked for or acted on, and a person takes it by a click or a pick on the page's view, or with
**Take control**. While a person drives, the agent's actions and controls at that stop are refused and it is told the
stop was taken; the person gives it back with **Give back**, by no longer watching the page, or by closing the tool. A
person's Resume, Step and Finish always answer the stop, and the stop a person's Step or Run to comes to stays theirs.

### Watch, Share live

**Watch** shows a worker's page as its test runs or stands stopped. Its frames go from the test's worker only to the
tools that watch that page (an editor's view, the desktop app's window, Piwi Picker's Runs window), and to the team
instance while the run is shared live; nothing on your machine keeps them. **Share live** lets a teammate watch a run on
your machine from its page on the team instance ([Share a run live](/features/share-live)); a CI run is watched without
being shared ([Live view of a run](/features/live-view)).

## Failures

### Error fingerprint & failure cluster

When an execution fails, Piwi hashes a normalized form of its error — error type, message with the
volatile parts masked out, and the locator with its dynamic arguments masked. That hash is the
**error fingerprint**. The masks take out what changes from one occurrence to the next:

- timeouts and other numbers, UUIDs, hashes, and ids glued to an underscore (`order_5f3a9c1e2b`);
- URLs, emails and timestamps (`2026-05-01T10:30:00Z`);
- the folders of a path under a home folder, a CI workspace or a Windows drive
  (`/home/runner/work/shop/fixtures/user.json` reads `<PATH>/user.json`), and the random end of a temporary
  folder's name (`playwright_chromiumdev_profile-Xo8n2p`);
- an assertion's expected and received values, and the list of elements a strict-mode violation prints;
- dynamic locator options, such as the `{ name: '…' }` of a table row.

Every failed execution sharing a fingerprint joins one **failure cluster**. Fifty red tests caused by
one broken endpoint become one cluster you triage once, with a status (open / resolved / ignored) and
a note.

Two clusters can also merge into one ([semantic merging](/features/ai-diagnosis#semantic-merging-optional)). A merge
never buries a live failure: the survivor ends open when either cluster was open and not snoozed, takes the other's
assignee when it has none and its note, and keeps its fix attempts, tracker history and dismissed pairs.

Fingerprints **ignore the failing stack frame** when the error says what failed, so the same root cause
reached from six different spec files, through a shared helper or page object, stays one cluster. A
**generic** error says nothing of its own: it names no locator, and its message is an `expect(…)` matcher
whose values are all masked, a test timeout, or a bare `TypeError` or `ReferenceError` line. Unrelated
tests fail with the same generic error, so its fingerprint also hashes the file of its failing stack frame:
the spec file, or the helper it failed in. Full detail:
[Failure clustering & AI diagnosis](/features/ai-diagnosis).

### Story

The **one explanation** a failure page leads with. When several [clues](/features/evidence#clues)
(deterministic, rule-based findings) form a known combination, Piwi chains them into a single sentence —
*"the Pay button stayed disabled because POST /api/checkout/quote was still in flight"* — at the strongest
member's strength, with every clue folded under it. When no combination matches, the story is the strongest
clue alone. A cluster's completed [AI diagnosis](/features/ai-diagnosis) leads instead of a weak story or a lone
clue, never instead of a strong or medium story, by one rule on the execution and the cluster page.

### Situation

The **context** of a failing execution, in two places on its page. The line under the headline says since when
the failure has been happening (on which commit and author) and whether a newer execution of the test, in the same
Playwright project, failed again or passed, with a link to the newest one. The **Cluster** line says how many other
tests share the cause and the cluster they join, its status, whether an earlier fix did not hold and who owns it,
then the cluster's issue. An exceptional case (a new regression, a newly flaky test, an infrastructure blip) leads
the line under the headline; for a test that passed on retry, the line says which attempt failed. It reads on the
execution page and, condensed, in [alerts](/features/notifications).

### Next step

The **one recommended action** a failure page leads with, chosen by a policy rather than offered as a menu —
apply a diagnosed patch, replace a broken locator, reproduce locally, re-run in CI, mark a cluster resolved.
The page shows the step, the change it copies with where that change comes from (or one line on why), and the button
to do it; every other action lives in the toolbox.
The policy and its ordering are on [Fix plans](/features/fix-plans#the-next-step).

### Cluster state

Where a **failure cluster** stands, said in one sentence with one verb next to a colored dot: *still
failing*, *not seen for N runs — still open*, *fixed and verified — still open*, *fixed, but the diagnosed patch
still applies at the fix's commit*, *stopped failing*, *regressed — the fix did not hold*, *resolved*, *ignored*,
*snoozed* or *all tests quarantined*. It reconciles the human triage status with the machine-observed verdict; when
they disagree the state line offers the one action that closes the gap, unless the Next line already offers it.
*Not seen for N runs* counts the runs since the last failure that could have shown it: finished runs on its branch or
the default branch (no lab run, bisect step, reproduction or environment incident) that ran its tests and did not fail
with it. A test skipped, not run or interrupted is one a run did not run, and a run of the whole suite that ran to its
end counts even when a test of the cluster no longer exists; one stopped early (interrupted, cancelled, timed out or
cut short by `maxFailures`) counts only when it ran the cluster's tests. The failure of a cluster whose ticket is Done stopped once such a run came after its last
failure. A fix is verified in the Playwright projects the cluster's tests last failed in: a run that left such a
project out but still lists it in its config (another CI job runs it) says nothing, and a project the run's config no
longer lists (removed or renamed) does not count, and a test that last failed only in such projects is answered by a
pass in any project. A CI whose jobs each load a different project list (one config file per job, or a list built from
an environment variable) makes another job's project look removed, so a cluster that failed there is recorded fixed by
any job where its tests pass: give the jobs one list and select each job's projects with `--project`. See [Failure clusters](/features/failure-clusters#the-state-line).

### Flakiness score

A test case's **composite score** from two signals — retry passes (weighted 60%) and status alternation
across runs (40%), shown next to its overall failure rate — plus a **root-cause class** (timing, network, assertion,
environment, order, other) and an **impact ranking** in wasted CI minutes. It's a property of the test case,
computed over its execution history, which is why a test needs a few runs of history before it can be
called flaky. Only the runs where the test passed or failed count: a skipped, did-not-run or interrupted result is
neither a run nor a flip, so a test that never passed is never flaky. See [Flaky tests](/features/flaky-tests).

### Flake experiment

A `piwi flake` session on one flaky test: a **control arm** with no condition, then one **arm** per suspect, each
applying the suspect's condition (a delayed route, another test alongside) with retries off. Only failures with the
same error as the test's failures in history count. An arm **reproduced** the flake when at least half its runs
failed that way and it fails significantly more than the control; a **verify** experiment reruns that arm after a
fix. See [Flake Lab](/features/flake-lab).

### Fix attempt

A change a person or an agent reports having made to fix a failure cluster (a patch, a locator edit, a fix plan
carried out), on a commit or a branch. It is recorded **applied**, then **verified** when the cluster's tests pass on a
run that carries it (its commit, a `Piwi-Cluster: <id>` trailer in a commit message, or its branch), and
**regressed** when the cluster fails again. See [Agent skills](/features/agent-skills#what-agents-report-back).

### Locator snapshot

When the [capture fixtures](./capture-fixtures) are installed, every successful locator call records
what the element actually looked like — role, accessible name, test id, structural anchors — keyed by
the **call site** (`file:line`) rather than the selector text. One row per call site, refreshed on each
passing run. A click is read as it starts, beside the action, so a **Place order** button that submits
and leaves the page is kept too; an Enter that submits its form at once can leave before its field is
read.

When that locator later fails, those snapshots are what Piwi ranks replacement locators from. See
[Locator healing](/features/locator-healing).

## Analytics

### Metric, dashboard and quality report

A **metric** is a named number with one definition every surface reads: test pass rate, run success
rate, wasted CI minutes, median time to fix, and the rest of the metric catalog. The Analytics page, the
MCP tools and quality reports all print the same definition, so a number means the same thing wherever
it appears.

An **analytics dashboard** is a named arrangement of analytics widgets in bands, with a default scope.
*The dashboard* on its own means the Piwi web app; on the Analytics pages, where the context is clear, an analytics
dashboard is simply called a dashboard. The Analytics page is the built-in *Overview* dashboard; *Executive*,
*Engineering*, *Team* and *Gaps digest* are the built-in dashboards meant for reports. Anyone can save a dashboard of
their own, private or shared, and a dashboard never grants access to a project. See [Dashboards](/features/dashboards).

A **quality report** is an analytics dashboard rendered as a document (PDF, HTML, Markdown, Excel, CSV or JSON) for a
reader who does not open the dashboard. It is not the **run report**, the Playwright HTML report a run
carries. See [Quality reports](/features/quality-reports).

A **report schedule** sends a quality report to notification channels on a cadence (daily, weekly,
every other week, monthly), and every quality report generated is kept as a **report snapshot**, with its
numbers as they were when it was generated.

## Test Map

The **Test Map** is one graph per project of what the application exposes (pages, controls, links, routes, the
handlers and dependencies behind them) and which tests reach each of them. It is built from what the reporter already
records, accumulates across runs, and keeps the rows of a non-default branch apart, so a route added on a pull
request never shows up as missing on the default branch. See [Scenario gaps & the Test Map](/features/scenario-gaps).

### Reach

A test **reaches** a route or a page when a real run observes it doing so: a request to the route, or a locator call
on the page or the test ending there. A control or a link is reached when one of the test's locators names it, or when
triage records a covering test for it. Reach is measured from runs, never from instrumented code coverage, which is
why the docs and the dashboard say *observed reach* rather than *coverage*.
The reach of a test flaky or failing in the default branch's recent runs, quarantined or skipped does not count as
trusted.

### Feature and hub

A **feature** is a product area named by the [`piwi:feature` tag](/reference/test-metadata) on tests. It groups what
those tests reach, and what they miss nearby: the controls on its pages, the pages they link to, the declared routes
beside its own. A **hub** is a node most tests reach or most features group, such as a session route; it belongs to
no one feature, so it links none. See [how features group](/reference/gap-detectors#features).

### Code reach

The application source files a test executed: those whose functions ran in the page, from Chromium's JavaScript
coverage when [code reach](/features/code-reach) is on, those it ran in an ASP.NET Core backend with
[server coverage](/features/server-coverage) on, and the handler files of the routes it called
when the backend is instrumented. Observed reach at file level, never line coverage. It feeds
[impact-from-diff](/features/change-impact) and [Uncovered changes](/features/uncovered-changes).

### Coverage

Which source code a test ran, per repository-relative file and **runtime** (`browser` or `server`), at a
**granularity**: the files only, the functions that ran (their start and end lines), or the executed lines too, against
the git blob of the file version. Code reach is its file-level view. A test's coverage is **incomplete** when part of it
could not be collected.

### Coverage report and suite

A **coverage report** is one tool's coverage of one suite's whole run at one commit, uploaded with
[`piwi coverage upload`](/features/combined-coverage): per file, its **executable lines** (the lines that tool can mark
as run), the lines that ran and the functions it knows, attributed to no test. A **suite** is the tests a report comes
from, named when uploading (`unit-back`), of kind `unit` or `e2e`; not Playwright's `describe` block. The **coverage
scope** is the include and exclude patterns that decide which files a project's coverage counts.

### Coverage and the Test Map

Two answers to "what do the tests miss", each with its own number. **Coverage** measures the code: which lines and
functions ran, as a ratio over the lines that can run; the lines no test or suite ran are **lines not run**. The
**Test Map** measures the application: which routes, pages and controls the tests reach and would notice breaking;
what they miss becomes a [scenario gap](#scenario-gap), a test to write, ranked by exposure and never a percentage.
They meet on a project's [Coverage tab](/features/scenario-gaps#the-coverage-tab), whose views hold the gaps, the map
and the code, and at the file: a file's [coverage page](/features/code-reach#which-tests-run-a-file) lists the file's
nodes in the Test Map with their open gaps and opens the Map view on one, and the Map view's graph links a file or a
route handler to its coverage. Neither fails a build.

### Uncovered change

A changed file of a pull request that no test reached, in the run or the project's last 30 runs, and no suite ran a
changed line of. One rule decides it for the pull-request comment, the gate, MCP and the *changed, unreached* gap; a
file nothing can observe, outside the coverage scope or deleted is counted apart. **Patch coverage** is the same
question by line: the share of the changed lines that ran. See [Uncovered changes](/features/uncovered-changes).

### Reusable result

A test result whose code had already passed unchanged: an earlier first-attempt pass of the same test and Playwright
project, at most 14 days older, recorded file versions (path and git blob) that are all among the versions this result
ran, or ran at the same commit on CI. Either way, the pass recorded its file versions. A reusable result that failed is an **identical-code failure**: the test, its data or its environment caused it.
See [Reuse forecast](/features/reuse-forecast).

### Suspect lines

The lines changed since a failing test's last passing run that the failing tests executed, read from their
[coverage](#coverage) and the diff of the source control range: each changed hunk they executed, ranked by how many
passing tests of the same run executed it too (the Ochiai score of spectrum-based fault localization, 1 when only
failing tests did). Line coverage names the executed lines, function coverage the changed lines inside a function that
ran, and file coverage the whole hunk. When the host names the file's version at the head (GitHub, or a local clone
in the desktop app), coverage of another version counts as file coverage. The failure pages' **What changed** line names the first, the cluster's diff
lists them and marks them ([cluster page](/features/failure-clusters#the-cluster-page)), the
[AI diagnosis](/features/ai-diagnosis#scm-grounded-context) lists them and sends their files' patches first, and the
[fix plan](/features/fix-plans) carries the top five.

### Locator index

The locator chains each test used in its steps, recorded per branch and per Playwright project. It answers which tests
use a locator, and it feeds [Who uses a locator](/features/locator-usage) and
[Tested elements](/features/tested-elements).

### Locator break

A locator of the index that a change stops matching: the diff removes or renames a string one of its calls finds the
element by, under Playwright's text rules. *Likely* when the string was an attribute value, tag text or a
translation; *possible* when it was a bare quoted string. [Locator preflight](/features/preflight) lists them.

### Page key

A page's URL reduced to its path pattern: numeric ids, UUIDs, ULIDs, JWTs and long tokens become `:id`, `:uuid`,
`:ulid`, `:jwt` and `:token`, and the host, query and hash are dropped. `/orders/123?tab=items` and `/orders/456` are
both `/orders/:id`, on staging and in production alike. The Test Map's page nodes, the page each locator was used on
and the extension's **This page** all use it. A page of another site keeps its origin in front of the path. Piwi
Picker keys the page it is on through the [path prefixes](/features/extension-connection#url-patterns) of the site's
URL pattern: without the site's, with the tests' in front.

### Brittle locator

A locator a test uses that breaks on a change unrelated to what the test checks: a position, a styling class, the
document structure, a generated id. Piwi judges each locator of the index with named rules as *brittle*, *watch* or
*stable*; see [Locator stability rules](/reference/locator-stability). Not to be confused with the *fragile*
[gap class](#gap-class), which is about the tests reaching a node, not a locator.

### Scenario gap

A test the suite does not have yet, proposed from the Test Map with its evidence and a next step: a route no test
reaches, a control nobody exercises, a changed file no test reaches. A gap is triaged like a failure cluster: accept
it, snooze it, dismiss it with a reason, or mark it covered by an existing test.

### Gap class

How serious a gap is:

- **blind-spot**: nothing reaches it.
- **false-comfort**: the tests pass without checking it: a [probe](#probe) broke it and every test still passed, the
  application reported an error during a passing test, or every check on a page is only that elements are there.
- **fragile**: what reaches it could stop at any time: a single trusted test, a test whose every reached node
  disappeared, or a fix that did not hold.

Server probes report **findings** rather than gaps, in two more classes: **unhandled** (the application did not handle
the injected failure) and **degraded** (it handled it badly).

### Detector

A rule that reads the Test Map and the run history and reports one kind of gap, such as *declared, never hit* or
*single covering test*. Each gap names the detector that raised it; [Gap detectors & exposure](/reference/gap-detectors)
lists them all.

### Exposure

The score that ranks gaps: the geometric mean of four factors (how often the files involved change, how long a changed
file has been changing, whether they were part of an earlier escaped failure, and the `piwi:priority` of the tests
that reach the node), multiplied by the detector's confidence. A factor with no input counts as 0.1. See
[Gap detectors & exposure](/reference/gap-detectors#exposure).

### Probe

A re-run of a passing test with one injected fault (a 500, an empty body, a dropped field, a slow response), recording
whether the test noticed. A client probe injects the fault at the Playwright boundary; a server probe asks the
[backend instrumentation](./backend-logs#server-probes) to inject it inside the server. A **probe run**, the run `piwi probe` produces, is marked as one, so no metric, failure cluster or
regression signal ever counts it. See [Probes](/features/probes).

### Declared surface

The routes and pages the application says it has, from the instrumentation's route manifest, a committed
`piwi.manifest.json` or an OpenAPI document, as opposed to the ones tests reached. A declared route nothing reaches
is a *declared, never hit* gap.

### Page inventory

The controls (role and accessible name) and links the reporter records on each visited page of a passing run, so the
Test Map knows what a page offers beyond what the tests clicked: at most 200 of each per page, never a field value.
It reads a page when its URL changes, once per page per worker, so a control that renders later, or only in a dialog,
is not in it. Off by default: turn it on with `capturePageInventory`.

### Map health

How complete a project's Test Map is, per input: the page inventory, the pages of locator calls, route handlers,
probes, the declared surface, change history and the function catalog, each against what it could hold, with the
detectors it wakes. A detector stays silent without its input, so a quiet Gaps view can mean a map that cannot see; the
panel under the gap list names the step behind each input that is short. See
[Scenario gaps & the Test Map](/features/scenario-gaps#map-health).

### URL pattern

A glob over a page's whole address (`*` within one part of the path, `**` across parts) that ties the pages of a site
to a project, with an optional environment and branch. Each project keeps its own list, and the browser extension
reads them to know which project the page it is on belongs to. See
[Extension connection](/features/extension-connection#url-patterns).

## Access

### Role and group

With [authentication](/operate/authentication) on, every account holds an **instance role**: **Administrator**, who
can do everything, or **Member**. A Member's rights in a project come from the **project roles** they hold there
(Viewer, Contributor, Maintainer, Project admin, Uploader), each granted on one project or on all projects. A
**group** is a named set of users that receives project roles the way a user does. A user's rights on a project are
the union of every role they hold there, directly or through their groups. See
[Access, roles and groups](/operate/project-access).

## Where each concept lives in the UI

| Concept | URL | Docs |
|---|---|---|
| Project | `/projects/:id` | [UI overview](/features/ui-overview#project-detail) |
| Test run | `/test-runs/:id` | [UI overview](/features/ui-overview#test-run-detail) |
| Test case | `/test-cases/:id` | [Failure evidence](/features/evidence#the-test-case-page) |
| Execution | `/test-run-cases/:id` | [Failure evidence](/features/evidence#one-execution-diagnosis-first) |
| Failure cluster | `/failure-clusters/:id` | [Failure clusters & the inbox](/features/failure-clusters) |
| Cross-project view | `/analytics` | [Analytics](/features/analytics) |
| Quality report | *Export* on `/analytics` and `/projects/:id` | [Quality reports](/features/quality-reports) |
| Report schedule, report snapshot | `/reports`, `/reports/:id` | [Quality reports](/features/quality-reports#report-schedules) |

## Related
- [Getting started](./getting-started) — get results flowing in
- [UI overview](/features/ui-overview) — a map of every page
- [Reporter](./reporter) — how each of these objects gets populated
