# Docs content audit: accuracy against the app, contradictions and redundancy

An audit of what the documentation site (`apps/docs/`) says, where [`docs-layout-audit.md`](docs-layout-audit.md)
audits where it says it. Three questions: does the site describe the dashboard and the tools as they are built, do
two pages say different things, and is the same thing explained twice. It ends with what the app itself could change,
seen while answering the first. State audited: `main` at v0.69.0 (`e3ddb84b`), 2026-11-14.

**Status.** Proposed 2026-11-14. Built, by the pull request that adds this audit, with the palette's tabs and the
Capabilities page's two strings (items 1 and 2 of [What the app could change](#what-the-app-could-change)) in a
pull request of their own:

- **Step 1 of [the plan](#the-plan), the corrections.** Every row of the S, T, C and D tables that is not marked
  **likely** or **unsure** is corrected in the page, the catalog or the registry it names, each checked in the code
  again before the edit.
- **Step 2, one owner per rule.** The CI merge gate has a page, `features/merge-gate.md`. Watch a run owns when a
  failing test is held and why a test stops; Watch a running test and Live view of a run what watching sends and
  keeps; Failure clusters the fingerprint and the cluster states; Flaky tests the score, the ranking and
  quarantine; Slow tests wasted time; What changed in a run the baseline; the test metadata reference how a result
  counts and which runs send no feedback; the coverage cost reference every mode's cost; the Production checklist
  the hardening list. Every other copy is a sentence and a link, and each recipe links the section it used to
  restate. `concepts.md` holds definitions of at most 80 words and went from 7,474 words to 3,487, every heading kept.
- **The rows the audit had left open**, settled in the code while their rule was consolidated: C1.1 (a headed run
  holds a failure only while Hold failures is on), C1.4, C1.5, C1.6, C1.9, C1.11, C1.12, T7, T8, C2.3, C2.4, C2.5,
  C2.7, C3.4, C3.8, C3.10, C3.13, C3.14, C3.15, C4.8, C4.11, C4.12, D10, D16, C5.7, C5.9, C5.13, C5.15, C5.16 and
  C5.17. Their rows below keep the wording of the audit; the pages say what the code does.
- **Step 4, the rules**: G2 to G8, in `docs-claims.test.ts` and `docs-drift.test.ts`, each seen to fail on a
  deliberate error. G1 and step 3 come with the palette's pull request, which adds the list of places they read.

What was not done is under [Left for later](#left-for-later).

**Summary.** The pages are careful one by one and unreliable as a set. Five readers found 70 places where two
passages disagree, about 60 where a page or the catalog disagrees with the app or its code, 58 explanations held in
more than one place and 49 terms used two ways. Almost none is a wrong idea; nearly all are a second copy that stayed behind when the first
moved. Four patterns produce them. Rules with no owning page (the CI gate, which runs are left out of pull-request
feedback, when a failure is held, why a test stopped) are restated on six to nine pages each. `concepts.md`, the
vocabulary page, also carries the rules, so every rule has two homes and the fingerprint, the cluster states and the
live-view limits have each drifted between them. Recipes re-explain the feature they should link. And the places of
the app are written by hand in three registries of their own: the UI overview, the catalog's `where` hints and the
Capabilities page's own copy, all three naming tabs the app does not have. The app has matching seams: its command
palette lists five of a project's seven tabs, four project pages sit behind one unlabeled menu, and the source
control token is set on the AI page.

**Method.** Every hand-written page was read in full, in five clusters, each by a separate reader that kept a ledger
of the claims that can conflict (numbers, versions, what needs what, names, defaults) and settled each disagreement
in the code. A sixth reader built the dashboard's structure from its routes, tab definitions and
`settings-metadata.ts` and checked the UI overview, the catalog and the 75 distinct dashboard paths the pages write
with an arrow. A seventh did the same for the tools: every command title of the two editor manifests, the
extension's strings, the desktop app's tray and menus, each looked up in the docs, and every bold label of the tool
pages looked up in the code. The dashboard was then started on the seeded data and its main pages walked in a
browser. Twenty-eight findings were checked again by hand against the page and the code; all 28 held, and they are
marked ✓. The others
carry their reader's reference and are marked **likely** or **unsure** where the code did not settle them. Line
numbers are those of the audited commit. Docs paths are relative to `apps/docs/`, `app/` and `shared/` to
`apps/application/`.

## The four patterns

**P1. A rule that crosses features has no owner.** Each feature page that the rule touches states its own part:

| Rule | Stated on | Drifted |
|---|---|---|
| The CI gate: what fails it, what warns, flags, exit codes | `guide/ci`, `reference/cli`, `pr-feedback`, `environment-incidents`, `uncovered-changes`, `leak-history`, `test-selection`, `flaky-tests`, `reuse-forecast` | C4.2, and three facts found only on a feature page |
| Which runs produce no pull-request feedback, issue or notification | `pr-feedback`, `issue-automation`, `probes`, `environment-incidents`, `reference/test-metadata` | C4.7 |
| When a failing test is held (Hold failures) | `concepts`, `editor-stop-code`, `editor-runs`, `desktop-runs`, `runs-window`, `terminal-runs`, `piwi-runner`, `write-run-fix` | C1.1 |
| Why a test stopped, and the run page's row | `watch-a-run`, `share-live`, `concepts`, `live-view`, `watch-all` | three reasons, six, and one wrong name |
| What Watch and the live view send and keep | `concepts`, `live-view`, `watch-all`, `runs-window` | C1.7 |
| The baseline | `concepts`, `run-changes`, `branches`, a recipe | C3.6, C3.15 |

**P2. `concepts.md` holds the rules as well as the words.** The docs guide makes it the vocabulary source of truth,
and each new term is added to it with its behavior. The fingerprint is 300 words there and 150 on Failure clusters,
with different lists of what a generic error is; the cluster states are 330 words there and 210 on the feature page,
which links back twice for the rule it lacks; the local frame limits of Watch exist only there. A definition belongs
in `concepts.md`; the rule belongs on the feature page it links.

**P3. A recipe restates what it links.** Cut costly flakiness repeats the quarantine rules (190 words) and the score
(90 words), and has drifted on both (C3.7, C3.8); Fix a broken locator repeats the pickers and gets the count of its
own routes wrong (C2.10). The docs guide already forbids it.

**P4. Absolute words go stale.** "Every outbound call", "sends one thing", "nothing else", "the others never reach
it", "each workflow skill", "they all provision", "at least one policy rule is required", "every page and tab":
eleven of the contradictions below are a sentence of this kind that was true the day it was written.

## Docs against the dashboard's structure

The UI overview claims "a map of the dashboard: every page and tab". Checked against the routes and tab definitions:

| # | The docs say | The app has | |
|---|---|---|---|
| S1 | Catalog: `where: 'Test run → Failures; Home'` (`shared/piwi-features.ts:224`) | No such run tab; clusters are a grouping of the Tests tab (`app/pages/test-runs/[id].vue:1345-1391`) | ✓ |
| S2 | Catalog: `'Project → Gaps'`, twice (`:460`, `:516`); `reference/gap-detectors.md:17` "on the Gaps tab" | Gaps is a view of the Coverage tab; `gaps` is a URL alias | ✓ |
| S3 | Catalog: `'Project → Timeline'` (`:232`) | Markers open from the Runs tab's Markers button; another entry writes it `Project → Runs chart → Markers` | ✓ |
| S4 | `features/ui-overview.md:52`: the More menu "holds Edit, Test functions, Selections, Import and Delete" | Edit, Test functions, Selections, Locators, Bug reports, Schedule a quality report…, Delete, Refresh; Import is a button of its own, beside Export and the bell | ✓ |
| S5 | `ui-overview.md:92-114`: run tabs Tests, Changes, Video, Timeline; Resources as a part of Timeline | Tests, Changes, Timeline, Video, and a Resources tab when the run sent a resource report | ✓ |
| S6 | `ui-overview.md:122`: the execution and the test case "can be exported" | The test case page has no export; run, execution and cluster do | |
| S7 | `reuse-forecast.md:11`, `test-selection.md:130,161`: "the project's **Selections** tab" | A page, reached from the More actions menu | |
| S8 | `ai-diagnosis.md:25`: "the project's Failure clusters tab" | The Failures tab, Clusters view | |
| S9 | `reference/test-metadata.md:117`: "a **Tree** view" on the run page | Group by: Cluster, File, File + Describe, Lock, None | |
| S10 | `ui-overview.md:71-76`: ten sections of a project's Settings, two under other names | Fifteen, in three groups; missing Status, Live view, Coverage, Keys in test tags, Test management | |
| S11 | `ui-overview.md:136-145`: the Settings pages | About is left out, and no page says how Settings is reached: there is no navigation item, only the user menu, the palette and `g s` | |
| S12 | `ui-overview.md:3`: "every page and tab" | Absent: the analytics dashboards routes, the bug report page and its four tabs, the test case tabs (Overview, Trend, Flakiness), the Selections, Test functions and Import pages | |
| S13 | `guide/first-failure.md:58`: eight evidence tabs "plus Attempts" | Ten; Output is missing | |
| S14 | `operate/capabilities.md:9`: presets and a four-step ladder | The page ends with "Off until turned on" (Run on my machine, Pass reuse), which `run-on-my-machine.md:23` points into | |
| S15 | `ui-overview.md:156`: the demo "adds three controls" | Four: Guided tour, Acting as, Simulate, Reset data | |
| S16 | `ui-overview.md:31`, `dashboards.md:12`: Analytics "is the built-in Overview dashboard" | It opens the viewer's default, else the instance's, else Overview. **likely** | |
| S17 | `assistant.md:101`: "**Features → Assistant**" | The row is "Assistant model" | |
| S18 | `slow-tests.md:30`: "**Network analysis**" | The section is "Slow endpoints", as two other pages call it | |

Also wrong or vague in the catalog's `where`: `'Test run → Environment'` (a line of the run header's Details that
opens a modal), `'Project → filter bar'` (the block is titled Filters), and four pages of the More actions menu
written as tabs (`Project → Selections`, `Project → Locators`, `Project → Test functions`) beside one written as the
menu (`Project → More → Bug reports`). Combined coverage and Coverage insights name no dashboard place although
their pages document one.

**What resolves.** Every instance `Settings → X` path in the docs leads to a real page or card. The eight rows of
"Where each concept lives in the UI", every label of the first-failure walkthrough and the evidence tab list of
`evidence.md` are right. No hand-written page names a removed tab; the stale names survive only in the catalog.

**One place, eight spellings.** A section of a project's Settings is written `Project → Settings → X`,
`Project → Settings → Integrations → X`, `project page → Settings → X`, a bare `Settings → X` that reads as the
instance's (`desktop.md:99`), "the project's **Settings → X**", "**Settings › X**" and "the **X** section of the
project's **Settings** tab". The menu is "More" on two pages and "More actions", its only label in the app, on one.

## Docs against the tools' structure

The names a reader types or looks for, checked against `apps/vscode/package.json`, the JetBrains `plugin.xml`,
`packages/editor/src/actions.ts`, the extension's `_locales/en/messages.json` and the desktop shell.

| # | The docs say | The tool has | |
|---|---|---|---|
| T1 | `tested-elements.md:42,52`: the panel's "three tabs" | Four: elements, tests, untested and At risk, which the page describes further down | ✓ |
| T2 | `editor-failures.md:109`: a button "**Open the run in the dashboard**" in the title bar or the toolbar | "Open the latest run" in VS Code, "Open in dashboard" in JetBrains | ✓ |
| T3 | `editor-failures.md:90`: "**Group by…** in the view's title bar" | VS Code: "Group the failures by…"; JetBrains: "Group by" | ✓ |
| T4 | `extension.md:26-27`, `pick-an-element.md:77,84`: "Assertion suggester", "Copy context for agent" | The popup's tiles are "Assertions" and "Agent context"; "Copy context for agent" is an editor action | ✓ |
| T5 | `tested-elements.md:33,99`: "**Heatmap**", "**Copy edit**" | "Heat map", "Copy the change" | |
| T6 | `editor-coverage.md:116`: "**Piwi: Show or hide the coverage marks**, under Tools → Piwi in a JetBrains IDE" | JetBrains: "Show coverage marks" | |
| T7 | `editor-recording.md:25`, with `:14` "needs no instance": Record a new test file "also in the explorer's **Piwi** submenu" | The submenu shows only while connected (`apps/vscode/package.json:1182`). **likely** | |
| T8 | `editors.md:23` and both store READMEs: "You need a Piwi instance … Recording needs none" | Runs by line and their pause and step need none either, as `editor-runs.md:23` says. **likely** | |

Also D1, D3 and D6 below, found by two readers each.

**In the tools and on no page.** The editors' Commands table (`editors.md:110-130`) leaves out about twenty palette
commands; six have no page at all, among them Pick a locator at the stop, Record at the stop and Assert a region at
the stop. The CI Runs view of VS Code and the CI run tab of JetBrains appear only on Watch a running test. Five
theme colors and the `piwi.hiddenMessages` setting are undocumented. The popup's keys `3` to `7` and `U`, and a row
for Replay a bug report in the extension's tool table, are missing. Four tray items of the desktop app (Open Piwi
Desktop, Open data folder, Show logs, Quit) and its macOS menu are not described; Open data folder is on no page.

