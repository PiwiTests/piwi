# Finding the missing tests: an audit of coverage, the Test Map and scenario gaps

An audit of how Piwi finds the tests a suite is missing, the fourth thing Piwi is for ([`ROADMAP.md`](../ROADMAP.md),
*What Piwi is for*). It covers code coverage (capture, combination, the views), the Test Map and its scenario gaps
(graph, detectors, ranking, triage), probes, uncovered changes and patch coverage at pull-request time, and the
surfaces that hand a gap to a person or an agent. It records what each part finds today and where it goes wrong,
finding by finding with the file behind each. It compares the ways a missing test can be found, says which of them
Piwi should lean on and how to measure which work, and ranks the changes by what they buy. Test writing (the
recorder, the quality of a draft), debugging (suspect lines, coverage divergence) and running (test selection, run
control) are out of scope; they appear only where they feed or consume the signals.

**Status.** Proposed 2026-10-31, against `main` at v0.63.0 (`2bd05d42`). The quick wins of §10 are built, some in
part. A pull request that builds more of §10 updates this paragraph.

- **Built:** S2 to S4, S6, S9 and S13.
- **S1, in part.** *Success only* no longer counts a GET page load, so a page never reads as a route without its
  error path. A page load still reaches the route of its URL, since a backend can serve a declared route by
  navigation (open question 1). So *single covering test* can still raise a page and its route, and the probe plan
  still holds pairs whose route a test only loaded.
- **S5, in part.** Verdicts count by their reason, and a muted detector's gaps list last in the Gaps tab and MCP and
  leave the feature map and graph. *Covered by* is still one verb (open question 2).
- **S8, in part.** An OpenAPI document's paths sit under its server path, and a route a later read no longer finds
  stops being declared. Requests to the project's other origins are still dropped (TM-5).
- **S10, in part.**
  - Built: `--last-failed`, `--only-changed`, `--test-list` and command-line `--grep` runs are partial. A target line
    reads its innermost function. Build output and generated sources leave the default scope.
  - Left: `--project` and `--max-failures` runs still count as complete, and carry-forward is still by suite (CV-1).
- **S11, in part.**
  - Built: the comment goes to the pull request the run names, when the CI runs in the repository Piwi posts to, and
    *Only comment on failures* keeps the comment of a green run whose change left a file no test reached.
  - Left: statuses still go to the run's commit, and the projects of one repository still share one comment and one
    status context (CT-3).
- **S12, in part.** A finding's exposure shows its reach. A feature is still colored by its worst class.
- **Not built:** S7. The docs say which ids collapse in a key ([`gap-detectors.md`](../apps/docs/reference/gap-detectors.md)).

The medium items and the programs are not started.

**Summary.** Piwi already stores most of what finding a missing test needs: per-test server lines, browser functions
and CSS rules, the routes, pages and controls every test reaches, a declared surface, probe outcomes, the diff of
every pull request, and the failures that escaped. Ten findings lead (§0):

- **No reference by default.** On a default install the map has almost nothing to compare reach against, so blind
  spots stay invisible.
- **A flat ranking.** The score that orders gaps barely varies, so the list is ordered by detector type, not by what
  matters.
- **Noise from ingest.** Ingest adds noise the demo never shows: page loads become routes, the run window mixes
  branches, volatile ids become nodes, and a flaky label never expires.
- **The pull request missed.** The pull-request path, the method with the strongest evidence behind it, misses the
  pull request on GitHub's common setups.
- **Coverage unused.** Coverage, the richest data, never becomes a gap outside the pull request.
- **Coverage too kind.** Its numbers can read better than the truth: narrowed runs, partial uploads and long-lived
  backends all raise them.
- **Probes measure the wrong thing.** The one check of whether a test would notice mostly measures timeouts and the
  first request.
- **Detectors that never run.** Seven designed detectors never run.
- **No measurement.** Nothing measures whether a gap was real or acted on.
- **No next step.** A gap rarely arrives with its next step.

§3 answers the question this audit was asked, how best to find what tests are missing: what each method finds and
misses, which ones the evidence supports, and how Piwi can measure which work on a team's own data. §10 ranks 28
changes:

- **13 quick wins** that make the existing gaps true;
- **10 medium items** that make the pull request the reference, turn escapes and coverage into gaps, and measure
  outcomes;
- **5 programs** that widen the reference.

This document is written for the maintainers. The design records behind this area are careful and well sourced:
[`coverage-and-the-test-map.md`](../adr/coverage-and-the-test-map.md), [`scenario-gaps.md`](../adr/scenario-gaps.md),
[`unified-code-coverage.md`](unified-code-coverage.md),
[`combined-code-coverage.md`](../adr/combined-code-coverage.md) and [`test-map-accuracy.md`](test-map-accuracy.md).
Most findings below are places where the built code parts from them, or where an input the design assumed is empty on
a real project.

Every finding carries a file reference. Two markers say how a finding was confirmed; a finding with neither was read
in the code:

- **(seen)**: observed first-hand on a seeded instance (`npm run app:seed:dev`, the dev server, the web-dashboard demo
  project).
- **(run)**: reproduced during the audit by running the real code on a scenario (Vitest on a temporary SQLite
  database, or the reporter in Chromium).

Paths under `shared/`, `server/` and `app/` are in `apps/application/`; `S:n` is line n of
`apps/application/shared/handlers/scenario-gaps.ts`.

One name per concept. The terms of [`coverage-and-the-test-map.md`](../adr/coverage-and-the-test-map.md) keep their
meaning:

- **gap**: a test to write, proposed by a **detector**;
- **lines not run**: executable lines no test or suite ran;
- **uncovered change**: a counted changed file no test reached;
- **patch coverage**: the share of a diff's changed lines that ran.

This audit adds two terms:

- the **reference**: what the application can do, as some source declares or shows it (the denominator a blind spot
  is measured against);
- a **finder**: any method that proposes a missing test, a detector or otherwise.

## 0. The ten findings that matter most

1. **On a default install the map has almost nothing to compare reach against, so it cannot see what no test
   touches.** A blind spot is the reference minus reach, and a default install records reach almost alone:
   - the page inventory is off by default (`packages/reporter/src/internal/config/env.ts:23`), and so is code reach
     (`:25`);
   - the declared surface needs an OpenAPI URL, a committed manifest, or a Nitro or ASP.NET Core backend;
   - no front-end router's route list is read;
   - the file conventions behind uncovered changes know only Nitro and Nuxt (`packages/core/src/file-routes.ts:67`,
     `:90`).

   A default project therefore gets mostly *fragile* and *success only* gaps, about what the tests already reach. The
   blind-spot detectors that find untested surface (*control nobody exercises*, *reachable, unvisited*, *declared,
   never hit*) stay silent until a team turns the inventory on and declares its surface. Map health names those
   steps, but nothing reads the routes a framework already declares: a router's pages, or a server's route table
   outside Nitro and ASP.NET Core.

2. **Gaps are ranked by detector, not by exposure.** On the demo, 82 of 95 open gaps have all four exposure factors
   at the 0.1 floor, and the 95 gaps share 17 scores. The order is the detectors' confidence constants: *Delete
   organization* and *Transfer ownership*, which no test exercises, rank 89th and 82nd, below *GET /api/roles: no
   error path under test* **(seen)**. Three factors carry no signal:
   - **usage**, the ADR's first factor, has no code: `graph_nodes.usage_30d` is always null
     (`server/database/schema.sqlite.ts:1926`);
   - **age** is never computed outside the pull-request path, and caps near 0.25 there;
   - **priority** comes only from tests that reach the node itself, so it sits at the floor on every node no test
     reaches, which is every blind spot (S:181-224).

   Map health reports the inputs that feed the ranking as complete while the ranking stays flat **(seen)**.

3. **Ingest adds noise faster than the detectors remove it, and the benchmark cannot see it.**
   - **Page loads become routes.** `document` is a tracked request type
     (`packages/reporter/src/internal/capture/capture-fixtures.ts:3312`, `server/utils/graph-ingest.ts:130`), so every
     page reads *GET /settings: no error path under test*.
   - **The window mixes branches.** The 30-run evidence window takes runs of every branch (S:1459): one pull-request
     run erases surface drift, and one 500 from a broken branch closes a *success only* gap **(run)**.
   - **Flaky is forever.** A test classified flaky once is untrusted for good (`shared/handlers/flaky-classify.ts:53`,
     S:1522).
   - **Volatile ids become nodes.** Mongo ObjectIds, cuids and nanoids are not collapsed in keys, so every entity is a
     node with its own gap (`packages/core/src/page-key.ts:28-39`) **(run)**.
   - **Removed surface never retires.** A node backing an open gap is never pruned
     (`server/utils/graph-ingest.ts:970-985`) **(run)**.

   The labeled benchmark seeds the graph rows directly (`shared/demo/demo-test-map.mjs:980-1080`), so none of this can
   move its scores.

4. **On GitHub, uncovered changes miss the pull request they are about.**
   - **Under `on: [push]`, the comment loses earlier pushes.** The CI guide's workflow runs on push
     (`apps/docs/guide/ci.md:25`). A push run carries no pull-request number
     (`packages/reporter/src/internal/collect/metadata-collector.ts:84-94`), so it is diffed against the branch's last
     green run, not the pull request's base (`server/utils/scm/change-coverage.ts:270-287`). An uncovered change an
     earlier push flagged drops out of the comment.
   - **Under `pull_request`, statuses go to the wrong commit.** Piwi records the synthetic merge commit
     (`metadata-collector.ts:289`), so its statuses land where the pull request does not show them, and a fork's pull
     request gets no comment.
   - **In a monorepo, projects collide.** Every project reads every changed file through conventions that match any
     `server/api` segment, and the projects overwrite one comment **(run)**.

   The method with the strongest evidence behind it is the one whose plumbing is weakest.

5. **Coverage never becomes a missing test outside the pull request.** Piwi records per-test server lines, browser
   functions and CSS rules, and combines them with unit suites per commit. Yet:
   - **No detector reads coverage**: S:1908-1925 excludes it.
   - **None of the unified study's code-level detectors is built**: *code nobody executes*, *error path never
     executed*, *branch never taken*, *single covering test* by function
     ([`unified-code-coverage.md`](unified-code-coverage.md), part 6.3).
   - **The Coverage page ranks by size, not risk.** It orders files by how many lines no suite ran
     (`shared/coverage-combine.ts:425-444`), with no churn and no link from a range to a gap or a draft. A front-end
     file with two of its three functions never run sorts last **(run)**.

