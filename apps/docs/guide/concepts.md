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

```
Project                      one test suite you submit results for
└── Test run                 one `npx playwright test` (all shards merged)
    └── Execution            one attempt of one test, on one browser
        └── belongs to a Test case   the test's identity across all runs
             │
             └── Failure cluster     executions that failed the same way
```

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
decisions, and AI-diagnosis instructions. Retention is instance-wide.

### Test run

Everything one `npx playwright test` invocation produced: counts, duration, the HTML report, CI and
git metadata, and every execution inside it.

Two things commonly surprise people:

- **Shards merge into one run.** Ten `--shard` jobs produce one run, not ten. The reporter derives a
  stable *run label* from your CI's pipeline ID and every shard submits against it; the run stays
  `running` until the last shard finishes. See [CI & sharding](./ci).
- **A run can be watched while it happens.** With streaming enabled (the default), the run row appears
  when the suite starts and fills in test by test, so a failure is browsable before CI finishes.

### Test case

The **identity of a test across time**, keyed by project + file path (relative to the folder holding your
Playwright config, whatever directory Playwright runs from) + `describe` path + title. It is not a row you submit — it's created and reused as results arrive, so renaming a test creates a new one
and moving a spec file does too.

A test case is browser-independent: `login.spec.ts › signs in` is one test case whether it ran on
Chromium, Firefox, or all five projects in your matrix.

This is the object at `/test-cases/:id` — pass rate, duration trend, and the list of every execution.

### Execution

**One attempt of one test case, in one run, on one browser.** Retries are separate executions, not a
field on one: a test that failed twice and passed on the third attempt contributes three executions to
the same run. So is each browser in a project matrix.

So is each `--repeat-each` repetition, which Playwright runs as a test of its own, with its own retries:
`--repeat-each=3` contributes three executions of the test, more with retries. The run counts each
repetition once, as Playwright's summary does, and a test failed in a run when one of its repetitions
failed, whatever the others did.

This is the object at `/test-run-cases/:id` — the error, steps, trace, screenshots, console, network,
Web Vitals, and (for a failure) the diagnosis view. When the docs say *execution* or *test-run case*,
this is what they mean; when they say *test case*, they mean the identity above it.

The distinction matters in practice: "this test is flaky" is a statement about a **test case**, and
"here is the stack trace" is a statement about one **execution**.

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

Two derived flags are stored per execution:

- **New regression** — passed in the baseline, fails now.
- **New flaky** — didn't retry in the baseline, passed on retry now.

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

## Failures

### Error fingerprint & failure cluster

When an execution fails, Piwi hashes a normalized form of its error — error type, message with the
volatile parts masked out (timeouts, numbers, UUIDs, URLs, expected/received values), and the locator
with its dynamic arguments masked. That hash is the **error fingerprint**.

Every failed execution sharing a fingerprint joins one **failure cluster**. Fifty red tests caused by
one broken endpoint become one cluster you triage once, with a status (open / resolved / ignored) and
a note.

Fingerprints deliberately **ignore the failing stack frame**, so the same root cause reached from six
different spec files stays one cluster. Full detail:
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
they disagree the state line offers the one action that closes the gap, unless the Next line already offers it. See
[Failure clusters](/features/failure-clusters#the-state-line).

### Flakiness score

A test case's **composite score** from two signals — retry passes (weighted 60%) and status alternation
across runs (40%), shown next to its overall failure rate — plus a **root-cause class** (timing, network, assertion,
environment, order, other) and an **impact ranking** in wasted CI minutes. It's a property of the test case,
computed over its execution history, which is why a test needs a few runs of history before it can be
called flaky. See [Flaky tests](/features/flaky-tests).

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
passing run.

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
A flaky, quarantined or skipped test's reach does not count as trusted.

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
They meet at the file: a file's [coverage page](/features/combined-coverage) lists the file's nodes in the Test Map
with their open gaps and opens the [Gaps tab](/features/scenario-gaps) on one, and the Gaps tab's graph links a file or
a route handler to its coverage. Neither fails a build.

### Uncovered change

A changed file of a pull request that no test reached, in the run or the project's last 30 runs, and no suite ran a
changed line of. One rule decides it for the pull-request comment, the gate, MCP and the *changed, unreached* gap; a
file nothing can observe, outside the coverage scope or deleted is counted apart. **Patch coverage** is the same
question by line: the share of the changed lines that ran. See [Uncovered changes](/features/uncovered-changes).

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

The score that ranks gaps: the geometric mean of four factors (how often the files involved change, how old they are,
whether they were part of an earlier escaped failure, and the `piwi:priority` of the tests around them), multiplied by
the detector's confidence. See [Gap detectors & exposure](/reference/gap-detectors#exposure).

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
Test Map knows what a page offers beyond what the tests clicked. Field values are never recorded. Off by default:
turn it on with `capturePageInventory`.

### Map health

How complete a project's Test Map is, per input: the page inventory, the pages of locator calls, route handlers,
probes, the declared surface, change history and the function catalog, each against what it could hold, with the
detectors it wakes. A detector stays silent without its input, so a quiet Gaps tab can mean a map that cannot see; the
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