**What resolves.** Every other title of the Commands table, all nine VS Code keybindings, the JetBrains settings
labels and tool window tabs, every setting key the docs name, every label of the Runs window, the pause bar's
buttons, the extension's permissions table and its shortcuts.

## Contradictions between pages

Each row is two passages a reader cannot both believe; the last column is what the code does.

### Local runs, editors, the desktop app and the live view

| # | Pages | The disagreement | The code | |
|---|---|---|---|---|
| C1.1 | `write-run-fix:59`, `editor-stop-code:107`, `runs-window:43` against `concepts:258` | A failing test is held "in a headed browser, or while the Runs window is open" against "only while Hold failures is on" | `concepts` is right (`packages/editor/src/run-sessions.ts:1255`); an open Runs window holds nothing | |
| C1.2 | `watch-a-run:40` against `local-runs-tray:23` | The tray "counts the lines of the run's output" against "as its own process counts its tests" | The second (`app/utils/desktop-run-view.ts:39`) | ✓ |
| C1.3 | `piwi-runner:44` against `piwi-runner:60` | The Runner's window shows "the run's output and **Stop**" against Pause, Step, Resume, Finish and Watch | The second | |
| C1.4 | `piwi-runner:69` against `run-on-my-machine:110` | Share live from Piwi Runner against a requested run shown "to nobody else" | A requested run gets no live-view key (`server/api/test-runs/setup.post.ts:92`). **likely** | |
| C1.5 | `editor-stop-code:129` against `terminal-runs:59` | Code from a pause in "runs Piwi started only" against the same actions in a run started in a terminal | The second. **likely** | |
| C1.6 | `editor-stop-code:27` against `runs-window:61,91` | Pick, Record and Assert "need the pause bar, so a headed browser" against the same at a watched headless stop | The second. **likely** | |
| C1.7 | `live-view:116` against `watch-all:52`, `live-inspect:85` | "4 MB of images and pages a second" against 4 MB of images and a separate 16 MB for pages | Images only (`server/utils/live-view.ts:98`) | ✓ |
| C1.8 | `end-the-test:21` against `editors:125` | "**Piwi: End the test here, skipping the rest of it**" against "End the test" | "End the test" (`apps/vscode/package.json:540`) | ✓ |
| C1.9 | `editor-run-control:45` against `end-the-test:39` | Ending the test interrupts a `waitForTimeout` against "finishes first" | The second. **likely** | |
| C1.10 | `desktop-runs:88` against `desktop-runs:127`, `runs-window:126` | A locator picked in a desktop run against Pick "not offered" | Both, for different triggers; neither names the trigger | |
| C1.11 | `local-runs-tray:75` against `watch-a-run:30` | A run for the team instance "links no Piwi run here" against "Run #78 · Open under each run" | The tray shows the link. **likely** | |
| C1.12 | `editor-breakpoints:77` against `terminal-runs:61` | Record here on `page.pause()` "in a run Piwi starts" against also in a followed terminal run | The second. **likely** | |
| C1.13 | `jetbrains:25` against `editor-connection:101` | The service starts "once it finds a Playwright config" against "when you open a file" | On a file opened; both true, read as disagreeing | |