6. **Coverage numbers can be wrong in the comfortable direction.**
   - **Narrowed runs count as full.** Runs narrowed by `--last-failed`, `--only-changed`, `--project` or
     `--max-failures` count as full runs (`packages/reporter/src/public/reporter.ts:337-352`).
   - **A partial upload raises the ratio.** A partial unit upload raises the commit's ratio and moves its untested
     files to *without data*. The warning the ADR promises when a suite's file count drops is not built
     (`adr/combined-code-coverage.md:383`) **(run)**.
   - **A long-lived backend over-counts.** A backend's run-level coverage adds up everything the process ran since it
     started (`integrations/nitro/src/coverage-runtime.ts:415-420`).
   - **Scheduled browser coverage is lost.** The browser functions a scheduled run records never reach a commit that
     already has end-to-end coverage (`server/utils/coverage-totals.ts:421`), the very setup the docs recommend.
   - **The skill's reach check is fooled by nesting.** It asks whether a new test reached its target lines, and
     answers yes for a nested callback that never ran (`shared/coverage-insights.ts:1147-1170`) **(run)**.

7. **Probes, the one measure of whether a test would notice, mostly measure something else.**
   - **`slow` measures the timeout.** The `slow` fault delays a response by exactly Playwright's default expect
     timeout (`packages/reporter/src/internal/probe/faults.ts:43`), so its outcome reflects the project's timeout, not
     its assertions **(run)**.
   - **Faults hit one request.** Every fault hits only the first matching request (`shared/handlers/probes.ts:151`), so
     a test that checks the list reloaded after a create still passes.
   - **`stale-value` never applies.**
   - **Server faults always read as degraded**, because the injected 500 counts as a backend error
     (`packages/reporter/src/internal/probe/mode.ts:92-96`) **(run)**.
   - **An inconclusive re-probe closes a *not noticed* gap** (`shared/handlers/probes.ts:718-752`) **(run)**.

   On a simulated 200-test suite, 64% of probes never apply, and only after 83 nights does every route have an outcome
   **(run)**. Nothing schedules `piwi probe`, and nothing shows its yield.

8. **Seven designed detectors never run, and the inputs of the cheapest are already in hand.**
   - *Intent without a test* and *new error path* need the commit messages and patches that `computeRunChangeCoverage`
     already fetches, then reduces to ticket ids and line numbers (`server/utils/scm/change-coverage.ts:245-256`).
   - *Phantom coverage* and *matrix* need columns that exist.
   - *Incidental catch* needs a cluster's fixing commit, which is stored.

   They are pure functions (S:791, 836, 969, 1060, 1325, 1357, 1379) that only tests call. So are the `triggers`
   edges that [`scenario-gaps.md`](../adr/scenario-gaps.md) lists as shipped (`shared/graph.ts:500`).

9. **Nothing measures whether a gap was real or acted on, so no one can tell which finder works.** None of the
   measures that would say so is built: the M1 success measure (uncovered changes that gain a test in the same pull
   request), *uncovered changes acted on*, escape lift and leave-one-test-out recall. The precision loop counts the
   wrong things:
   - a dismissal without a reason counts as *wrong* (S:3861);
   - *Covered by*, which can mean a test already existed, counts *for* the detector
     (`shared/handlers/detector-precision.ts:95-97`);
   - *covered elsewhere* counts for nothing;
   - verdicts never decay, and MCP ignores muting.

   The Home queue drops every accepted gap whose subject any test reaches (S:3975-3995). That is every accepted
   *success only*, *single covering test*, *assertion-light* and *not noticed* gap **(run)**. Accepted change gaps
   never close.

10. **A gap rarely arrives with its next step.**
    - **The comment's draft is a fixed string.** The pull-request comment's "draft" is the text *a scenario that
      exercises \<file\>*, with no link (`server/utils/scm/change-coverage.ts:259-262`).
    - **File gaps get an empty draft.** The draft of a file gap is an empty skeleton (S:4166, S:4206-4235) **(run)**.
    - **The status links nowhere useful.** The commit status links to a run page that shows no uncovered changes.
    - **The gate names no files.** It warns with a count, and stores nothing.
    - **Other surfaces stop short of an action.** The digest and the widgets link only to the Gaps tab, the editors'
      uncovered-change lens has no command, and the extension's Tested elements overlay offers only Copy locator.
    - **No gap has an owner.** CODEOWNERS never writes the `owns` edges the map was designed for.

## 1. Method

- **Records and docs.** The design records named above, [`test-selection.md`](test-selection.md) for the reach it
  shares, and the user docs:
  - the eight pages of the *Find what your tests miss* catalog group;
  - [`gap-detectors.md`](../apps/docs/reference/gap-detectors.md) and
    [`coverage-cost.md`](../apps/docs/reference/coverage-cost.md);
  - [`pr-feedback.md`](../apps/docs/features/pr-feedback.md),
    [`editor-coverage.md`](../apps/docs/features/editor-coverage.md) and [`ci.md`](../apps/docs/guide/ci.md).
- **Code.** Four independent readings, each given its files, the records and the questions, never the expected
  findings:
  - **The Test Map:** ingest, keys, the non-probe detectors, exposure, triage, the declared surface, the benchmark.
  - **Probes:** plan, interception, outcomes, the detectors they feed, the Nitro and ASP.NET Core faults.
  - **Code coverage:** capture, collection, upload, combination, the views.
  - **Change time and delivery:** change reach, the comment, statuses, the gate, MCP, the skills, the editors, the
    extension, the digest.

  Each finding of §0 was checked again against the code.
- **A seeded instance (seen).** The web-dashboard demo project (10 tests, 120 nodes, 95 open gaps), read through:
  - the Gaps tab, the feature map and map health;
  - the Coverage page;
  - the gaps, map health and precision endpoints.
- **Scenarios (run).** About forty throwaway scenarios:
  - calling the real detectors, change reach, the probe ledger, coverage combination and the Home queue on temporary
    SQLite databases;
  - the reporter's probe interception in Chromium;
  - one 90-night simulation of the probe planner.

  The area's own tests that were run all pass: the app's Test Map, probe, coverage and change-coverage unit tests, the
  reporter's probe specs and the Nitro integration's tests.
- **Not done.**
  - No real customer project.
  - The ASP.NET Core packages were read, not run: no .NET SDK in the audit's container.
  - GitHub's `pull_request` behavior is taken from its documentation, not a live repository.

## 2. How Piwi finds a missing test today

### 2.1 The signals, and what turns each on

| Signal | Feeds | Needs | Default |
|---|---|---|---|
| Requests and page visits per test | route and page nodes; *success only*, *single covering test*, *surface drift*, *orphan test* | the capture fixtures | on |
| Locator index (calls and matchers) | control reach; *assertion-light*, *catalog method, no test calls* | the fixtures | on |
| Page inventory | control and link nodes; *control nobody exercises*, *reachable, unvisited* | `capturePageInventory: true` | **off** |
| Console errors, backend logs, background 5xx | *passed with errors* | the fixtures; backend logs for server errors | on |
| Server spans and the route manifest | handler and dependency nodes, the backend's declared routes; *unprobed dependency*; churn of route gaps | the Nitro or ASP.NET Core package | off |
| Declared surface | *declared, never hit*; documented codes for *success only* | an OpenAPI URL, `piwi.manifest.json` or the backend manifest | off |
| Function catalog | *catalog method, no test calls* | functions registered by hand, by AI or through MCP | empty |
| Bug reports, regressed fixes | *escaped defect*, *fix did not hold* | Piwi Picker reports; fix verification | when present |
| Probes | `checks` edges; *not noticed*, *unprobed dependency*, *not handled* | a scheduled `piwi probe` job the team writes; server probes need a secret on both sides and a flag | off |
| A run's diff | *changed, unreached*; the comment's uncovered changes; churn and escapes | an SCM token (or a public repository), PR feedback on, `PIWI_SITE_URL` | off |
| Code reach (browser files or functions), CSS rules | change reach; the coverage views | `coverage.browser`, `coverage.css`; Chromium | off |
| Server coverage per test | coverage views; change reach; patch coverage | a coverage build of a Nitro or ASP.NET Core backend; `coverage.server` | off |
| Unit coverage uploads | combined coverage; patch coverage; changed lines not run | `piwi coverage upload` per suite and commit | off |

What each setup adds, from the default:

- **Fixtures only.** *Success only*, *single covering test*, *surface drift* and *orphan test* over routes and pages;
  *passed with errors*; *assertion-light*; *fix did not hold*; *escaped defect* for Piwi Picker reports. The only
  blind spot this level can raise is a new route or page no test reached (*surface drift*).
- **With an SCM token and PR feedback.** Uncovered changes and *changed, unreached*, for files the Nitro and Nuxt
  conventions, a locator call site or a spec map to a test. Everything else is *not counted*.
- **With the inventory, a declared surface, a backend package, probes or coverage.** Each wakes the detectors its row
  names.

### 2.2 Four journeys

**A developer opens a pull request.** With an SCM token, PR feedback and `PIWI_SITE_URL` set, the comment gains an
*Uncovered changes* section. It lists:

- up to ten changed files no test reached, each with "0 tests in 30 runs" and a fixed "draft" phrase;
- with combined coverage, the patch coverage and the changed lines no suite ran;
- a *Not counted* line.

A `piwi/tests/change-coverage` status says "N of M changed files no test reached". Nothing links to a gap, a draft or
a page that lists them (§8). The section depends on the trigger and on how the files are laid out (§7):

- **`on: [push]`**: the section describes the changes since the last green push.
- **`pull_request`**: the status lands on the merge commit.
- **Outside Nitro and Nuxt layouts**: most files are not counted.

**A lead asks what the suite does not test.** The Gaps tab opens on the feature map: four circles, all red, because
each feature has at least one gap of the most severe class **(seen)**. The list below starts with *Ungrouped*. Each
row shows:

- class and detector;
- a title, evidence and a score;
- four factors, almost all `0.1`;
- the verbs: Accept, Snooze, Covered by, Dismiss.

The tab loads the top 200 gaps (`app/components/gaps/GapsPanel.vue:65`); since the score is flat, these are the top
200 by detector type. Map health underneath says six of seven inputs are complete **(seen)**.

**An agent is asked to write the missing test.** The `write-the-missing-test` skill:

1. starts from `get_change_coverage` or `list_scenario_gaps`;
2. drafts with `draft_scenario`;
3. checks the new test with the coverage reach of its target lines;
4. accepts the gap.

Three of those steps fall short:

- `list_scenario_gaps` ignores muting and has no detector filter.
- The draft of a file gap is empty.
- The reach check passes a nested function that never ran.

**A team reads its coverage.** The Coverage page shows:

- the commit's line and function ratios, by suite and area;
- a file tree, with *Least covered here* by count of lines no suite ran;
- a file page with the lines not run, range stepping, the nearest test, and the file's Test Map nodes.

Nothing ranks by risk, and no range can become a gap or a draft **(seen)**.

## 3. The ways to find a missing test, compared

This section answers the question the audit was asked.

### 3.1 What finding one takes

A missing test is behavior that matters and that no test would fail on if it broke. Every finder, in Piwi or
elsewhere, fills five columns:

| Column | Question | Sources |
|---|---|---|
| **Reference** | What can the application do? | code (executable lines, branches, functions); declared interfaces (a framework's route table, OpenAPI, a front-end router); the rendered UI (controls, links, states); intents (tickets, acceptance criteria, commit messages); production use; the diff; past escapes |
| **Reach** | What do the tests make it do? | requests, page visits, locator calls, per-test coverage |
| **Check** | Would a test fail if it broke? | assertions, probes, mutants, misbehavior a passing test ignored |
| **Value** | How much does it matter? | use, churn, age, escapes, priority |
| **Trust** | Can the tests that reach it be relied on? | flaky, quarantined, skipped, alone |

The three gap classes are differences between those columns:

- a **blind spot** is the reference minus reach;
- **false comfort** is reach minus check;
- **fragile** is reach by untrusted tests alone.

The value column orders them. **No finder can raise a blind spot outside its reference**, so the reference is the
ceiling on what any finder built on it can find. It is also where the finders differ most, and where Piwi's default
install is thinnest (finding 1).

### 3.2 Finder by finder

| Finder | Finds | Misses, or wrong when | In Piwi today |
|---|---|---|---|
| **Code: lines and functions not run**, whole suite | code no suite executes, against a real denominator | behavior with no code yet (a missing validation); code executed but unchecked; wrong after partial runs and on shared backends | built for display (Coverage page, `leastCovered`); no gap, no ranking by churn |
| **Code: per-test coverage** (code nobody executes, error path never executed, branch never taken, single covering test by function, incidental execution) | untested error handling, fragile code, code only another feature's tests run | needs per-test capture (Nitro, ASP.NET Core, Chromium) | data captured; no detector |
| **The diff: uncovered changes, patch coverage** | changed code no test reaches or runs, at the moment someone can act | a deletion-only change; code reached but unchecked; files Piwi cannot observe | built: files by convention, lines with coverage (§7) |
| **The diff: new error path, new control, intent without a test** | a new status, field or behavior no test names | intent worded differently from the tests; template syntax it cannot parse | pure functions, never run |
| **Declared interfaces: never hit** (OpenAPI, route manifests) | endpoints no test calls | pages (no router manifest is read); an API on another origin; a base path | built; needs a declared source (§4.6) |
| **Declared interfaces: error codes** (*success only*) | routes whose error responses no test produces | errors tested at unit or API level; GraphQL, whose errors return 200 | built; noisy on page loads (§4.2) |
| **Rendered UI: controls and links** (inventory against the locator index) | buttons, fields, tabs and links no test operates or follows | states the inventory never sees (dialogs, empty lists); suites built on test ids; locales | built; off by default |
| **Rendered UI: a person or an agent exploring** | surface no capture records: dialogs, menus, data states | needs a person, or a budgeted agent | the extension shows untested elements; nothing writes surface back |
| **Intent: tickets and acceptance criteria** | stories no test links to | tickets without criteria; heuristic matching | not built (the Jira binding serves failures) |
| **Escapes: bugs and fixes** (*escaped defect*, *fix did not hold*, *fixed without a regression test*) | the places a bug already got through, the strongest prior there is | bugs nobody reports | bug reports and regressed fixes wired; tracker bugs and production errors not; *fixed without a regression test* not designed |
| **Use: production routes and journeys** | what users rely on that no test follows | needs production data | designed, not built |
| **Check: assertions** (*assertion-light*) | pages checked only for visibility | assertions inside helpers the index cannot read | built |
| **Check: misbehavior a pass ignored** (*passed with errors*) | a pass with a console error, a backend error or a background 5xx | benign errors | built |
| **Check: probes** (client, server) | routes no test would notice failing | wrong values from correct responses; client logic; any field but the first | built; unreliable (§5) |
| **Check: mutation** (code mutants, imported unit mutation reports) | code executed but unchecked, at line level | slow; equivalent mutants | not built |
| **Trust: single covering, untrusted, phantom, quarantine loss** | surface one test, or only flaky tests, hold | — | partly built; trust never expires (§4.3) |

### 3.3 What the evidence says

The scenario-gaps record already cites most of this ([Prior art](../adr/scenario-gaps.md#prior-art),
[References](../adr/scenario-gaps.md#references)); three conclusions decide the ranking in §3.4.

- **The diff is the best reference there is, and code review is the moment.**
  - Changed, untested code is where field defects concentrate (Eder et al., 2013, the study behind test gap analysis).
  - Coverage of the changed lines, shown inside code review, is the form of coverage developers at Google found
    useful (Ivanković et al., 2019).
  - A ranked project-wide list of predictions changed no behavior (Lewis et al., 2013).
  - The same holds for mutation testing: surviving mutants on the changed lines, filtered for noise and shown in code
    review, are the form that scaled at Google, and developers shown them wrote more tests over time (Petrović and
    Ivanković, 2018; Petrović et al., 2021).

  Piwi's probes are the end-to-end analogue, but run nightly over the whole suite instead of on the diff.
- **Escapes are the ground truth.** An area that let a bug through is the definition of a residual-fault region.
  Defects concentrate in old, churned code rather than new code. And a finder that cannot show it flags where defects
  land is not worth its screen (escape lift, [`test-map-accuracy.md`](test-map-accuracy.md), Part 3).
- **Executed is not checked, and checks need confirmation.**
  - A large share of covered methods are pseudo-tested (Niedermayr et al., 2016; Vera-Pérez et al., 2019).
  - A fault oracle only helps if its verdict is trustworthy. Mutation tools run a mutant against every covering test,
    stop at the first kill and compare against a baseline; Piwi's probes do none of that (§5).

### 3.4 The best ways for Piwi, ranked

Ranked by the evidence behind each, the data Piwi already holds, what a team must set up, and whether the result can
be measured (§3.5).

1. **The pull request as the reference, done right.** This is the finder with the strongest evidence, and Piwi holds
   all of its data. Make the comment describe the whole pull request on every CI setup (finding 4), at line level
   wherever coverage exists. Run *new error path* and *intent without a test* on the patches and messages already
   fetched (finding 8). Give each uncovered file a link, a draft and a command (finding 10). Count how many of them get
   a test in the same pull request (§3.5). Items S11, M1 to M4.
2. **Escapes as a finder and as the yardstick.**
   - **A new detector, *fixed without a regression test*.** When fix verification records a cluster as fixed, check
     whether the fixing change added or changed a test that reaches the cluster's node or runs the fixed lines. If
     not, open a gap seeded from the failing step.
   - **Then bug reports, tracker bugs and production errors per route**, into the same ledger.

   These are the highest-precision gaps there are, since each one is a bug that happened. They are also the ground
   truth every other finder is measured against. Items M5, L2.
3. **A reference that needs no setup.** Read the routes the front-end framework already declares: Nuxt's `pages/`,
   Next's `app/` and `pages/`, SvelteKit's `routes/`, and React Router and Vue Router route tables. Also honor the
   OpenAPI document's base path, and read the page inventory on a settled page, on by default. Without a reference the
   blind-spot detectors cannot fire. With one, *declared, never hit* and *reachable, unvisited* become the map's most
   useful gaps. Items S8, M9, L1.
4. **Coverage turned into code-level gaps.**
   - *Code nobody executes*, ranked by churn;
   - *error path never executed*;
   - *single covering test* by function.

   The per-test data is stored. This is the cheapest way to make coverage say what to write outside the pull request.
   Item M7.
5. **"Would it notice", made trustworthy and aimed.** Fix the fault semantics. Plan per route and stop at the first
   test that notices. Run a probe set on the routes a pull request changed: the end-to-end form of mutation testing in
   code review. Then add field-level faults from response shapes. Items S9, M8, L3.
6. **Exposure that discriminates, or no single score.**
   - Use: link in-degree now, production route counts later.
   - Age: from a node's first-seen run and the file's first commit.
   - Priority: from neighbors as well as from the tests that reach a node.
   - Escapes: from bug reports.

   Until those carry signal, order each class by its own evidence rather than one product of floors. Item M6.

Two finders rank lower:

- **Exploration**, by a person through the extension, then by an agent from the map's frontier, is worth building
  once the reference and the measures exist (L4, L5).
- **Ticket and acceptance-criteria coverage** depends on how a team writes tickets: worth wiring through the Jira
  binding, but not a lead finder.

### 3.5 How to tell which finder works

The design treats precision as a first-class number. Precision alone rewards a finder that proposes little, and a
precision built on today's verdicts is not even precision (finding 9). Four measures say which finder works, two
online and two offline:

| Measure | What it says | Built from |
|---|---|---|
| **Acted on** | the share of a finder's gaps closed by a test written for them: in the same pull request for a change gap, within N days for the others | each gap's close reason (not stored today) and the pull request of the run that closed it |
| **Escape lift** | escapes on nodes a finder flagged before the escape, against escapes on nodes it did not, per node | bug reports, clusters' fixing commits and tracker bugs, against the gap ledger's history |
| **Seeded-fault recall** | of the faults the suite misses, the share each finder had flagged, and how many gaps it raised to do so | the sample application's two backends, with a catalog of seeded faults (M10) |
| **Leave-one-test-out recall** | whether each detector raises what a test it removes in memory leaves bare | the reach map, on every project, with no capture |

**The verdicts have to mean one thing each** before any of these holds:

- *Covered by* splits into *wrote a test* (for) and *already covered* (against).
- *Covered elsewhere* counts against a blind-spot detector.
- A dismissal without a reason counts for nothing.

**The seeded-fault benchmark is the one measure that compares finders on a single scale.** It works on the sample
application (`examples/sample-app`, with its Nitro and ASP.NET Core backends and its Playwright suite):

1. Write a catalog of realistic faults: a handler returns a wrong value, an error branch is removed, a validation is
   dropped, a control's handler breaks, a client-side computation is wrong, a status code changes.
2. Apply each fault and run the suite. A fault that survives is a missing test by construction.
3. For each surviving fault, check which finders had flagged the faulty route, page, control, file or lines before
   the fault was applied.

That gives each finder a recall on real missing tests and a cost in gaps raised, through the whole ingest path the
demo benchmark bypasses. Run nightly, it fails when a change makes a finder worse.

## 4. The Test Map

### 4.1 The detectors as built

`computeScenarioGaps` runs at three moments, and only over the default branch (S:1885 makes any branch recompute a
no-op):

- after each finished default-branch run (`server/utils/scm/pr-feedback.ts:638`);
- nightly at 03:23 (`server/tasks/graph/sweep.ts:102`);
- on demand (`server/api/projects/[id]/gaps/recompute.post.ts:50`).

| Detector | Class | Status |
|---|---|---|
| *changed, unreached* | blind spot | wired, at change time (`server/utils/scm/change-coverage.ts:411`) |
| *success only*, *single covering test*, *surface drift*, *orphan test* | blind spot, fragile | wired (S:2306-2319) |
| *control nobody exercises*, *reachable, unvisited* | blind spot | wired; need the inventory |
| *declared, never hit* | blind spot | wired; needs a declared surface |
| *fix did not hold*, *escaped defect* (Piwi Picker reports) | fragile, blind spot | wired |
| *passed with errors*, *assertion-light*, *catalog method, no test calls* | false comfort, blind spot | wired (S:2323-2325) |
| *not noticed*, *unprobed dependency*, *not handled* | false comfort, finding | wired; need probes (§5) |
| *API-only route* | blind spot | retired (`shared/handlers/detector-precision.ts:23`) |
| *phantom coverage*, *incidental catch*, *intent without a test*, *new error path*, *new control*, *matrix*, *escaped defect* (tracker bugs) | various | pure functions, never run |
| *locator break ahead* | prediction | the gap form is unused; the prediction runs for the comment and healing (`predictPatchBreaks`) |

**The retirement of *API-only route* rests on a premise that no longer holds.** It was retired because only the
page's own requests were captured. API request contexts are captured now
(`packages/reporter/src/internal/capture/api-requests.ts`), so "reached only through request fixtures" is decidable
again. Separating how a route was reached (a UI call, an API call, a seeding call before the first navigation) would
also stop seeding calls in `beforeEach` counting as reach.

**The scoring formula is not the one the ADR describes.** The ADR's *exposure × (1 − protection) / cost* is not
built: a gap's score is its detector's confidence times the geometric mean of four factors (S:220). The confidence
the probe loop writes on a `checks` edge is read nowhere.

### 4.2 Ingest and keys

The demo's graph is written by its seed, so none of these show there. On a real application:

- **Page loads become routes (TM-1).** Every `page.goto` adds `GET /settings` beside the page `/settings`. *Success
  only* then reports every page seen five times, *single covering test* raises the page and its route, and the probe
  planner spends its budget on the document route.
- **Volatile ids become nodes (TM-4).** `normalizeRoute` collapses digits, UUIDs, JWTs, ULIDs and long tokens
  (`packages/core/src/page-key.ts:28-39`), not 24-hex ObjectIds, cuids, nanoids, prefixed ids (`cus_…`), slugs or
  dates. Each entity becomes a route and a page node with a *single covering test* gap, and every product link a
  *reachable, unvisited* gap; they live for up to 180 days **(run)**.
- **An API on another origin reads as never hit (TM-5).** Route nodes come from the run's `baseURL` origin plus a
  per-project allowlist (`server/utils/graph-ingest.ts:131`). The reporter, however, uploads the manifest of every
  instrumented origin it saw (`packages/reporter/src/internal/manifest/run-manifests.ts`). An application whose API
  lives on `api.example.com` therefore gets every declared route as *declared, never hit*, while the calls the tests
  make are dropped **(run)**.
- **Server-rendered pages mint a dependency per id (TM-9).** `dependencyNameFromSpan` falls back to the span's name
  (`server/utils/graph-ingest.ts:598-605`), and a nested `$fetch` span is named `GET /api/orders/123`. Each id becomes
  a dependency node with an *unprobed dependency* gap. `conventionalHandlerFile` invents Nitro paths for routes of other
  frameworks **(run)**.
- **Hash routes, GraphQL and global control keys hide surface:**
  - a hash-routed single-page app is one page, `/` **(run)**;
  - a GraphQL API is one `POST /graphql` node, permanently *success only*, since its errors return 200;
  - control keys are `role:name` across the project (`shared/graph.ts:187`), so one click on *Save* anywhere covers
    every *Save*, and each locale is its own control **(run)**.
- **A run's graph can land after its own recompute (TM-14).** The graph write is fire-and-forget and takes no project
  lock (`server/utils/persist-run-cases.ts:684-691`). Its comment promises a nightly rebuild that runs only while a
  default branch is backfilled (`server/tasks/graph/sweep.ts:49`).

### 4.3 The evidence window and trust

- **The window mixes branches (TM-2).** `loadRecentRunIds` (S:1459-1466) takes the last 30 non-lab runs of any branch,
  while only the default branch writes canonical nodes **(run)**. Three things follow:
  - one pull-request run, even one still running, removes all surface drift;
  - after 30 pull-request runs in a row, the nightly sweep raises *orphan test* for every test;
  - one 500 from a pull-request bug closes a *success only* gap for 30 runs.

  These closures count as "closed this month". `test_runs.is_full_run` is not read, so a narrowed run on the default
  branch makes tests look like orphans. A full regression run on a release or staging branch never counts.
- **Trust is sticky one way and blind the other (TM-3).**
  - *Too broad*: `flakyRootCause` is set the first time a test passes on retry (`shared/handlers/flaky-classify.ts:53`)
    and never cleared, so that test is untrusted for good (S:1522-1527). On a mature suite the *No trusted test reaches
    …* gaps accumulate, and their confidence (0.6) outranks *single covering test* (0.5).
  - *Too narrow*: a test that fails every run counts as trusted **(run)**.
- **Removed surface never retires (TM-6).** Pruning keeps any node behind an open, snoozed or accepted gap
  (`server/utils/graph-ingest.ts:970-985`), and no node detector checks how recently its node was seen. A removed
  control keeps its node and its gap forever **(run)**.
- **Derived nodes drift (TM-8).** Handler and dependency nodes never get `reaches` edges, and import-scan `file` nodes
  are not excluded, so each new one raises *New handler … confirm it is tested*, although a test's own request is how
  it was discovered **(run)**.

### 4.4 Ranking

On the demo **(seen)**:

| Measure | Value |
|---|---|
| Open gaps | 95 |
| Distinct scores | 17 (0.04 to 0.20) |
| All four factors at 0.1 | 82 |
| Age at 0.1 | 95 |
| Escape history at 0.1 | 94 |
| Churn at 0.1 | 91 |
| Priority at 0.1 | 87 |
| Rank of the first *not noticed* gap (the class the ADR calls the most dangerous) | 7 |
| Rank of the first *declared, never hit* gap | 22 |
| Rank of *Delete organization*, *Transfer ownership* (no test exercises them) | 89, 82 |

Why:

- **Usage is not a factor at all.** The ADR lists it first; `usage_30d` is null until "usage is wired"
  (`server/database/schema.sqlite.ts:1926`).
- **Age is never computed for a node gap.** On a change gap it is the age of the oldest of the base branch's last
  twelve commits that touched the file, skipping those older than 90 days
  (`server/utils/scm/change-coverage.ts:58`, `:157-170`). It cannot exceed about 0.25, and an old, stable file gets
  the floor, the opposite of the ADR's intent (TM-13). Churn counts those twelve commits.
- **Priority comes from the tests that reach the node itself.** It is therefore the floor for every unreached node,
  and never set on a gap about a test, even when the test has a priority.
- **Churn and escapes reach only route, handler and dependency gaps**, through their handler files (S:2330-2339).
- **With every factor at the floor, the order is the detectors' constants:** *success only* with 20 observations
  0.100, *control nobody exercises* on 8 pages 0.080, *declared, never hit* 0.070, *untrusted only* and *passed with
  errors* 0.060, *single covering test* 0.050, *surface drift* and *orphan test* 0.040. A route tested twenty times
  without its error path outranks a route no test reaches, and a `minScore` above 0.1 returns nothing.
- **A finding shows its route's reach as "priority".** `rankFinding` puts the exposure proxy in the `priority` factor
  (S:233-245), so a resilience finding reads *priority 0.2* **(seen)**.
- **The feature map colors each feature by its worst open class.** With one *false comfort* gap anywhere in it, every
  feature is red **(seen)**.

### 4.5 Triage and the precision loop

- **The verdicts count the wrong things** (`shared/handlers/detector-precision.ts:93-99`):
  - a dismissal without a reason defaults to *wrong* (S:3861), and MCP documents the default, so an agent clearing an
    inbox can mute a detector;
  - *Covered by* counts *for* the detector, although its modal asks for "the test case id that covers this"
    (`app/components/gaps/GapsPanel.vue:446`), which reads as "this was already covered";
  - *covered elsewhere* and *not worth testing* count for nothing.

  With 9 *wrong*, 11 *covered elsewhere* and 6 *covered by*, a detector reads 0.4 over 15 verdicts and stays unmuted;
  counting *covered elsewhere* against it would give 0.23 **(run)**.
- **Muting is per detector, forever.**
  - Verdicts never decay and never reset when a detector's code changes.
  - From 5 *for* and 20 *against*, unmuting takes 25 *for* verdicts in a row, while its rows sort last in a tab that
    loads 200.
  - One noisy node kind, such as per-id routes, mutes the whole detector.
  - MCP's `list_scenario_gaps` (`server/utils/mcp/tools.ts:3027`), the feature map's counts and colors
    (`server/utils/feature-graph.ts:292`) and the analytics counts ignore muting.
- **The Home queue hides most accepted gaps (TM-12).** It treats "the subject has any `reaches` edge" as "the test
  was written" (S:3975-3995). An accepted *success only*, *single covering test*, *assertion-light* or *not noticed*
  gap never shows, since its subject is reached by definition. An accepted file gap stays forever, since a file node
  has no such edge without code reach **(run)**.
- **The Recompute button can compute nothing (TM-11).** It takes the branch of the project's newest run
  (`server/api/projects/[id]/gaps/recompute.post.ts:34-50`); when that is a pull-request run, the recompute is a
  no-op that reports success.

### 4.6 The declared surface and the inventory

- **The OpenAPI base path is ignored (TM-10).** `parseOpenApiSpec` reads `paths` alone (`shared/openapi.ts:37`), not
  `servers[].url` or Swagger's `basePath`. `/orders/{id}` served under `/api/v1` never matches, so every route reads
  as never hit **(run)**.
- **The OpenAPI document is rarely read.** It is fetched only by the manual Recompute (`recompute.post.ts:48`): not
  when the URL is saved, not nightly.
- **The inventory is read too early (TM-7).** The reporter reads the page on `framenavigated`
  (`packages/reporter/src/internal/capture/capture-fixtures.ts:2935`), once per origin and path per worker (`:1062`),
  with no visibility filter. A client-rendered view is read before it renders, either empty or holding the previous
  view's controls under the new URL, and that first read stands for the whole worker. It feeds *control nobody
  exercises*, *reachable, unvisited*, `contains` edges and feature inference.

### 4.7 The benchmark and map health

- **The benchmark measures each detector against its own definition, on a model that skips ingest.** It scores the
  precision and recall of 11 detectors on the demo's 10-test model (`tests/unit/demo-test-map.test.ts`, labels from
  `expectedWebDashboardGaps`, `shared/demo/demo-test-map.mjs:819`). The seed writes the route, page, inventory,
  handler, reach and first-seen rows directly. So the benchmark cannot see:
  - any ingest or key defect (TM-1, 4, 5, 7, 9);
  - a false positive built into a definition, since the truth applies the definition;
  - the ranking;
  - the window and the triggers;
  - five wired detectors: *orphan test*, *fix did not hold*, *escaped defect*, *changed, unreached* and *not handled*.

  `PIWI_UPDATE_DEMO_TEST_MAP=1` rewrites the fixture, so a regression passes when the JSON is regenerated in the same
  commit.
- **Map health counts inputs, not their effect.** It shows "Handlers" and "Change history" complete, each "ranks gaps
  by the churn and escapes of their files", while 91 of 95 gaps have churn at the floor **(seen)**. It has no row for
  what silences detectors:
  - requests dropped as another origin;
  - the share of locator calls resolved to a control;
  - the untrusted share of tests;
  - the canonical share of the run window;
  - the declared surface's match rate;
  - key cardinality, the nodes added per run.

## 5. Probes: whether a test would notice

### 5.1 As built

1. **Plan** (`shared/handlers/probes.ts:352-482`).
   - **Pairs.** It reads every canonical test-to-route `reaches` edge (they live 180 days) and drops quarantined
     tests and tests whose latest execution failed.
   - **Order.** It puts never-probed pairs first, then pairs whose test changed; each tier is sorted by how many tests
     reach the route.
   - **One fault per test, nth 1.** It takes one item per test, up to a budget of 50, with `nth: 1`. The client fault
     rotates by the item's position: `status-500`, `empty-body`, `drop-field`, `stale-value`, `slow` (`:140-153`).
   - **Server items.** With server probes on, half the budget goes to them.
   - **When a pair is probed again.** A pair counts as probed whatever the fault or level. It is probed again only when
     the test's steps change, or seven days after an inconclusive result.
2. **Run.** `piwi probe` fetches the plan, greps for the planned titles and sets `PIWI_PROBE`. The capture fixtures
   apply the fault through `page.route` to the first matching request after the first navigation, or sign it into
   `X-Piwi-Probe` for the backend. The run is stamped as a lab run and kept out of clusters, flaky scoring,
   notifications and pull-request feedback.
3. **Outcome** (`packages/reporter/src/internal/probe/mode.ts:103-106`):
   - a fault that was not applied is *inconclusive*;
   - a failed, timed-out or **interrupted** test *noticed* the fault;
   - anything else did not.
4. **Record.** Each result writes a ledger row per (test, route, fault) and overwrites one `checks` edge per (test,
   route). A *degraded* or *unhandled* result writes a *not handled* finding at once.

### 5.2 What an outcome means today

- **`slow` measures the expect timeout (PB-1).** The delay is a fixed 5,000 ms (`faults.ts:43`, `:142`), Playwright's
  default expect timeout. With that default, a test that waits for the data fails a few milliseconds after the timeout
  and reads *noticed*. With `expect.timeout: 10_000` it passes and the route gets *Tests pass when GET /api/orders
  breaks* **(run)**. One client probe in five is noise or a false gap.
- **One-shot faults (PB-2).** `nth: 1` breaks only the first matching request. A test that asserts the list after a
  create, or an application whose data layer retries a failed query, passes **(run)**. `stale-value` needs a prior
  body that is never given (`packages/reporter/src/internal/probe/interception.ts:236-240`) and is always
  inconclusive **(run)**.
- **Resilience is never *graceful* (PB-3).** An applied `throw` or `status` fault is itself a backend error, and the
  browser's "Failed to load resource" line for it is a console error, so every such probe reads at least *degraded*
  **(run)**. A correct error message on the page is filed as a finding.
- **Verdicts decay the wrong way (PB-6, PB-8):**
  - an inconclusive re-probe overwrites a decisive edge and closes the *not noticed* gap **(run)**;
  - a notice from a test that no longer reaches the route still counts, since `checks` edges never expire (S:1948)
    **(run)**;
  - *unprobed dependency* closes on any attempt, applied or not, and the Nitro plugin fails only outbound `$fetch`
    calls whose URL holds the dependency's name (`integrations/nitro/src/index.ts:537-560`), so a database dependency
    never applies **(run)**.
- **Probe runs leak into trust (PB-9).** `latestExecutionStatus` reads lab runs too (S:1485-1504). A test the probe run
  cut short (`maxFailures`, a serial group) becomes untrusted and reopens false comfort elsewhere **(run)**.
- **Interrupted counts as noticed and skipped as not (PB-15).** `outcomeFromStatus` (`mode.ts:103-106`) makes a global
  timeout or a cancelled job *noticed*, and a test skipped after the fault applied *not noticed* **(run)**.

### 5.3 How fast the loop learns

A 90-night simulation used the real planner and ledger on a model suite of 200 tests, 133 routes and about ten routes
per test, with the default budget of 50 **(run)**:

- after 14 nights, 5 of the 133 routes had a decisive outcome; every route had one only by night 83;
- 64% of all probes never applied, and 91% to 100% of each night's probes after about twelve weeks;
- 29% hit a route another test had already noticed.

The pairs that can never apply return every seven days at the top of the plan (PB-5):

- the first navigation's document route;
- routes a test calls only through the API request fixture;
- routes a test stopped calling;
- `stale-value`;
- server items for an API on another origin (PB-13).

A planned pair whose test wrote no outcome is planned first again every night
(`packages/reporter/src/cli/probe.ts:129-141`) **(run)**. Turning on server probes after the client loop yields no
server items, since each pair is probed once whatever the level (PB-11) **(run)**.

### 5.4 What probes can and cannot find

**What they find.** A client probe is close to extreme mutation applied to one route for one test: it finds routes
whose availability or whole body no passing test depends on. A server fault is the handler-level form.

**What they cannot find:**

- a wrong value rendered from a correct response;
- a handler computing a wrong value of the right shape (no value mutation exists; `drop-field` drops the first key);
- an assertion that checks a field exists but not its value;
- calls made through `request`, `page.request` or a second page;
- branches inside a handler.

So "coverage plus probes is close to mutation testing" ([`unified-code-coverage.md`](unified-code-coverage.md), 6.3)
holds at the boundary only. Where it falls short is §3.3's last point: no baseline, no confirmation that the failure
came from the fault, one fault per pair, and no handling of the probe-level equivalent mutant (a telemetry route
nobody should notice).

### 5.5 Adoption

- **Nothing turns the loop on.** No CI template, desktop action, MCP tool or button runs `piwi probe`, and no
  workflow in this repository does. The sample application's `server-probes.spec.ts` signs its own header with
  `status-500`, a fault the planner never emits.
- **Server probes are out of reach for ASP.NET Core-only projects.** They need stored server traces before the
  setting shows (`shared/handlers/capabilities.ts:84-95`), and the ASP.NET Core package emits a trace only on a probe
  request (PB-16).
- **The demo shows outcomes the product cannot produce.** Its seed writes them directly
  (`shared/demo/demo-test-map.mjs:588-640`), including a `stale-value` *not noticed* and applied dependency probes on
  postgres and s3.
- **The yield shows nowhere.** Map health counts routes "probed", inconclusive included
  (`shared/handlers/map-health.ts:155-159`). Checked share, not-noticed rate and inconclusive rate appear nowhere, so
  the server probes' own entry condition (one pair in ten not noticed) cannot be measured in the product.

## 6. Code coverage

### 6.1 As built

| Signal | Granularity | Setup | Cost (documented) |
|---|---|---|---|
| Browser code reach | files, or functions with their line ranges; all functions V8 lists at run level | `coverage.browser` or `captureCodeReach`, with the fixtures; source maps or a dev server; Chromium | +8% on a small page, +40% to 50% on a large Vue application |
| CSS rules | matched rule ranges, as browser functions | `coverage.css: 'rules'` | +10% to +57% |
| Server, ASP.NET Core | files, functions or lines per test; run-level lines with the span table as denominator | the package, `-p:PiwiCoverage=true`, Development or Test, `coverage.server` | under 2% test time; +12.5% to 26% server CPU |
| Server, Nitro | the same, at statement lines | the module and plugin, `PIWI_COVERAGE_BUILD=true` | +5.6% server CPU |
| Unit uploads | executable and executed lines, functions, per suite per commit, with the file inventory | `piwi coverage upload` (Cobertura, LCOV or Piwi's format) | the unit tool's own |
| Combined coverage per commit | reference lines; unit only, end to end only, both, none, undetermined; areas; carry-forward | automatic; scope and areas in the project settings | — |

The unified study's Status paragraph matches the code. Browser lines, the Istanbul adapter, Nuxt server rendering and
part 6 beyond suspect lines are not built.

### 6.2 From coverage to a missing test

Coverage reaches a gap only through *changed, unreached* and the comment's changed lines not run. Everything else is
display:

- *Least covered here* and the tree's *Least covered* sort, by the count of lines no suite ran
  (`shared/coverage-combine.ts:425-444`, `server/utils/coverage-summary.ts:677`);
- the *Without data* count;
- the file page's range stepping and nearest test;
- the API's `leastCovered`, and MCP's `get_coverage_summary`, whose description calls it "where a test is most
  missing";
- the LCOV and Cobertura export;
- the editors' marks.

No list of functions no test runs, ranked by churn or anything else, exists anywhere. The skill never starts from
`leastCovered`.

A browser-only file has functions but no line counts, so it scores zero lines not run and never ranks: a
`Checkout.vue` with two of three functions never run sorts last **(run)**. And *Without data* is mostly noise:

- the default scope has no include patterns (`packages/core/src/coverage-scope.ts:23-37`), so READMEs, lockfiles,
  YAML, images, page objects and `playwright.config.ts` count as product code (CV-8);
- in this repository, 1,288 of the 3,786 in-scope files are not code **(run)**;
- a project that uploads no unit suite never gets the count at all.

### 6.3 Numbers that read better than the truth

- **Narrowed runs count as full (CV-3).** The reporter marks a run partial for a grep, a file filter or a selection
  only (`packages/reporter/src/public/reporter.ts:337-352`). `--last-failed`, `--only-changed`, `--project` and
  `--max-failures` runs are full runs, so a commit whose only run is one of them gets a fragment of the suite as its
  end-to-end coverage. Its lines read "no suite ran", and it blocks the carry-forward of the last full run **(run)**.
- **A partial upload raises the ratio (CV-2).** With the full report a commit reads 8 of 30 lines; with a partial one,
  8 of 10, and the untested files move to *without data* **(run)**. The ADR's safeguard, a warning when a suite's file
  count drops by more than a fifth (`adr/combined-code-coverage.md:383`), is not built.
- **Run-level coverage counts the whole life of the backend (CV-4).** Both packages accumulate from process start
  (`integrations/aspnetcore/PiwiTests.Instrumentation.AspNetCore/PiwiServerCoverage.cs:224-226`,
  `integrations/nitro/src/coverage-runtime.ts:415-420`). With a server that Playwright reuses, a shared staging
  backend, health checks or manual clicking, code no test ran counts as run by the end-to-end suite, and nothing flags
  it.
- **The scheduled browser run is never carried forward (CV-1).** Carry-forward returns as soon as the commit has an
  end-to-end suite (`server/utils/coverage-totals.ts:421`). The docs recommend server coverage on every run and
  browser coverage on a schedule ([`coverage-cost.md`](../apps/docs/reference/coverage-cost.md)), and with that setup
  the browser functions show only on the scheduled run's own commit.
- **Deleted tests keep counting (CV-7).** Default-branch `test_coverage` rows are never pruned
  (`server/utils/coverage.ts:1209-1217`). The file view, the nearest test and the quarantine loss preview
  (`shared/handlers/coverage-insights.ts:608-619`) read tests that no longer exist.
- **"Did the new test reach its target" passes a nested function (CV-6).** At function granularity a target line
  inside any function that ran counts as run (`shared/coverage-insights.ts:1147-1170`), so an `onClick` callback that
  never ran reads `allRan: true` **(run)**. Combined coverage calls the same lines undetermined.
- **Smaller ones**, each in appendix A:
  - report paths resolve against the current directory before the report's folder (CV-5);
  - browser files at file granularity never reach combined coverage (CV-9);
  - incomplete captures replace complete ones (CV-10);
  - absolute paths from a container cannot be mapped (CV-11);
  - CSS rules count in the Functions ratio (CV-13);
  - the export writes undetermined lines as 0 hits (CV-14).

## 7. Change time: uncovered changes and patch coverage

### 7.1 The path

When a run finishes, `analyzeFinishedRunInBackground` (`server/utils/scm/pr-feedback.ts:499`) starts two jobs: the
Test Map recompute, and `computeRunChangeCoverage`, which runs outside the project lock.
`computeRunChangeCoverage` (`server/utils/scm/change-coverage.ts:294`):

1. **Takes the head and the base.** The head is `git rev-parse HEAD`. The base is the pull request's target branch
   when the run carries a pull-request number, and otherwise the last passing run on the same branch.
2. **Fetches the diff** and keeps added lines and deletions; renames are dropped.
3. **Applies `changeReach`.** `computeChangeCoverage` (`shared/handlers/change-coverage.ts:359`) reads locator call
   sites, spec files, convention-mapped route and page reach, code reach and the head commit's coverage, over the last
   30 complete runs of any branch.
4. **Writes and posts.** It writes `changes` edges and *changed, unreached* gaps, and posts the comment section and a
   `piwi/tests/change-coverage` status that is always *success*.

The gate re-reads change coverage and adds warnings only.

### 7.2 Where it goes wrong

- **The pull request is not the reference on common setups (CT-1, CT-2):**
  - **Push-triggered runs.** The documented workflow is push-triggered (`apps/docs/guide/ci.md:25`). CircleCI, Travis
    and Buildkite pull requests are never detected either. After the first green push the comment, edited in place,
    lists only the latest push's changes, and the gaps carry no pull-request number, so
    `list_scenario_gaps(pr)` finds nothing.
  - **`pull_request` runs.** The recorded commit is the merge commit, so the statuses do not show on the pull
    request.
  - **Forks.** The pull request is looked up by `head=<base owner>:<branch>`
    (`server/utils/scm/GitHubProvider.ts:411`) instead of by the number the run carries
    (`server/utils/scm/pr-feedback.ts:427-433`).
- **Monorepos read every file in every project (CT-3).** The conventions match any `server/api` or `pages/` segment
  (`packages/core/src/file-routes.ts:67-101`), and there is one comment marker per pull request
  (`shared/pr-feedback.ts:25`), so projects overwrite each other. `apps/admin/app/pages/settings.vue` opens a gap in
  the project `web` **(run)**.
- **Observability decides what is counted:**
  - **Code reach hides new files (CT-7).** With code reach on, a file no test executed has no `code_reach` row and
    reads *not observable*, so a new, untested component is "not counted" **(run)**.
  - **Other layouts read as unreached (CT-8).** Outside Nitro and Nuxt, an Express `server/routes/users.js` maps to
    `/users`, and reads *unreached* while the tests reach `GET /api/users` **(run)**.
  - **One run line clears a whole file (CT-10).** One changed line run by any suite makes the whole file reached
    (`shared/handlers/change-coverage.ts:459`): a unit test that imports a handler suppresses the Test Map's gap, and
    the status reads "all changed files reached, patch coverage 3.3%" **(run)**.
- **The memory is wrong:**
  - **Orphaned change gaps (CT-11).** They are keyed by file, with no branch or pull request, and close only when a
    later diff reads the file (`:414-415`). A reverted file, a file dropped by a force-push, an abandoned pull
    request's files and the old path of a rename keep their gaps forever, and a pure rename reads "+0 −0, not
    reached" **(run)**.
  - **Triage on a file gap is lost (CT-5).** It writes no edge (S:3710), and the comment and the gate read reach
    alone, so they flag a dismissed or covered file again on every pull request that touches it **(run)**.
  - **A spread-out window (CT-9).** The 30-run window spans branches and counts runs, not time
    (`shared/handlers/change-coverage.ts:374-380`). A test that exists only on another branch makes a file *reached
    earlier*, and "0 tests in 30 runs" is printed on a project with two runs **(run)**.
- **Smaller ones:**
  - `onlyOnFailure` drops the section on a green run (CT-12, `shared/pr-feedback.ts:675-682`);
  - a re-indented file floods the changed lines, and a deletion-only change is invisible (CT-13);
  - change gaps score at most about 0.36, so they sit below the top of the tab and the digest (CT-14);
  - the suffix path match reads a changed root `src/index.ts` as reached through `packages/w/src/index.ts` (CT-15);
  - GitHub never reports the total file count, so the gate counts the first 300 files silently (CT-16).

## 8. Delivery: where a gap reaches someone

| Surface | Shows | Action it offers |
|---|---|---|
| Pull-request comment | counts, up to ten uncovered files, "0 tests in 30 runs", changed lines not run | none; the comment's only link is the run |
| `change-coverage` status | "N of M changed files no test reached, patch coverage P%" | links to the run page, which lists no uncovered changes |
| Gate | a count against a threshold (`server/api/test-runs/[id]/gate.post.ts:287-293`) | none; the warnings are not stored with the evaluation |
| MCP `get_change_coverage` | each file's reach and lines | no gap ids, no truncation flag |
| MCP `list_scenario_gaps`, `draft_scenario` | ranked gaps, a draft | an empty draft for file gaps; no detector filter; muting ignored |
| Gaps tab | gaps, evidence, verbs | Accept copies the draft |
| Home queue | accepted gaps older than a week | links to the tab filtered on accepted; misses most gaps (§4.5) |
| Digest and widgets | titles and counts | a link to the tab |
| Editors | coverage marks, uncovered-change lines, a lens | the lens has no command (`packages/editor/src/server.ts:2987`) |
| Extension, Tested elements | untested interactive elements on the live page | Copy locator |

- **The editors run a rule of their own.** `uncoveredFile` (`packages/editor/src/coverage.ts:49-61`) is not
  `changeReach`:
  - a page is reached only when a locator acted on it, not when a test visited it;
  - there is no coverage scope and no window;
  - the base is the merge base with the default branch, not the pull request's base.

  `get_impacted_tests` uses no conventions and no scope either. ADR D4's "every consumer reads one rule" holds for the
  dashboard, MCP's `get_change_coverage` and the gate only.
- **The extension reads no Test Map data.** Part 4 of [`test-map-accuracy.md`](test-map-accuracy.md) is all still
  proposed.
- **Nothing routes a gap to an owner.** CODEOWNERS feeds failures and flaky tests, never the map.

## 9. How well this area is itself tested

The pure functions are well tested. The joins and the loops are not:

- **Change time.**
  - `computeRunChangeCoverage` and `readChangeCoverage` are mocked in every test.
  - `postRunPrFeedback` never posts in a test: they stop at the missing `PIWI_SITE_URL`.
  - `resolveDiffBase`, `computeFileExposure`, `toPrChangeCoverage`, `hasChangeCoverage` and the GitHub provider's
    paging have no test.
  - No end-to-end spec covers change coverage or the comment.
- **The Test Map.**
  - No test covers the window across branches, sticky flakiness, document routes, raw ids in keys, the pruning and
    open-gap loop, the recompute endpoint's branch choice, `sweep.ts` or `gap-classes.ts`.
  - No test checks that MCP honors muting.
  - The benchmark bypasses ingest (§4.7).
- **Probes.**
  - `cli/probe.ts` and the probe glue in the capture fixtures have no test, and no end-to-end probe run exists, as
    flake mode's `flake-run.spec.ts` does for flake runs.
  - The ASP.NET Core probe code has no .NET test.
  - The detectors are tested on seeded edges, never on outcomes the loop produced.
- **Coverage.**
  - Nothing tests path-resolution collisions, partial-run flags, carry-forward beside a partial end-to-end suite,
    test staleness, incomplete-capture replacement or the default scope's *without data*.
  - The test of `reachOfTargets` asserts the nested-function behavior of CV-6 as intended.
  - On the .NET side, nothing covers SignalR, replicas or per-run windows.

## 10. What to change, ranked

Each item names the findings it closes.

### Quick wins (S)

| # | Change | Closes |
|---|---|---|
| S1 | Keep `document` requests out of route nodes, or key them as page loads | TM-1, PB-5 |
| S2 | Read the detectors' evidence window from default-branch, non-lab, full runs; take the latest canonical run as "latest" | TM-2, CT-9 in part |
| S3 | Make trust recent: flaky in the last N default-branch runs, and a test failing every run untrusted | TM-3 |
| S4 | Compute canonical gaps on Recompute whatever the newest run's branch; refresh the OpenAPI document on save and nightly | TM-11, TM-10 in part |
| S5 | Make verdicts mean one thing: split *Covered by* into *wrote a test* and *already covered*; count *covered elsewhere* against blind-spot detectors; a reasonless dismissal counts nothing; MCP and the feature map honor muting | finding 9 |
| S6 | Home queue: "written" means the gap closed, or a test new since the acceptance reaches it; close accepted change gaps when their file is reached | TM-12, CT-4 |
| S7 | Collapse 24-hex ObjectIds, cuids, nanoids and prefixed ids in `normalizeRoute`; add a key-cardinality row to map health | TM-4 |
| S8 | Honor OpenAPI `servers[].url` and `basePath`; join requests to declared routes across the project's own origins | TM-10, TM-5 |
| S9 | Probes: leave `slow` out of *not noticed*; an inconclusive result never overwrites a decisive one; skipped and interrupted are inconclusive; lab runs out of `latestExecutionStatus`; resilience against the test's own unprobed errors, leaving out the injected 5xx | PB-1, 3, 6, 9, 15 |
| S10 | Coverage: read `--last-failed`, `--only-changed`, `--project` and `--max-failures` as partial; nested functions in `reachOfTargets`; carry forward by runtime, not by suite; default the scope to source files | CV-1, 3, 6, 8 |
| S11 | Pull requests: look the pull request up by number first; post statuses on its head commit; one comment marker and status context per project; keep uncovered changes under `onlyOnFailure` | CT-2, CT-3, CT-12 |
| S12 | Show the ranking honestly: no "priority" on a finding's exposure; color a feature by its gap counts per class, not its worst class alone | §4.4 |
| S13 | Fix the docs of appendix B | appendix B |

### Next (M)

| # | Change | Closes |
|---|---|---|
| M1 | **The pull request as the reference on every trigger**: resolve the pull request from the branch through the provider when the run has no number, and diff against its base | CT-1 |
| M2 | **One action per gap**: a gap link and a draft link per uncovered file in the comment; a run's *Uncovered changes* view for the status to link; the gate lists files and stores its warnings; the editor lens drafts or records; file-gap drafts through the file's route or page and the nearest test | finding 10, CT-6 |
| M3 | **Run the change-time detectors** inside `computeRunChangeCoverage`, where the patches and messages already are: *new error path*, *intent without a test*, then *new control* | finding 8 |
| M4 | **Measure outcomes**: store each gap's close reason; count a change gap closed by a test in the same pull request (the M1 success measure, *acted on*) and show it beside precision; escape lift from bug reports and fixing commits; leave-one-test-out recall | finding 9, §3.5 |
| M5 | **Escapes as gaps**: *fixed without a regression test* when fix verification records a fix; *incidental catch* from the fixing commit; bug reports into escape history | §3.4, item 2 |
| M6 | **Exposure that discriminates**: priority from neighbors and from tests on test gaps; link in-degree as the usage stand-in; age from first-seen runs and first commits; a new-code factor for change gaps; or order each class by its own evidence | finding 2 |
| M7 | **Coverage to gaps**: *code nobody executes* ranked by churn, *error path never executed* from a statement classification at build time, *single covering test* by function; a *Draft a test for these lines* action on a range | finding 5 |
| M8 | **Probes that learn**: a persistent fault for the whole test; plan per route, the tests with value matchers on its page first, stop at the first notice; skip pairs that cannot apply; `piwi probe --changed` on a pull request's routes and `--gap <id>`; checked share, not-noticed and inconclusive rates on the tab; a scheduled job in `init` | PB-2, 4, 5, 10, 11, finding 7 |
| M9 | **Inventory that sees the page**: read on settle and again when empty, filter hidden elements, key controls per page with the global key as an alias | TM-7, §4.2 |
| M10 | **The seeded-fault benchmark** on the sample application's two backends, run nightly, and the demo benchmark fed through ingest | §3.5, §4.7 |

### Programs (L)

| # | Program | Why |
|---|---|---|
| L1 | **A reference with no setup**: front-end router manifests (Nuxt, Next, SvelteKit, React Router, Vue Router) and more server route tables, as declared surface | finding 1; the recall ceiling of every blind-spot detector |
| L2 | **Production signals**: route counts from the instrumentation packages in production under a usage-scoped key, and production errors per route from OpenTelemetry or an error tracker | the usage factor, escape history and *fails in production, no test reaches it* |
| L3 | **Field- and value-level checks**: faults from response shapes ([`api-contract-drift.md`](api-contract-drift.md)) that name the field, and imported mutation reports for unit-level code | §5.4 |
| L4 | **The extension as a source**: gaps on the page, *Record a test* from an untested element, the page's surface posted with consent ([`test-map-accuracy.md`](test-map-accuracy.md), Part 4) | the states no capture records |
| L5 | **Guided exploration** from the map's frontier, behind its entry condition | [`scenario-gaps.md`](../adr/scenario-gaps.md), Later |

### Sequence

1. **The quick wins.** Each changes what an existing gap says, and M4's numbers mean nothing until S1 to S6 hold.
2. **M1 to M4.** The pull request becomes the reference, every gap gets its action, and outcomes are measured.
3. **M5 to M7, with M10.** Escapes and coverage become gaps, and every finder is scored on one scale.
4. **M8, M9, then L1.** These widen the reference and the check.
5. **L2 to L5**, each behind an entry condition that M4 and M10 can now measure.

New wire fields, options and endpoints get an entry in [`1.0-stabilization.md`](1.0-stabilization.md): the gap's close
reason, the verdict split, the probe options and the router manifests.

## 11. Open questions

1. Should a page load stay a route node for server-rendered applications, whose page request has error paths of its
   own (an SSR 500), keyed apart from API routes?
2. Should *Covered by* become two verbs, or one verb with a required reason?
3. Should change gaps live in the canonical ledger keyed by file, or per pull request?
4. Is one score the right shape at all, or should each class be its own ranked queue?
5. Should the page inventory default to on once it reads a settled page, given that it records names only?
6. Should run-level server coverage take a per-run window (the run's start, sent by the reporter), so that a shared
   backend reads true?
7. Where does the seeded-fault benchmark run: nightly CI with both backends, or the desktop app on demand?

## Appendix A. Defects found, with locations

Severity: **H** high, **M** medium, **L** low. *Run* means reproduced during the audit; *read* means read in the
code; *seen* means observed on the seeded instance.

### The Test Map

| ID | Defect | Location | Severity | How |
|---|---|---|---|---|
| TM-1 | Every page load becomes a `GET <page>` route node | `packages/reporter/src/internal/capture/capture-fixtures.ts:3312`; `server/utils/graph-ingest.ts:130` | H | run |
| TM-2 | The 30-run window mixes branches: drift erased, orphans for every test, *success only* closed by a pull request's 500 | S:1459-1466; S:474; S:1592 | H | run |
| TM-3 | A test flaky once is untrusted forever; a test failing every run is trusted | `shared/handlers/flaky-classify.ts:53`; S:1522-1527 | H | run |
| TM-4 | ObjectIds, cuids, nanoids, prefixed ids and slugs stay raw in keys | `packages/core/src/page-key.ts:28-39` | H | run |
| TM-5 | An API on another origin: requests dropped, its declared routes all *never hit* | `server/utils/graph-ingest.ts:131`; `packages/reporter/src/internal/manifest/run-manifests.ts` | H | run |
| TM-6 | A node behind an open gap is never pruned, so removed surface keeps its gap | `server/utils/graph-ingest.ts:970-985` | M | run |
| TM-7 | The inventory is read on `framenavigated`, once per path per worker, hidden elements included | `capture-fixtures.ts:2935`, `:1062` | M | read |
| TM-8 | Handler, dependency and import-scan nodes raise surface drift | S:466-506 | M | run |
| TM-9 | A server-rendered page mints a dependency per id; Nitro handler paths invented for other frameworks | `server/utils/graph-ingest.ts:598-605` | M | run |
| TM-10 | OpenAPI `servers` and `basePath` ignored; the document fetched only on a manual recompute | `shared/openapi.ts:37`; `server/api/projects/[id]/gaps/recompute.post.ts:48` | M | run |
| TM-11 | Recompute computes nothing when the newest run is on another branch | `recompute.post.ts:34-50`; S:1885 | M | read |
| TM-12 | The Home queue hides accepted gaps on reached subjects, and keeps accepted file gaps forever | S:3975-3995 | M | run |
| TM-13 | Change-time age caps near 0.25 and floors old files; churn counts twelve commits | `server/utils/scm/change-coverage.ts:58`, `:157-170` | M | read |
| TM-14 | A run's graph write can land after its recompute; its comment names a nightly rebuild that does not run | `server/utils/persist-run-cases.ts:684-691`; `server/tasks/graph/sweep.ts:49` | L | read |
| TM-15 | The precision loop: a reasonless dismissal is *wrong*, *Covered by* is *for*, *covered elsewhere* is nothing; no decay; MCP and the feature map ignore muting | S:3861; `shared/handlers/detector-precision.ts:93-99`; `server/utils/mcp/tools.ts:3027`; `server/utils/feature-graph.ts:292` | M | run |
| TM-16 | A finding's route exposure is shown as its priority | S:233-245 | L | seen |
| TM-17 | `triggers` edges, which the scenario-gaps record lists as shipped, are never written | `shared/graph.ts:500` | L | read |

### Probes

| ID | Defect | Location | Severity | How |
|---|---|---|---|---|
| PB-1 | `slow` delays by the default expect timeout, so its outcome reads the timeout | `packages/reporter/src/internal/probe/faults.ts:43`, `:142` | H | run |
| PB-2 | Every fault hits only the first matching request; `stale-value` never applies | `shared/handlers/probes.ts:151`; `packages/reporter/src/internal/probe/interception.ts:236-262` | H | run |
| PB-3 | Every applied `throw` or `status` server fault reads at least *degraded* | `packages/reporter/src/internal/probe/mode.ts:92-96` | H | run |
| PB-4 | A change to a test is seen only if it has run fewer than 20 times since, across branches | `shared/handlers/probes.ts:267`, `:313-326` | H | run |
| PB-5 | Most of the budget goes to pairs that cannot apply; 83 nights to an outcome on every route | `shared/handlers/probes.ts:352-482` | H | run |
| PB-6 | An inconclusive re-probe overwrites a decisive edge and closes the gap | `shared/handlers/probes.ts:718-752` | M | run |
| PB-7 | *unprobed dependency* closes on any attempt; database dependencies never apply | `shared/handlers/probes.ts:756`; `integrations/nitro/src/index.ts:537-560` | M | run |
| PB-8 | Notices never expire, including from tests that no longer reach the route | S:1948 | M | run |
| PB-9 | Probe runs' statuses feed the trust model | S:1485-1504 | M | run |
| PB-10 | A planned pair with no outcome is planned first every night | `packages/reporter/src/cli/probe.ts:129-141` | M | run |
| PB-11 | One probe per pair ever: no server items after the client loop; only a route's first dependency | `shared/handlers/probes.ts:410-442`, `:224` | M | run |
| PB-12 | The route verdict mixes faults; the dropped field is not recorded | S:2217; `mode.ts:57-69` | M | read |
| PB-13 | Server probes never sign a request to another origin | `interception.ts:201` | M | run |
| PB-14 | One POST capped at 500 results while the budget is uncapped; one line per Playwright project | `server/api/projects/[id]/probes/results.post.ts:18`, `:35`; `plan.get.ts:24` | M | read |
| PB-15 | Interrupted counts as noticed; skipped after the fault as not noticed | `mode.ts:103-106` | M | run |
| PB-16 | ASP.NET Core-only projects cannot reach the server-probe setting | `shared/handlers/capabilities.ts:84-95`; `shared/handlers/setup-status.ts:124` | M | read |
| PB-17 | No control run and no cleanup: a flaky failure under a fault counts as noticed | `mode.ts:103-106` | L | read |
| PB-18 | A third-party request with the same path can take the fault | `packages/reporter/src/internal/probe/plan.ts:89-99` | L | run |

### Coverage

| ID | Defect | Location | Severity | How |
|---|---|---|---|---|
| CV-1 | Scheduled browser coverage is never carried into a commit with an end-to-end suite | `server/utils/coverage-totals.ts:421`, `:263` | H | read |
| CV-2 | A partial unit upload raises the ratio; the promised file-count warning is not built | `adr/combined-code-coverage.md:383` (no code) | H | run |
| CV-3 | `--last-failed`, `--only-changed`, `--project`, `--max-failures` runs count as full | `packages/reporter/src/public/reporter.ts:337-352` | M | run |
| CV-4 | Run-level server coverage accumulates for the backend's lifetime | `PiwiServerCoverage.cs:224-226`; `integrations/nitro/src/coverage-runtime.ts:415-420` | M | read |
| CV-5 | Report paths resolve against the current directory before the report's folder | `packages/reporter/src/internal/coverage-upload/report-files.ts:137` | M | run |
| CV-6 | A nested function that never ran counts as reached | `shared/coverage-insights.ts:1147-1170` | M | run |
| CV-7 | Deleted tests keep counting in the file view, the nearest test and quarantine loss | `server/utils/coverage.ts:610`, `:1209-1217`; `shared/handlers/coverage-insights.ts:608-619` | M | read |
| CV-8 | *Without data* includes every tracked file; absent without uploads | `packages/core/src/coverage-scope.ts:23-37`; `shared/coverage-combine.ts:370` | M | run |
| CV-9 | Browser files at file granularity never reach combined coverage | `packages/reporter/src/internal/collect/test-coverage.ts:313`, `:431` | L | run |
| CV-10 | A test whose server collection failed gets no coverage instead of *incomplete*; an incomplete capture replaces a complete one | `packages/core/src/coverage.ts:229`; `server/utils/coverage.ts:270` | L | run |
| CV-11 | Absolute paths from another root cannot be mapped | `packages/core/src/coverage-formats.ts:576` | L | run |
| CV-12 | Browser line numbers are not checked against the source version | `test-coverage.ts:224`, `:265` | L | read |
| CV-13 | CSS rules count in the Functions ratio | `test-coverage.ts:286`; `shared/coverage-combine.ts:332` | L | run |
| CV-14 | The export writes undetermined lines as 0 hits | `server/utils/coverage-summary.ts:357-361` | L | read |
| CV-15 | Inline `<script>` blocks get line ranges at the top of the file | `packages/reporter/src/internal/capture/code-reach.ts:664-670` | L | read |
| CV-16 | Load-balanced backend replicas always read as restarted | `packages/reporter/src/internal/collect/server-coverage.ts:425-433` | L | read |

### Change time and delivery

| ID | Defect | Location | Severity | How |
|---|---|---|---|---|
| CT-1 | Push-triggered runs are diffed since the last green push, not against the pull request's base | `apps/docs/guide/ci.md:25`; `metadata-collector.ts:84-94`; `server/utils/scm/change-coverage.ts:270-287` | H | read |
| CT-2 | `pull_request` runs post statuses on the merge commit; fork pull requests get no comment | `metadata-collector.ts:289`; `server/utils/scm/pr-feedback.ts:427-458`; `GitHubProvider.ts:411` | H | read |
| CT-3 | Monorepo projects read every changed file and overwrite one comment | `packages/core/src/file-routes.ts:67-101`; `shared/pr-feedback.ts:25` | H | run |
| CT-4 | Accepted change gaps never close | S:541-570, S:3346 | M | run |
| CT-5 | Triage on a file gap never reaches the comment or the gate | S:3710 | M | run |
| CT-6 | A file gap's draft is empty; the comment's draft is a fixed string | S:4166, S:4206-4235; `server/utils/scm/change-coverage.ts:259-262` | M | run |
| CT-7 | With code reach on, a new untested file reads *not observable* | `shared/handlers/change-coverage.ts:437-465` | M | run |
| CT-8 | Express and vue-router layouts read as unreached through Nitro conventions | `packages/core/src/file-routes.ts:67-101` | M | run |
| CT-9 | The window spans branches and counts runs, not time | `shared/handlers/change-coverage.ts:374-380` | M | run |
| CT-10 | One changed line run by any suite makes the whole file reached | `shared/handlers/change-coverage.ts:459` | M | run |
| CT-11 | Change gaps of reverted, force-pushed, abandoned and renamed files never close | `shared/handlers/change-coverage.ts:414-415`; S:3364; `GitHubProvider.ts:49-58` | M | run |
| CT-12 | `onlyOnFailure` drops the uncovered changes on a green run | `shared/pr-feedback.ts:675-682` | M | run |
| CT-13 | Whitespace-only lines count as changes; deletion-only changes are invisible | `server/utils/scm/change-coverage.ts:245-256` | L | run |
| CT-14 | Change gaps score at most about 0.36 | `server/utils/scm/change-coverage.ts:157-161` | L | run |
| CT-15 | Suffix path matching reads a root file as reached through a nested one | `shared/handlers/change-coverage.ts:60-63` | L | run |
| CT-16 | Large diffs: GitHub's total file count is never read; Bitbucket drops patches past 200 KB | `GitHubProvider.ts:185`; `BitbucketProvider.ts:236-238` | L | read |
| CT-17 | A narrowed pull-request run's own lines can read as *not run* | `server/utils/coverage-summary.ts:78` | L | read |

## Appendix B. What the docs say versus what the code does

- **[`scenario-gaps.md`](../apps/docs/features/scenario-gaps.md):**
  - Gaps "ranked by exposure … how old it is": age is never computed for a node gap.
  - The Home queue "lists the gaps accepted more than a week ago whose test was never written": it skips every gap on
    a reached node.
  - "Closed this month is real": closures include pull-request runs' evidence and deleted or unobservable files.
  - OpenAPI "fetched on a recompute": on the manual one only, without its base path.
  - Not mentioned:
    - hash routes collapse to `/`;
    - only numeric and UUID-like ids collapse;
    - the inventory is read on URL change, once per page per worker;
    - the tab shows at most 200 gaps;
    - a node with an open gap never retires;
    - a reasonless dismissal counts as *wrong*.
- **[`gap-detectors.md`](../apps/docs/reference/gap-detectors.md):**
  - "Recomputed after every run": on default-branch runs only.
  - Churn as "commits in the last 90 days": on change gaps, it counts the base branch's last twelve commits that touched
    the file.
  - Age "reaches 1 at one year": it caps near 0.25.
  - "Priority of the tests near it": the tests that reach the node itself.
  - The detectors "read the canonical graph": their window holds every branch.
  - *Changed, unreached* "closes once a test reaches the file": not when accepted, and not for orphans.
- **[`uncovered-changes.md`](../apps/docs/features/uncovered-changes.md):**
  - "With a draft scenario to start from": the draft is empty.
  - "Build output and generated code" out of scope by default: `dist/`, `.next/`, `.output/`, `*.gen.ts`, lockfiles
    and page objects are in scope.
  - The editors mark uncovered changes "by the same rule": their rule differs (§8).
  - "With no SCM token … nothing appears": a public repository is still read and its gaps written.
- **[`pr-feedback.md`](../apps/docs/features/pr-feedback.md):**
  - "Two things get posted": there is also the `change-coverage` status.
  - `onlyOnFailure` dropping the uncovered changes is not mentioned.
- **[`probes.md`](../apps/docs/features/probes.md):**
  - `stale-value` "replays an earlier response": it never applies.
  - "Retries off": at the top level only, and only with `wrapConfig`.
  - Probe runs "excluded" from the Test Map: their statuses feed trust (PB-9).
  - "Once noticed, the gap closes": it also closes on an inconclusive re-probe.
  - The fault classes are "allow-listed": only the first listed class is ever used.
  - Not mentioned: every Playwright project runs each planned test; `slow` depends on the expect timeout.
- **[`combined-coverage.md`](../apps/docs/features/combined-coverage.md):**
  - "Never a partial … run": narrowed runs count (CV-3).
  - The export writing undetermined lines as 0 hits is not mentioned.
  - *Files without coverage data* needing an upload's inventory, and counting non-code files, is not mentioned.
- **[`server-coverage.md`](../apps/docs/features/server-coverage.md):**
  - Run-level coverage accumulating for the process's lifetime is not mentioned.
  - A test whose collection failed is not always marked incomplete (CV-10).
- **[`css-coverage.md`](../apps/docs/features/css-coverage.md):** rules count in the project's Functions ratio too.
- **[`coverage-cost.md`](../apps/docs/reference/coverage-cost.md):** the modes table has no CSS row.
- **[`editor-coverage.md`](../apps/docs/features/editor-coverage.md):** "pages your tests visit": the code counts
  pages a locator acted on.
- **[`change-impact.md`](../apps/docs/features/change-impact.md) and `get_impacted_tests`:** `notRun` holds line
  numbers of the file before the change, presented as the lines a new test should cover.

## Appendix C. Measurements

- **The seeded demo's Test Map** (web-dashboard, 10 tests): 95 open gaps.

  | Detector | Gaps |
  |---|---|
  | *single covering test* | 24 |
  | *control nobody exercises* | 21 |
  | *success only* | 14 |
  | *declared, never hit* | 10 |
  | *reachable, unvisited* | 8 |
  | *assertion-light* | 4 |
  | *catalog method, no test calls* | 3 |
  | *not noticed* | 3 |
  | *not handled* | 2 |
  | *passed with errors* | 2 |
  | *surface drift* | 2 |
  | *unprobed dependency* | 2 |

  Factors and ranks are in the table of §4.4. One triage verdict is stored, so no detector's precision means anything
  yet **(seen)**.
- **The probe planner** over 90 simulated nights (200 tests, 133 routes, budget 50): 5 of 133 routes decisive after
  14 nights, all by night 83; 64% of probes never applied; 29% on routes already noticed **(run)**.
- **The `slow` fault**: 16 of 16 noticed at a 5 s expect timeout, each failing 0 to 19 ms after it; 3 of 3 not
  noticed at 10 s **(run)**.
- **The coverage scope** of this repository: 1,288 of 3,786 in-scope files are not code **(run)**.

## Appendix D. References

Beyond the references of [`scenario-gaps.md`](../adr/scenario-gaps.md#references):

- S. Eder, B. Hauptmann, M. Junker, E. Juergens, R. Vaas, K.-H. Prommer. *Did we test our changes? Assessing
  alignment between tests and development in practice.* AST 2013.
- M. Ivanković, G. Petrović, R. Just, G. Fraser. *Code coverage at Google.* ESEC/FSE 2019.
- C. Lewis, Z. Lin, C. Sadowski, X. Zhu, R. Ou, E. J. Whitehead. *Does bug prediction support human developers?
  Findings from a Google case study.* ICSE 2013.
- G. Petrović, M. Ivanković. *State of mutation testing at Google.* ICSE-SEIP 2018.
- G. Petrović, M. Ivanković, G. Fraser, R. Just. *Practical mutation testing at scale: a view from Google.* IEEE
  TSE, 2021.
- R. Niedermayr, E. Juergens, S. Wagner. *Will my tests tell me if I break this code?* CSED 2016.
- O. L. Vera-Pérez, B. Danglot, M. Monperrus, B. Baudry. *A comprehensive study of pseudo-tested methods.* Empirical
  Software Engineering, 2019.
