---
title: Glossary
description: "Every word the Piwi docs and dashboard use for Playwright results: run, test case, execution, failure cluster, baseline, live runs, analytics, the Test Map and its gaps."
lang: en-US
---

# Glossary

Every word the documentation and the dashboard use, each defined in a few lines with a link to the page that holds its
rule. A word that names two things elsewhere keeps one meaning here, and [Words kept to one meaning](#words-kept-to-one-meaning)
names the others. New to Piwi? [Core concepts](./core-concepts) reads the dozen words a first run meets, with the object
model.

## The object model

How projects, test runs, test cases, executions and failure clusters hold each other:
[Core concepts](./core-concepts#the-object-model).

## Results

### Project

A named container for one suite's results, usually one repository or one suite within it. A project is created the
first time results arrive under a new `projectName`, and carries its own tags, [role grants](#role-and-group), source
control connection, default branch, capability decisions and AI-diagnosis instructions; retention is set for the
whole instance ([Storage & retention](/operate/storage)). Its **status** is the outcome of its latest run, or of its
[status filter](/features/branches#the-project-status)'s.

### Test run

Everything one `npx playwright test` invocation produced: counts, duration, the HTML report, CI and git metadata, and
its [executions](#execution). One CI pipeline's shards make one run ([Sharding](./ci#sharding)), and
a run fills in while it goes ([Live streaming](./reporter#live-streaming)). A run **ran to its end** when it passed,
failed or hit the global timeout; only such runs count in [a project's health](/reference/test-metadata#how-a-result-counts).
A **requested run** is one a person asked for from the dashboard and ran on their own machine
([Run on my machine](/features/run-on-my-machine#a-requested-run-is-yours-alone)).

### Test case

The **identity of a test across time**: its project, file, `describe` path and title. It is created and reused as
results arrive, never submitted, so renaming a test or moving its file makes a new one
([External test IDs](/reference/test-metadata#external-test-ids)). It is browser-independent: `login.spec.ts › signs
in` is one test case on every browser of your matrix. "This test is flaky" is a statement about a test case. What a
**run** of a test is on its pages: [How a result counts](/reference/test-metadata#how-a-result-counts).

### Execution

**One attempt of one test case, in one run, on one browser**: the error, steps, trace, screenshots and the diagnosis
of one failure. A retry is an execution of its own, and so is each `--repeat-each` repetition. The docs also call it a
*test-run case*. "Here is the stack trace" is a statement about an execution. When a test counts as flaky, failed or
**interrupted** in a run, and how every view reads it: [How a result counts](/reference/test-metadata#how-a-result-counts).

### Pass rate

**The share of a test's, a run's or a project's results that passed**, counted over the results that passed or
failed, so skipped tests do not lower it. Every view computes it by one rule, and shows a dash rather than a number
when nothing passed or failed: [How a result counts](/reference/test-metadata#how-a-result-counts).

### Flaky rate

**The share of a test's runs that passed only on a retry**, over the same runs the [pass rate](#pass-rate) counts. A
file's or a directory's flaky rate reads its tests' runs the same way. The [flakiness score](#flakiness-score) and
Flake Lab's rate are other numbers: [How a result counts](/reference/test-metadata#how-a-result-counts).

### Baseline (last green run)

**The earlier run a run is compared with** to answer "what changed?": by default the same project's most recent
passing run, chosen by environment first, then branch. The Changes tab, the regression signals, the CI gate,
pull-request feedback and the AI diagnosis all read it, and so do the environment, visual and page diffs of one
failing execution. Which run it is, and what happens when none passed: [The baseline](/features/run-changes#the-baseline).
The default and base branches it falls back to: [Branches](/features/branches).

### Closest CI pass

**The passing CI execution of the same test a run of the desktop app is compared with**, read on the team instance:
in the run's environment and on its commit first, then in its environment, then on its commit, then any, each on the
same branch first. [Compare with team instance](/features/compare-with-team) lists what differs between their
environments.

### New regression, newly flaky

**What a test did differently from the [baseline](#baseline-last-green-run)**: a **new regression** fails here and
passed there; a **newly flaky** test passed here only on a retry and passed at its first attempt there. Both name a
change between two runs, not its cause: a newly flaky test can be your change or an old flake. How to tell:
[What newly flaky says about your change](/features/run-changes#what-newly-flaky-says-about-your-change).

### Environment

A deployment of the application a project's tests run against (Local, Staging, Production), kept as a record of the
project. A run reports a **label**, the reporter's `environment` option or `PIWI_ENVIRONMENT`, which resolves to an
environment by its key or an alias, ignoring case; a label nothing takes adds a **discovered** one. Filters and
analytics narrow to one, and a run Piwi starts for one gets its run variables: [Environments](/features/environments).

### Default environment

The [environment](#environment) a project's views read when none is picked, as they read its default branch: the
project page and its tabs, Analytics, quarantine candidates and pull-request feedback. A run with no environment counts
only under **All environments**. Unset, every environment counts:
[Default environment](/features/environments#default-environment).

### Deployed environment

An [environment](#environment) a project admin marks as not built from the run's checkout, such as Staging (every
environment is built from the checkout until then): it runs whatever was last deployed there. A run of one tested a **deployed commit**, which its server under test reports or
the environment's latest deploy marker carries. Suspect lines, the Changes tab and the AI diagnosis read the
application's changes between deployed commits: [Deployed environments](/features/deployed-environments).

### Protected environment

An [environment](#environment), Production as a rule, that Piwi starts a run against only for a project admin, after
a confirmation, and only for the tests carrying one of its **required tags** (`@smoke`). It is never picked by default
and never an agent's. A command typed in a terminal stays the person's own:
[Protected environments](/features/environments#protected-environments).

### Run variable

One `NAME=value` environment variable of a **project**, such as the tenant one app serves it as (`TENANT=acme`),
that every run Piwi starts for the project gets and every command it gives to copy starts with. An
[environment](#environment) has run variables of its own, set over the project's on the runs Piwi starts for it. The
names it may set and where it applies: [Run variables](/features/run-variables).

### Environment incident

A **test run** whose failures come from the environment under test being down or broken (staging refusing
connections, a host that does not resolve), not from the tests or the code. Piwi flags it when the run finishes, or a
person marks it, and leaves it out of the analysis that would blame the tests: see
[What a flagged run changes](/features/environment-incidents#what-a-flagged-run-changes).

### Tags & ownership

Two ways to say what a test *is*, both declared in the spec file. **Tags** come from Playwright (`@smoke`); they slice
the test catalog and the flaky leaderboard, and a [CI merge gate](/features/merge-gate) rule can require one.
**Ownership metadata** comes from `piwi:` annotations such as `piwi:owner`: who answers for the test, shown as badges
and carried into pull-request feedback. A test with no owner annotation takes its owner from `CODEOWNERS`. Accepted
values and the fallback: [Test metadata](/reference/test-metadata#test-tags).

## Live runs

The words every tool uses for a run while it goes ([Follow a run](/features/watch-a-run)).

### Run number

**A run's id on the instance it reports to, `#78`, and its page there.** The reporter learns it as the run starts and
tells it to the editor or the desktop app that follows the run, so every tool links the same page
([The run's number and page](/features/watch-a-run#the-run-s-number-and-page)).

### Run name

**The name a run carries before it has a number** (`piwiRunRef` in its metadata): the one its launcher gave it, an
editor's ref or a run request's id, else one Piwi makes up for a run outside CI. A CI run has none: its number names
it. See [Test metadata](/reference/test-metadata#run-origin).

### Worker

**One of the run's Playwright processes, named by its lane, `Worker 2`.** A worker Playwright starts again after a
failure takes the same lane ([Worker lanes](/reference/test-metadata#worker-lanes)).

### Stop

**A test standing at a call, waiting to be answered:** at a breakpoint, after a step, at a Pause, at `page.pause()`,
or at a failure held for a look. Each tool names it by why it stopped, in the same words
([Where a test stopped](/features/watch-a-run#where-a-test-stopped)). A test ended there is skipped
([End the test](/features/end-the-test)). How the test timeout and the dashboard's durations treat the time paused:
[Time paused at a stop](/features/slow-tests#time-paused-at-a-stop).

### CI position

**The call a running test of a CI run is at, in your code:** a plain, read-only mark at the end of its line in the
editors. Never a stop: nothing waits there, and no tool answers it. Which CI runs the editor and Piwi Picker follow:
[A CI run of your branch](/features/editor-ci-runs).

### Hold failures

**Whether a failed test waits at its line for an answer, in one run.** Off, a failure goes on at once, as without
Piwi. Some runs start with it on, any tool that follows a run can turn it on or off, and a run nobody attends never
holds a failure. Which runs, and what a held test keeps: [Hold failures](/features/watch-a-run#hold-failures).

### Presence, driving a stop

**Who else is on a run, and who acts at its stop.** Each tool says which others have the run open, who watches each
worker's page, and who drives a stop. One tool drives a stop at a time, a person or an agent, and a person can take
the stop from an agent. How a stop is taken and given back:
[Who drives a stop](/features/runs-window#who-drives-a-stop).

### Watch, Share live

**Watch** shows a worker's page live, in your editor, Piwi Picker or the desktop app
([Watch a local test](/features/watch-running-test)). **Share live** lets a teammate watch a run on your machine
from its page on the team instance ([Share a local run live](/features/share-live)), where a CI run is watched in the
[live view](/features/live-view), every worker at once with [Watch all](/features/watch-all), and a running page read
as a document with [Inspect](/features/live-inspect). What each sends and keeps is on those pages.

### Trace so far

**A running test's trace up to now, opened in Playwright's trace viewer** on the machine the run runs on, with **Open
the trace so far**. The attempt must be traced. Where the button shows and what it needs:
[Open the trace so far](/features/watch-running-test#open-the-trace-so-far); the desktop app's **Inspect**, which reads
the same trace: [Desktop app runs](/features/desktop-runs#watch).

### Verification

**A test run several times without retries and without the breakpoints, to see how often it passes** (**Verify ×3**
in the editors). It says how many of its repetitions passed (`Passed 3 of 3`, `Failed 1 of 3`) and never holds a failure.
How it counts and what it says: [When your run ends](/features/editor-runs#when-your-run-ends).

## Failures

### Error fingerprint & failure cluster

The **error fingerprint** is a hash of a failed execution's error with what changes from one occurrence to the next
masked out: numbers, ids, URLs, timestamps, an assertion's values. Every failed execution sharing a fingerprint joins
one **failure cluster**, so fifty red tests from one broken endpoint become one cluster you triage once, with a status
(open / resolved / ignored) and a note. What is masked, and when clusters merge:
[How failures are grouped](/features/failure-clusters#how-failures-are-grouped).

### Story

The **one explanation** a failure page leads with when several [clues](/features/evidence#clues) (deterministic,
rule-based findings) form a known combination: *"the Pay button stayed disabled because POST /api/checkout/quote was
still in flight"*, at the strongest member's strength, with every clue folded under it. The combinations, and what
leads instead: [Clue rules](/reference/clues#stories).

### Situation

The **context** of a failing execution, on its page: since when it has been failing and whether a newer execution
failed again or passed, then the cluster it joins, its status and its issue. It also reads, condensed, in
[alerts](/features/notifications). Each line: [Your first failure, explained](./first-failure).

### Next step

The **one recommended action** a failure page leads with, chosen by a policy rather than offered as a menu: apply a
diagnosed patch, replace a broken locator, reproduce locally, re-run in CI, mark a cluster resolved. Every other action
lives in the toolbox. The policy and its order: [Fix plans](/features/fix-plans#the-next-step).

### Cluster state

Where a **failure cluster** stands, in one sentence with one verb next to a colored dot (*still failing*, *stopped
failing*, *regressed*, …). It reconciles the human triage status with what the runs show, and offers the action that
closes a gap between them. Every state and which runs count: [The state line](/features/failure-clusters#the-state-line).

### Flakiness score

A test case's **score** from how often it passed only on a retry and how often its status flips across runs, with a
**root-cause class** and an **impact ranking** by the CI time it wastes. It is a property of the test case, computed
over its history, so a test needs a few runs before it can be called flaky. The weights and the classes:
[Flaky tests](/features/flaky-tests#flaky-test-detection).

### Flake experiment

A `piwi flake` session on one flaky test: a **control arm** with no condition, then one **arm** per suspect, each
applying the suspect's condition (a delayed route, another test alongside) with retries off. An arm **reproduced** the
flake when it fails, with the test's own error, significantly more often than the control; a **verify** experiment reruns
that arm after a fix. The verdicts: [Flake Lab](/features/flake-lab#reading-the-verdict).

### Fix attempt

A change a person or an agent reports having made to fix a failure cluster (a patch, a locator edit, a fix plan
carried out), on a commit or a branch. It is recorded **applied**, then **verified** when the cluster's tests pass on a
run that carries it, or **regressed** when the cluster fails again. See
[Agent skills](/features/agent-skills#what-agents-report-back).

### Locator snapshot

What an element looked like when a locator call on it succeeded (role, accessible name, test id, structural anchors),
recorded by the [capture fixtures](./capture-fixtures) and keyed by the **call site** (`file:line`) rather than the
selector text. When that locator later fails, its snapshots are what Piwi ranks replacement locators from. See
[Locator healing](/features/locator-healing#what-it-does).

## Analytics

### Metric, dashboard and quality report

A **metric** is a named number with one definition every surface reads ([Analytics](/features/analytics)). An
**analytics dashboard** is a named arrangement of widgets with a default scope ([Dashboards](/features/dashboards)); *the dashboard* alone means the Piwi web app. A **quality report**
is an analytics dashboard rendered as a document, not the run's Playwright **run report**; a **report schedule** sends
it on a cadence, and each one sent is kept as a **report snapshot** ([Quality reports](/features/quality-reports)).

## Test Map

The **Test Map** is one graph per project of what the application exposes (pages, controls, links, routes, the
handlers and dependencies behind them) and which tests reach each of them. See
[Scenario gaps & the Test Map](/features/scenario-gaps).

### Reach

A test **reaches** a route, a page, a control or a link when a run observes it doing so: a request to the route, a
locator call on the page, a locator that names the control. Triage can record reach too. The route and page gaps are
read from observed reach; the code detectors read coverage. Only a trusted test's reach counts in full. The rules:
[Gap detectors & exposure](/reference/gap-detectors#detectors).

### Feature and hub

A **feature** is a product area named by the [`piwi:feature` tag](/reference/test-metadata) on tests. It groups what
those tests reach, and what they miss nearby. A **hub** is a node most tests reach, such as a session route: it belongs
to no one feature. See [how features group](/reference/gap-detectors#features).

### Code reach

The application source files a test executed, in the page from Chromium's JavaScript coverage with
[code reach](/features/code-reach) on, in the backend with [server coverage](/features/server-coverage) on: observed
reach at file level, never line coverage. It feeds [impact-from-diff](/features/change-impact) and
[Uncovered changes](/features/uncovered-changes).

### Coverage

Which source code a test ran, per file and **runtime** (`browser` or `server`), at a **granularity**: the files only,
the functions that ran, or the executed lines too. [Code reach](#code-reach) is its file-level view. A test's coverage
is **incomplete** when part of it could not be collected. The granularities and their cost:
[Coverage cost](/reference/coverage-cost).

### Coverage report and suite

A **coverage report** is one tool's coverage of one suite's whole run at one commit, attributed to no test. A
**suite** is the tests a report comes from, named when uploading (`unit-back`), of kind `unit` or `e2e`; not
Playwright's `describe` block. The **coverage scope** decides which files a project's coverage counts. See
[Combined coverage](/features/combined-coverage).

### Coverage and the Test Map

Two answers to "what do the tests miss". **Coverage** measures the code: which lines and functions ran, as a ratio;
the lines no test or suite ran are **lines not run**. The **Test Map** measures the application: which routes, pages
and controls the tests reach; what they miss becomes a [scenario gap](#scenario-gap), never a percentage. They meet on
the project's [Coverage tab](/features/scenario-gaps#the-coverage-tab) and on a
[file's coverage page](/features/code-reach#which-tests-run-a-file).

### Uncovered change

A changed file of a pull request that no test reached and no suite ran a changed line of. One rule decides it for the
pull-request comment, the gate, MCP and the *changed, unreached* gap. **Patch coverage** is the same question by line:
the share of the changed lines that ran. See
[Uncovered changes](/features/uncovered-changes#one-rule-for-every-changed-file).

### Reusable result

A test result whose code had already passed unchanged: an earlier pass of the same test ran the same file versions, so
the run could have kept that pass instead. A reusable result that failed came from the test, its data or its
environment. See [Reuse forecast](/features/reuse-forecast#what-counts-as-reusable).

### Suspect lines

The lines changed since a failing test's last passing run that the failing tests executed, read from their
[coverage](#coverage), ranked by how few passing tests executed them too. The failure pages, the cluster's diff, the
AI diagnosis and the fix plan name them. How they are ranked:
[Suspect lines](/features/server-coverage#suspect-lines).

### Locator index

The locator chains each test used in its steps, recorded per branch and per Playwright project. It answers which tests
use a locator, and it feeds [Who uses a locator](/features/locator-usage) and
[Tested elements](/features/tested-elements).

### Locator break

A locator of the index that a change stops matching: the diff removes or renames a string one of its calls finds the
element by. [Locator preflight](/features/preflight) lists them, *likely* or *possible*.

### Page key

A page's URL reduced to its path pattern, ids replaced by placeholders: `/orders/123?tab=items` and `/orders/456` are
both `/orders/:id`, on staging and in production alike. The Test Map's page nodes, the page each locator was used on
and Piwi Picker's **This page** all use it. The rules: [What the graph includes](/reference/gap-detectors#what-the-graph-includes);
Piwi Picker's path prefixes: [URL patterns](/features/extension-connection#url-patterns).

### Brittle locator

A locator a test uses that breaks on a change unrelated to what the test checks: a position, a styling class, the
document structure, a generated id. Piwi judges each locator of the index *brittle*, *watch* or *stable*; see
[Locator stability rules](/reference/locator-stability). Not to be confused with the *fragile*
[gap class](#gap-class), which is about the tests reaching a node, not a locator.

### Scenario gap

A test the suite does not have yet, proposed from the Test Map with its evidence and a next step: a route no test
reaches, a control nobody exercises, a changed file no test reaches. A gap is triaged like a failure cluster: accept
it, snooze it, dismiss it with a reason, or mark it covered by an existing test ([Triage](/features/scenario-gaps#triage)).

### Gap class

How serious a gap is: **blind-spot** (nothing exercises it), **false-comfort** (the tests pass without checking it)
or **fragile** (what reaches it could stop at any time). Server probes report **findings** instead, **unhandled** or
**degraded**. What each class covers: [Detectors](/reference/gap-detectors#detectors).

### Detector

A rule that reads the Test Map and the run history and reports one kind of gap, such as *declared, never hit* or
*single covering test*. Each gap names the detector that raised it; [Gap detectors & exposure](/reference/gap-detectors)
lists them all.

### Exposure

How much a gap's node matters, from how often its files change and for how long, whether they were part of an earlier escaped
failure, and the priority of the tests that reach it. A gap's score, which ranks it, is its exposure times the
detector's confidence. The factors: [Exposure](/reference/gap-detectors#exposure).

### Probe

A re-run of a passing test with one injected fault (a 500, an empty body, a dropped field, a slow response),
recording whether the test noticed. A client probe injects the fault at the Playwright boundary; a server probe asks
the [backend instrumentation](./backend-logs#server-probes) to inject it inside the server. A **probe run** is marked
as one ([What a probe run never counts](/features/probes#what-a-probe-run-never-counts)).

### Declared surface

The routes and pages the application says it has, from the instrumentation's route manifest, a committed
`piwi.manifest.json` or an OpenAPI document, as opposed to the ones tests reached. A declared route nothing reaches
is a *declared, never hit* gap ([Declared surface](/features/scenario-gaps#declared-surface)).

### Page inventory

The controls (role and accessible name) and links the reporter records on the pages a passing run visits, so the Test
Map knows what a page offers beyond what the tests clicked. Off by default: turn it on with `capturePageInventory`.
What it reads and keeps: [What the graph includes](/reference/gap-detectors#what-the-graph-includes).

### Map health

How complete a project's Test Map is, per input (the page inventory, route handlers, probes, the declared surface,
change history…), with the detectors each input wakes. A quiet Gaps view can mean a map that cannot see; the panel
names the step behind each input that is short ([Map health](/features/scenario-gaps#map-health)).

### URL pattern

A glob over a page's whole address that ties the pages of a site to a project, with an optional environment and
branch. Each project keeps its own list, and the browser extension reads them to know which project the page it is
on belongs to. See [Extension connection](/features/extension-connection#url-patterns).

## Access

### Role and group

With [authentication](/operate/authentication) on, every account holds an **instance role**, **Administrator** or
**Member**. A Member's rights in a project come from the **project roles** they hold there, granted on one project or
on all of them. A **group** is a named set of users that receives project roles the way a user does. See
[Access, roles and groups](/operate/project-access).

### Credential

**A secret Piwi sends to another service, saved once and named by id wherever it is needed**: a user, the secret, the
destination (the base URL it may be sent under) and the projects that may use it. A CI server action, source control,
an AI role, a Jira or Zephyr Scale connection and a Slack channel of the instance name one; every use is checked against
it and logged. See [Credentials](/operate/credentials).

## Words kept to one meaning

Some words name two things across the docs, the dashboard and the tools. Each keeps the meaning in the middle column
on these pages; the others take the name on the right, or are told apart by the place they are in.

| Word | Means | The other senses |
|---|---|---|
| stop | A test standing at a call ([Stop](#stop)) | **Stop**, in bold, is a button's label: it ends a run, a recording or an answer |
| share | **Share live**: a teammate watches a run on your machine | **Share with Playwright tools** binds a stopped test's browser for Playwright's tools; a [share link](/features/share-links) is a signed read-only link |
| On your machine | A run on a developer's machine: the run page's card for a desktop run and the mark of a [requested run](#test-run) | none |
| run | A [test run](#test-run) | A test's result in a run is a *run of a test* ([How a result counts](/reference/test-metadata#how-a-result-counts)); one of the times Flake Lab or a verification runs a test is a *repetition* |
| environment | A deployment a project's tests run against, a record of the project, which a run's *label* names ([Environment](#environment)) | The variables of a process are its *environment variables*, and the ones Piwi sets are [run variables](#run-variable); an *environment incident* is a run whose environment under test was down ([incident](#environment-incident)); the machine a run executed on is its [run environment](/features/run-environment); the flaky class `environment` means one browser, or one runner time zone or locale, fails |
| wasted | [Wasted time](/features/slow-tests#wasted-time): waits plus failed attempts, as Analytics counts it | The flaky list's *wasted CI minutes* of one test are its retry passes times its average failed attempt |
| coverage, reach | [Coverage](#coverage): the code a test ran; [reach](#reach): what a run observed a test touch | [Code reach](#code-reach) is coverage at file level; *Uncovered changes* and the **Coverage** tab keep their names |
| diverged | The dashboard's verdict for a replay that could not play a step | Piwi Picker says *Could not reach the bug*, or *Stopped at step N: the page went another way* for a recording that marks nothing wrong ([Replay a recording](/features/replay-a-bug-report)) |
| picker | **Piwi Picker**, always with its name, is the browser extension | A tool that turns a click into locators is named by where it works: the dashboard's *snapshot picker* (**Pick from snapshot**, **Open in picker**), the trace viewer's *Pick locator*, the *failure-time picker* in a local run's browser |
| dashboard | The web app a Piwi instance serves | A saved set of Analytics widgets is an [analytics dashboard](/features/dashboards); a hosting provider's web console is its *console* |
| report | Always with its kind | *quality report*, *HTML report* of a run, *offline export*, *bug report*, Playwright's *blob report* |
| test case | A test's identity across time ([Test case](#test-case)) | One attempt of it is an [execution](#execution) |
| project | A Piwi [project](#project), named by the reporter's `projectName` | A *Playwright project* (a `projects` entry of the config, whose name the `browser` field records) is always called so; the reader's code is their *repository* |
| integration | A *backend integration*: an instrumentation package in the app under test ([Backend instrumentation](./backend-logs)) | **Settings → Integrations** holds the *connections* to [Jira Cloud](/operate/integrations) and [Zephyr Scale Cloud](/operate/zephyr-scale); **Integrations** is also the group of a project's Settings that binds those connections and CI |
| baseline | The run a run is compared with ([Baseline](#baseline-last-green-run)) | A visual snapshot, a pinned commit or a starting value is named by what it is |
| exposure | How much a gap's node matters ([Exposure](#exposure)) | none |
| finding | Always with its kind: a *resilience finding* (the app did not cope with a server probe), a *leak finding* | A [clue](/features/evidence#clues) is a rule-based finding about one failure |
| verified | Always with its noun: *diagnosis verified*, *verified fixed*, a *verified* fix attempt, a [verification](#verification) | none |
| class | Always with its kind: the flaky *root-cause class*, the [gap class](#gap-class) | none |
| Performance, Timeline | A tab or a page, named by its place: **Project → Performance**, **Settings → Performance**, a run's **Timeline** tab | [Timeline markers](/features/timeline-markers) are the events drawn on the trend charts |

## Where each concept lives in the UI

The page and URL of each object of the model: [Core concepts](./core-concepts#where-each-concept-lives-in-the-ui).

## Related
- [Core concepts](./core-concepts) — the words a first run meets
- [Getting started](./getting-started) — get results flowing in
- [UI overview](/features/ui-overview) — a map of every page
- [Reporter](./reporter) — how each of these objects gets populated