### Piwi Picker, bug reports, locators and agents

| # | Pages | The disagreement | The code | |
|---|---|---|---|---|
| C2.1 | `extension:18` against `tested-elements:60`, `report-a-bug:108`, `replay-a-bug-report:28`, `devtools:99` | Only three tools reach the instance, "the others never reach it" against four other tools that use a connection | The four do (`apps/extension/src/shared/piwi-client.ts`) | |
| C2.2 | `guide/privacy:64` against `extension-connection:119`, `privacy:72` | Connected, Piwi Picker "sends one thing: a bug report" against the connect details, a URL pattern and a replay verdict | Four POSTs exist | |
| C2.3 | `devtools:47` against `extension:110` | For an iframe, "Use Pick an element there" against "the picker sees the top-level document, not iframes" | The second. **likely** | |
| C2.4 | `locator-healing:149`, `recipes/broken-locator:57` against `locator-healing:35`, `auto-heal:55` | Suggestions "need a passing run captured with the fixtures" against the diff rename, which needs none | The diff rename reads no snapshot. **likely** | |
| C2.5 | `recipes/broken-locator:24`, `locator-healing:3` against `reference/locator-stability:46` | The fix follows "the conventions already in your suite" against "the locator's own method, then its family" | Only the failing locator is read (`packages/core/src/locator-fix.ts:49`). **likely** | |
| C2.6 | `reference/steps-format:64` against `record-actions:25` | `redacted` means a password field against passwords, card numbers, security codes and one-time codes | The second | |
| C2.7 | `report-a-bug:25` against `record-actions:11` | Two lists of what the one recorder captures | One recorder, the longer list. **likely** | |
| C2.8 | `agent-skills:33` against its own table | "Each workflow skill ends by telling Piwi what the agent did" against three of six | Three (`packages/reporter/templates/skills/`) | ✓ |
| C2.9 | `extension-connection:133` against `:28`, `operate/api-keys:61` | Piwi Picker's key listed under API keys against under Connected apps | Connected apps | |
| C2.10 | `recipes/broken-locator:81` against `:101` | "Four routes that don't need it" against "This one does still depend on captured snapshots" | Three | |
| C2.11 | `agent-skills:11` against `mcp:18` | The MCP server gives "read access" against "tools, mostly read-only" and a list of write tools | It writes | |

### Failures, flakiness and AI

| # | Pages | The disagreement | The code | |
|---|---|---|---|---|
| C3.1 | `flaky-tests:144` against `concepts:167` | Newly flaky is "the first run in which the test was flaky" against "passed in the baseline with no failed attempt, flaky now" | The baseline rule (`server/utils/compute-regression-signals.ts:103`) | ✓ |
| C3.2 | `branches:74` against `concepts:158` | With no known default branch a view "reads every branch" against a chain that ends at `main` | Never every branch: the setting, the most common branch of the runs, then `main`; `concepts` omits two steps | ✓ |
| C3.3 | `flaky-tests:62`, `reference/clues:39` against `flake-lab:56`, `run-environment:37` | Six suspect factors against a seventh, the runner's time zone or locale | Seven (`shared/handlers/flake-profile.ts:529`) | ✓ |
| C3.4 | `flaky-tests:115`, `recipes/flaky-cleanup:57` against `concepts:481` | Quarantine changes the gate and the commit status, "nothing else" against its reach not counting as trusted in the Test Map | Both effects exist. **likely** | |
| C3.5 | `concepts:367` against `reference/clues:59`, `first-failure:40` | A lone clue is "the story" against "stands alone" | No combination, no story | |
| C3.6 | `recipes/regression-or-flaky:16` against `run-changes:17`, `concepts:138` | The baseline is "the last passing run on the same branch" against same environment first, then four more rungs | The ladder | |
| C3.7 | `recipes/flaky-cleanup:60` against `flaky-tests:119` | "One failure resets" the streak against "a failure or a pass on retry resets it, a skip does neither" | The second | |
| C3.8 | `recipes/faster-suite:73`, `flaky-cleanup:20`, `flaky-tests:96` | Three formulas for how flaky tests are ranked | `wasted × 0.7 + retry passes × 30 × 0.3`. **likely** | |
| C3.9 | `ui-overview:92` against `resource-leaks:87`, `cpu-memory-disk:70` | Resources inside Timeline against a Resources tab | A tab (S5) | ✓ |
| C3.10 | `resource-leaks:87` against `cpu-memory-disk:13,70` | The tab shows when the reporter "sent findings" against with every run's panel | Any resource report. **likely** | |
| C3.11 | `first-failure:58` against `evidence:53` | Eight evidence tabs against ten | Ten (S13) | |
| C3.12 | `concepts:360` | "Full detail: Failure clustering & AI diagnosis" links a page with that title no longer and no fingerprint section | The detail is `failure-clusters#how-failures-are-grouped` | ✓ |
| C3.13 | `failure-clusters:140` against `:107`, `concepts:394` | Diagnosis verified "sets an open cluster resolved" against a state "fixed and verified, still open" | Reachable only after a reopen. **unsure** | |
| C3.14 | `guide/ai-provider:9` against `fix-plans:11,74` | A provider "powers the Fixed before matches" against "none of it needs a model" | Deterministic first, semantic with an embedding model. **likely** | |
| C3.15 | `branches:60` against `concepts:151` | The visual-diff baseline "follows the same rule" against a shorter ladder | Shorter. **likely** | |
| C3.16 | `recipes/regression-or-flaky:28` against `concepts:167` | Newly flaky means "it isn't your change" against "stable in the baseline, flaky now" | Not settled. **unsure** | |

### CI, the gate, coverage and the Test Map

| # | Pages | The disagreement | The code | |
|---|---|---|---|---|
| C4.1 | `guide/source-control:94` against `pr-feedback:96` | Pull-request feedback posts "on GitHub and GitLab only" against also Bitbucket Cloud | Bitbucket Cloud posts (`server/utils/scm/BitbucketProvider.ts:505`) | ✓ |
| C4.2 | `reference/cli:133` against `guide/ci:251` | "At least one policy rule is required" against "or a warn-only flag" | A warn-only flag is enough (`packages/reporter/src/cli/gate.ts:57`) | ✓ |
| C4.3 | `code-reach:11`, `concepts:494`, the `coverage.server` JSDoc against `server-coverage:9`, `backend-logs:20` | Server coverage for ASP.NET Core against ASP.NET Core or Nitro | Nitro too (`integrations/nitro/src/coverage-runtime.ts`) | ✓ |
| C4.4 | `backend-logs:22` against `:11,103,147`, `scenario-gaps:138`, `probes:100` | The Nitro package is on "only when `NODE_ENV` is `development` or `test`" against "outside production" | An allow-list: unset or `staging` is off (`integrations/nitro/src/index.ts:201`) | ✓ |
| C4.5 | `test-management:15` against `operate/zephyr-scale:38` | An administrator binds the project against a Project admin | `project:manage` | |
| C4.6 | `guide/ci:109` against `guide/ci:273` | Shards merge "streamed or batched" against not when "streaming is off" | Batched shards merge | |
| C4.7 | `pr-feedback:17` against `issue-automation:82`, `probes:54`, `environment-incidents:67` | Four kinds of run get no feedback against seven | Seven (`shared/run-eligibility.ts:232`) | |
| C4.8 | `scenario-gaps:20`, `concepts:479` against `scenario-gaps:50`, `uncovered-changes:30` | Reach is "never from instrumented code coverage" against gaps and "Reached" that read coverage | Three detectors read coverage. **likely** | |
| C4.9 | `concepts:606`, `scenario-gaps:44` against `reference/gap-detectors:87` | Exposure is the score against exposure times the detector's confidence | The second | |
| C4.10 | `reference/gap-detectors:17` against `scenario-gaps:55` | The Gaps tab against the Coverage tab's Gaps view | Coverage (S2) | ✓ |
| C4.11 | `scenario-gaps:37`, `concepts:589` against `gap-detectors:24,42,45` | A blind spot is where "nothing reaches it" against detectors of that class on reached routes and functions | **likely** | |
| C4.12 | `gap-detectors:31`, `uncovered-changes:9` against `uncovered-changes:56` | Needs an SCM token against "a public repository is read without a token" | Not settled. **likely** | |
| C4.13 | `test-selection:155` against `change-impact:22` | One widening rule against three | `change-impact` is right | |

### Setup, self-hosting and reports

| # | Pages | The disagreement | The code | |
|---|---|---|---|---|
| C5.1 | `guide/privacy:15,19` against `operate/tracing:9` | "Every outbound call the server makes is listed below" against an OpenTelemetry export | Three destinations are missing from the list: the OTLP collector, a CI server, Zephyr Scale. All are opt-in | ✓ |
| C5.2 | `operate/database:39` against `operate/deployment:338`, `one-click-deploy:120` | "Several dashboard replicas" with PostgreSQL against "run a single replica" | One: the event bus is in-process | ✓ |
| C5.3 | `operate/deployment:369,373` against `snippets/docker-run.sh`, `deployment:107` | `docker run -p 8080:3000`, on every interface with authentication off, against "only once authentication is on" | The snippet is the rule | ✓ |
| C5.4 | `operate/upgrading:9` against `index:68`, `comparison:46`, `README:223` | "Patch and minor releases can carry breaking changes" against minor | Minor (`release-please-config.json`) | ✓ |
| C5.5 | `guide/reporter:108`, the reporter README against `reporter:135` | A config option wins over the environment "except `PIWI_VERBOSE`" against `PIWI_DESKTOP_APP` overriding its option | Two exceptions (`packages/reporter/src/internal/config/env.ts:471`); the generated Reporter options page says one too | ✓ |
| C5.6 | `guide/reporter:70,86` against `:64` | "The capture options `wrapConfig` would set" includes `video` against screenshot and trace | Screenshot and trace | |
| C5.7 | `operate/api-keys:122` against `guide/reporter:213` | The reporter signs in "before each upload" against "once per run" | Closer to once per run. **likely** | |
| C5.8 | `one-click-deploy:10`, `deployment:94`, `authentication:62` against `one-click-deploy:40,96` | The templates "all provision" a volume and the setup token against Koyeb's ephemeral disk and Fly.io's manual token | The exceptions | |
| C5.9 | `README:127` against `guide/reporter:42,70` | By hand, "one reporter entry" against `wrapConfig` as the setup and the bare entry as the fallback | The root guide sides with `wrapConfig`. **likely** | |
| C5.10 | `README:98`, `DOCKER_HUB:28`, root `AGENTS.md` against `database:19`, `upgrading:24` | The database is created "on the first request" against at boot | At boot | |
| C5.11 | `timeline-markers:34` against `analytics:163` | Analytics charts "draw the markers too" against only three kinds across projects | The second | |
| C5.12 | `production-checklist:40` against `share-links:11` | A share link shows "the execution or cluster" against four things | Four | |
| C5.13 | `project-access:54`, `authentication:17` against `project-access:65`, `README:161` | Only an administrator creates a project against a first upload creating it | Both, by different routes; read as disagreeing. **likely** | |
| C5.14 | `guide/license:9,41` against `README:266` | Four FSL parts against six, with the editor extensions | The README (also Piwi Runner and `packages/editor`) | |
| C5.15 | `privacy:28` against `notifications:45` | Slack and webhooks "only for subscriptions you create" against a report schedule with no subscription | **likely** | |
| C5.16 | `privacy:101` against `storage:179` | A trace "stored as uploaded" against "split and compressed" | Not settled. **unsure** | |
| C5.17 | `README:166` against `guide/reporter:19` | "A Node version Playwright supports" against Node.js 20 or later | **unsure** | |

C5.3 and C5.1 are the two to fix first whatever else waits: the first shows a command that publishes an open
dashboard, the second is the page operators read to decide what leaves their network.

## One page against the code

| # | The page says | The code | |
|---|---|---|---|
| D1 | `devtools:119`: "Press **Esc** or `V` again to turn it off" | No `V` key exists (`apps/extension/src/content/playwright-view.ts:300`) | ✓ |
| D2 | `share-live:94`: "a step or **Run to here**" | No tool has that name; it is Run to the cursor | ✓ |
| D3 | `editor-connection:36`: "**Copy MCP Server Configuration**" | "Copy the MCP server configuration…" | |
| D4 | `editor-runs:105`: `4/9 · 1 failing · your run` | `Piwi: run #124 · 4/9 · 1 failing · yours` | |
| D5 | `agent-skills:28`: each skill "falls back to the dashboard UI" | Two fall back to the CLI; `setup-piwi` uses no MCP tool | |
| D6 | `extension-connection:52`: the desktop app's "**Connect Piwi Picker**" | The card is "Pair with Piwi Picker" | |
| D7 | `reference/keyboard-shortcuts:119`: the element picker's keys, without Enter | Enter picks | |
| D8 | `extension:85`: three uses of the `debugger` permission | A fourth, the viewport set in the tab | |
| D9 | `extension-connection:119`: what the extension downloads | Also the project menu, bug reports and recent runs | |
| D10 | `coverage-insights:9`: needs backend instrumentation | Browser coverage is enough. **likely** | |
| D11 | `ui-overview:52`: the More menu | S4 | ✓ |
| D12 | `privacy:138`: "the only things there that open a socket" | Four more clients (C5.1) | |
| D13 | `PIWI_SHARE_LINKS_ENABLED` in the registry: "for executions and failure clusters" | Reports and dashboards too | |
| D14 | `deployment:100-121`: the compose service `piwi-dashboard` | The shipped file names it `piwi` | |
| D15 | `reference/cli:3,21`: the command list | Omits `mcp`, and `plan` in the description | |
| D16 | `environment-incidents:80`: "41 tests, 41 failed" beside "41 of 44 tests failed" | One sample, two totals. **unsure** | |
| D17 | `guide/source-control:73`: the fine-grained GitHub permissions | The commit status may need one more. **unsure**: check GitHub's documentation | |

## The same thing explained twice

The owner is the page that should hold the explanation; the others keep one line and a link.

| What | Copies (words) | Drifted | Owner |
|---|---|---|---|
| The CI gate | nine pages, about 1,300 | yes | a new feature page for what it decides; `reference/cli#gate` for flags and exit codes |
| Hold failures | `concepts` (195), `editor-stop-code` (286), `editor-runs` (92), `desktop-runs` (79), four more | yes | one page of the run-control group |
| What the live view sends and keeps | `concepts` (403), `live-view` (418), `watch-all` (252) | yes | `live-view`; `watch-running-test` for local Watch |
| Under the image, Open the trace so far | `runs-window` (97) and `desktop-runs` (94), near-verbatim, restating `watch-running-test` (270); `concepts` (300) | facts only in `concepts` | `watch-running-test` |
| Stop reasons | `watch-a-run` (273), `share-live` (123), `concepts`, two one-liners | yes | `watch-a-run` |
| Pairing with the editor | `editor-recording` (281), `editor-pairing` (169) | no | `editor-pairing` |
| Fingerprint | `concepts` (300), `failure-clusters` (150) | yes | `failure-clusters` |
| Cluster states | `concepts` (330), `failure-clusters` (210) | wording | `failure-clusters` |
| Quarantine and the flaky score, in a recipe | `flaky-cleanup` (280) against `flaky-tests` | yes | `flaky-tests` |
| Suspect factors | `flaky-tests` and `flake-lab`, one table each | yes | `flake-lab` |
| The Next line | `first-failure` (150), `fix-plans` (260) | no | `fix-plans` |
| Coverage modes and their cost | `coverage-cost`, `code-reach` (310), `server-coverage`, `css-coverage` | no | `reference/coverage-cost` |
| Pass-reuse planning; selection flags | `reuse-forecast` and `test-selection` against `reference/cli`, 300 and 220 | no | the CLI page for flags |
| Zephyr binding | `operate/zephyr-scale` (400), `test-management` (200) | yes | the operator page for settings |
| Narrowing an ambiguous locator | `pick-an-element` (150), `lint-overlay` (180), `locator-stability` (80) | yes | `pick-an-element` |
| Brittle locator | `tested-elements` (175), `locator-stability` (250), `concepts`, `locator-usage` | yes | `concepts` for the word, `locator-stability` for the rules |
| The debugging bar | `report-a-bug` (150), `mock-requests` (105), `replay-a-bug-report` (75) | yes | `extension`, Permissions |
| The failing test and `test.fail()` | `report-a-bug` (130), `bug-reports` (155), two different samples | unexplained | `bug-reports` |
| Reporter setup | Getting started (450), Reporter (350), the reporter README (330), `README` (200) | yes | Getting started for `init`, Reporter for the manual way |
| The hardening list | Production checklist (450), `README` (130), `DOCKER_HUB` (110), Authentication (90) | yes: two different "three things" | Production checklist |
| The host allowlist with authentication off | Authentication (120), Deployment (110), three shorter | no | Authentication |
| Secrets at rest | Privacy (130), Production checklist (110) | example lists | Privacy |
| Installer table and the unsigned note | `desktop`, `piwi-runner`, identical | no | a snippet |

Pages a reader cannot choose between:

- **Watch a run, Watch a running test, Live view of a run.** Each opens with a table of where to look. Watch a
  running test, "on your machine" by its own description, spends 312 words on CI runs.
- **AI diagnosis against Failure clusters, AI provider and Fix plans.** AI diagnosis opens on clustering; its first
  section is Semantic merging, and Split a cluster by hand, which "needs no AI", is on it. Feature behavior
  (auto-diagnose order, streaming stages, usage and quality) sits on the setup page.
- **Report a bug, Replay a bug report, Bug reports.** Run with Playwright is explained on Bug reports and started from
  Replay; sending is on two of them; all three carry the same chip although Bug reports needs an instance.
- **Authentication, Access, roles and groups, API keys.** "Roles" is a section on two of them, and three other pages
  link Authentication when they mean project roles.
- **Desktop app, Desktop app runs, Local runs tray.** Hold failures, Stop, Run again and Watch are split over all
  three, and a reproduction the app starts is documented on Runs started outside Piwi.
- **Slow tests & wasted time** has no text on wasted time; the only explanation is in a recipe.

## Words used two ways

| Word | Meanings found |
|---|---|
| the gate | "merge gate", "CI gate", "CI merge gate"; and a reporter option group headed "CI gate" that holds an unrelated Playwright option |
| watch, live view | following a run's progress; a worker's page images locally; the team instance's feature. "Live view" is used for local Watch on three pages |
| tray | the system tray and the in-window Local runs tray, in one paragraph of `desktop.md` |
| stop | a test waiting at a call, and the button that ends the run's process |
| share | Share live and Share with Playwright tools |
| On your machine | the run page's card for a desktop run, and the mark of a requested run |
| run | a test run, one run of a test, a Flake Lab repetition, a verification repetition |
| environment | six things, from the run's label to the flaky class that means one browser |
| wasted | waits only; waits plus failed attempts; retries times the average failed duration |
| coverage, reach | `concepts` says the docs "say observed reach rather than coverage"; the feature is Uncovered changes and the tab is Coverage. Code reach is the browser capture on three pages and the file-level view of both sides on one |
| watch, could break | one stability level under two names: the dashboard says Watch, the extension "could break", and no page bridges them |
| diverged | the dashboard's word for the extension's "Could not reach the bug" |
| picker | five things, from the extension to the trace viewer's tool |
| dashboard | the web app, a saved analytics dashboard, and a hosting provider's console |
| report | quality report, run report, offline export, bug report, blob report |
| test case | used for an execution in `reference/test-metadata.md`, against `concepts` |
| failure cause | failure cluster, in the analytics pages, never defined |
| project | a Piwi project, a Playwright project, and the reader's repository; the reporter option `projectName` and the metadata field `projectName` are different things |
| integration | an issue tracker connection, a backend package, and a group of a project's Settings that includes CI |
| exposure, class, finding, baseline, verified, Performance, Timeline | each two to six senses |

## Checked and found consistent

The readers verified these across every page that states them, against the code: the gate's exit codes and
quarantine exclusions; the flaky score, its windows and thresholds; the suspect thresholds; the baseline ladder; the
environment-incident thresholds; the AI defaults and limits; the team view's frame rates, sizes and viewer limits;
the Playwright, Node, IDE and browser versions each tool needs; the steps-file limits; the auto-heal defaults; the
environment variable defaults against the registry; port 3000 and the image names; the session, sweep and schedule
timings; the role each action needs against the permission grid; what `init` does on five surfaces; the license
terms on five surfaces. The numbers are right. What drifts is prose.

## What the app could change

Seen in the code and, where marked **(seen)**, in the running dashboard on the seeded data.

1. **The command palette lists five of a project's seven tabs.** `app/layouts/default.vue:376-383`, under the comment
   "Same order as the project page's tab strip", has no Flake Lab and no Coverage. ✓ Build it from the page's own tab
   list.
2. **The Capabilities page names tabs that do not exist.** `app/utils/setup-capabilities.ts:211`: "Add a marker from
   a project's Timeline tab"; `:220`: "from the project's Quarantine tab". ✓ The same stale names as the catalog (S1
   to S3): one list of places, read by the page, the palette, the catalog and this copy, ends all four.
3. **Four project pages sit behind one icon-only menu** **(seen)**: Test functions, Selections, Locators and Bug
   reports are reached only through the ⋮ button, and none is in the palette. `/bug-reports` alone answers "Page not
   found". Three of them are catalog features with a docs page each.
4. **Settings has two names and no navigation entry** **(seen)**: the sidebar's button reads "Configuration" with
   authentication off, the page and its breadcrumb read "Settings", and every docs page writes `Settings → X`.
5. **The source control token is set on the AI page.** `Settings → AI → What the model receives → Repository access
   token` ✓; the Source control capability links `/settings/ai`. Pull-request feedback, auto-heal, uncovered changes
   and bisect need it and no AI. A Source control page, or the field on the Pull requests page, would shorten
   `guide/source-control.md` by its four-step path.
6. **Export is two features.** A project's Export button builds a quality report ✓; Export on a run, an execution
   and a cluster is the offline export.
7. **A capability has up to three names.** `integrations` is "Issue tracking" on the Capabilities page and
   "Integrations" in Settings; `test-map` is "Scenario gaps" and the tab is Coverage → Gaps; `flake-lab` is "Flake
   suspects" and the tab is Flake Lab, with two different docs targets; `pr-feedback` is "Pull-request feedback" and
   the page is "Pull requests".
8. **Scenario-gap settings are under a project's Capabilities section**, while a Coverage section exists and the
   gaps show on the Coverage tab.
9. **Companion tools lists six tools and not Piwi Runner** **(seen)**: Piwi Picker, the desktop app, the reporter
   CLI, the MCP server and agent skills, the editor extensions and Open in editor. The user menu calls the same page
   "Piwi tools". It is the app's own list of what [`docs-layout-audit.md`](docs-layout-audit.md) proposes as the
   Tools section, and that section should carry its name and its order.
10. **Run tab addresses do not match their labels.** `?tab=workers` is Timeline and `?tab=test-cases` is Tests;
    `?tab=timeline` falls back to Tests, while the project page accepts its old names.
11. **One word, several places.** Timeline is a run tab, an evidence tab and the markers panel; Performance is a
    project tab, a Settings page and an evidence tab; Capabilities, Integrations and Coverage each name a place in
    the instance's Settings and another in a project's.
12. **Long lists** **(seen)**: 21 Settings pages, 15 sections in a project's Settings, 10 evidence tabs, 8 queues in
    Home's failure inbox.
13. **The product is grouped twice.** The catalog groups 102 features by job (keep the history, explain the
    failures, hand back a fix, find what the tests miss). `shared/capabilities.ts` groups 26 capabilities into four
    presets (See why tests fail, Triage as a team, Fix faster, Let agents in). The Capabilities page shows the second
    and the landing page the first, and neither maps onto the other: the Test Map is a job in one and part of
    "Triage as a team" in the other.

In the tools, from the code:

14. **One action, four names.** Recording at a stop is "Record here" on the pause bar, "Record at the stop" as an
    editor action, "Record" in the Runs window and the JetBrains inlay, while "Record here…" is another action.
    "End the test" is "End test" in two places. The docs cannot use one name for what the tools call four.
15. **The two editors name and split the same things differently.** The coverage toggle is "Show or hide the
    coverage marks" and "Show coverage marks"; VS Code has one "Run options…" where JetBrains has "Run headed" and a
    Hold failures action; grouping is a palette command in one and an unregistered toolbar drop-down in the other,
    absent from Tools → Piwi and from the keymap search.
16. **Commands that only their descriptions tell apart.** Reload Piwi, Refresh the latest run and Restart the editor
    service; Open in dashboard, Open the latest run, Open the run page and Open the run in progress.
17. **Surface size.** 60 palette commands in VS Code; 53 actions under Tools → Piwi, 23 of them in Run control.
18. **A tile and its panel have different names** in Piwi Picker ("Assertions" opens "Suggested assertions", "Agent
    context" opens "Context for an AI agent"), and the DevTools toolbar says "Pick" and "Lint" for Pick an element
    and Lint overlay. The same list is "Project mappings" in the extension's settings, "Browser extension URLs" in a
    project's Settings and "URL patterns" in the docs.
19. **The settings section "Send to editor" also gates the Runs window**: its heading names one of its two uses.
20. **Piwi Runner names one setting twice**: "Run in background" in its tray, "Keep running in the tray when the
    window closes" in its window.
21. **The popup's docs link is `https://piwitests.dev/extension`** ✓, which reaches the page only through the
    redirect table; the manifest's `homepage_url` uses `/features/extension`. VS Code has a walkthrough and no
    documentation command, JetBrains a Documentation action and no walkthrough.

## The plan

**Step 1: the corrections, one pull request.** The rows marked ✓ and the certain ones: about sixty edits of a line
or two, each with the code reference above. C5.3 and C5.1 first. It includes the four catalog `where` strings and
the two lines of `setup-capabilities.ts`, since they are the same error.

**Step 2: one owner per rule (P1, P2, P3).** In this order, since each removes the most copies: the CI gate, which
[`docs-layout-audit.md`](docs-layout-audit.md) also asks a page for; Hold failures and the stop reasons; what the
live view sends; the fingerprint and cluster states out of `concepts.md`; the recipes cut back to links. A copy is
replaced by a sentence and a link, and the owner gains the facts only a copy held. This shortens about thirty pages
that are at their word budget.

**Step 3: places come from the app.** One shared list of the dashboard's places (project tabs and their views, run
tabs, the More actions pages; the Settings pages already have `settings-metadata.ts`), read by the project page, the
palette, the Capabilities copy and the catalog's `where`, and by the drift test, which then fails on a path in the
docs that names no place. The UI overview keeps its prose and loses the right to be wrong about a tab.

**Step 4: the rules below**, the checks first.

**For the app, your call:** items 1, 2 and 21 are bugs and belong to step 1 or 3. Items 3 to 8, 10 and 14 to 20
change what people see; 14 and 15 would let one docs sentence serve both editors. Item 13 is the same decision as
the layout audit's second: how many groupings the product has.

## Rules that would keep it this way

Proposed, not added: the root guide is at 19,847 of its 20,000 characters and the docs guide at 26,491 of 30,000, and
a sentence in a guide is read before every edit in its area. So a rule here is a check wherever one can be written:
its failure message is the instruction, and it costs a reader nothing until it fails. Eight checks, about 200 lines
in `docs-drift.test.ts`, and two sentences in the guides, one of which replaces another.

| # | Rule | Form | What it would have caught |
|---|---|---|---|
| G1 | **A place named in the docs or the catalog exists.** One list of the dashboard's places (a project's tabs and their views, a run's tabs, the pages of More actions), read by the project page, the palette and the Capabilities copy; the drift test resolves every `where` of the catalog and every `A → B` dashboard path in a page against it and `settings-metadata.ts`. | a module and a check | S1 to S12, the palette's missing tabs, the two stale strings of the Capabilities page |
| G2 | **A count is checked or not written.** A number before "tabs", "views", "tools", "skills", "routes", "sections", "factors", "controls" or "commands" either appears in a table that ties it to the length of a list in the code, or fails. It extends the check that already keeps the MCP tool count on one page. | a check | T1, S15, C2.8, C2.10, C3.11 |
| G3 | **A quoted command exists.** Every `**Piwi: …**` in a page is a title in `packages/editor/src/actions.ts`, which a test already holds both editor manifests to; every bold label on a Piwi Picker page is a string of its `messages.json`. | a check | C1.8, D2, D3, T2 to T6 |
| G4 | **A page's chips are its catalog entry's needs.** | a check | the fifteen feature pages with no chip, and two with a partial one |
| G5 | **A shared rule has one owner.** A table of about eight rules that cross features (the gate, Hold failures, the baseline, the fingerprint, quarantine, the runs left out of feedback, the live view's limits, the stop reasons), each with its owning page: a page that names one and is not its owner links the owner. | a check, and one sentence in the docs guide | P1: the nine copies of the gate, C1.1, C3.6, C3.7, C4.7 |
| G6 | **`concepts.md` defines, the feature page explains.** Each term's entry is at most 80 words. | a check; the guide's sentence "A new term goes into `concepts.md`…" gains "its definition only" | P2: the drifted fingerprint, cluster states and live-view limits |
| G7 | **A recipe states no figure.** No digit outside a code block on a `recipes/` page: a threshold or a formula is on the feature page the recipe links. | a check | P3: C3.7, C3.8, C2.10 |
| G8 | **The privacy page lists every destination.** Each variable of the environment registry that names a host Piwi calls is named on `guide/privacy.md`. | a field on about ten registry entries, and a check | C5.1, D12 |

G5 and G6 go in after step 2 has given each rule its owner; the others can go in with step 1.

**The one habit no check replaces**, as eight words added to a sentence the root guide already has ("Update the
affected doc in the same commit"): *search `apps/docs` for the label, number or default you change*. Most of the 70
contradictions are a second copy nobody looked for.

**Not proposed.** A list of banned absolute words ("every", "only", "nothing else"): too many true uses. A review
agent on every docs change: its cost is paid on every change, and G1 to G8 catch what it would. Generating the UI
overview from the app: G1 holds its facts and leaves its prose.

## Left for later

- **Three rows are not settled**: C3.16 (whether "newly flaky" clears your change), D17 (whether a fine-grained
  GitHub token needs one more permission for the commit status: GitHub's documentation decides, not this code) and
  S16 (which dashboard Analytics opens on).
- **The parts of the tools no page describes**, listed under [Docs against the tools' structure](#docs-against-the-tools-structure):
  about twenty editor commands, the CI Runs view, five theme colors and one setting, Piwi Picker's popup keys, four
  tray items of the desktop app.
- **Two pages hold two subjects** and are at their word budget; each split needs a catalog entry: the failure inbox
  out of Failure clusters, and CI runs in your editor out of Watch a running test.
- **The UI overview** claims its main pages and tabs and still leaves out the analytics dashboard routes, the bug
  report page and the test case's tabs.
- **Words used two ways.** The consolidation unified the ones it rewrote ("live view" and Watch, the two trays, the
  gate's name, failure cluster). The others in that table stand, and two need the app to move: the analytics
  metrics and targets say "failure cause" (`shared/analytics/metrics.ts`, `targets.ts`, `insight-rules.ts`), and one
  stability level is Watch in the dashboard and "could break" in Piwi Picker.
- **What the app could change**, items 3 to 21, and two links: the Companion tools card links the gate at
  `guide/ci#blocking-a-merge`, which works and is no longer its page, and Piwi Picker's popup links its docs through
  the redirect table.
- **Comments the code contradicts**: `packages/editor/src/protocol.ts:1763` on what a terminal run names; the Nitro
  integration's "outside production" (`integrations/nitro/src/index.ts`, `manifest.ts`, `environment.ts`), where the
  rule is an allow-list; the root guide's "on the first API call" for a database created at boot.
- **What the rules do not see.** G2 reads a count only before one of nine nouns ("Piwi ships seven" passes). G3
  checks editor commands, not Piwi Picker's labels, which nothing in the syntax tells from emphasis. G7 lets a number
  open a heading or a list item. G8 knows the destinations a variable names and two listed by hand, not those set
  in the dashboard, such as a webhook's address.
- **`npm run knip` fails in a fresh session** until `npx nuxt prepare` has run in `apps/runner`.
- **Not audited**: whether the screenshots and videos still match the UI, the in-app help text, the blog post, the
  READMEs of the three backend integrations, and the prose of the generated reference pages beyond spot checks.
- **No GitHub issue** was opened for a finding: most are decisions.
