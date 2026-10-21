# Simpler screens around tests — a UI plan

- Status: accepted
- Date: 2026-09-04

**Status:** shipped — PRs #442–#456 merged on 2026-09-04, the sweep (#459) open for review; delivery record at the end of §11 · **Scope:** every dashboard screen a developer meets between "the run is red" and "the fix is verified" — the execution page, the failure cluster page, the run page, the project page, the test history page, home and the lists that connect them · **Date:** 2026-09-03 · **Builds on:** [`failure-experience-audit.md`](failure-experience-audit.md)

This plan is the UI half of the failure audit. The audit fixed *what the dashboard knows* about a red run: the one-line headline, the clues, the failure timeline, the three-state empty cards, the fix plan, the loop-closing rules (all shipped, see its §7). It left one big bet open that is entirely about the screen — **L, one investigation page with a fixed reading order** — and two more that need a place to land: **D** (the failure inbox) and **E/F/J/K**, which each add one more block to the investigation. This document designs L for every page around tests, prepares the places for D–K, and removes what the audit's additions made redundant: the same fact is now shown three times on the execution page, and the run page has seven tabs that answer overlapping questions.

Every finding marked **(seen)** was observed on a seeded instance (`npm run app:seed:dev`, Chromium at 1280 px and 390 px, 2026-09-03, `v0.26.1`); the rest comes from the code, with a file reference.

---

## 0. The idea in one paragraph

Each page becomes **one column, read top to bottom, in the same order everywhere**: *what happened* → *why* → *the evidence* → *what to do* → *the history*. The page header states the object and offers one primary action. Evidence lives behind **one tabbed card** instead of ten stacked cards; nothing important starts folded, nothing is folded by a cookie. Every concept has **one name**, every action has **one home**, every list row is **the same component**. Page-level tab strips shrink to what fits at 1280 px: none on the execution page, three on the run page, five on the project page.

---

## 1. What was seen

### 1.1 The execution page (`/test-run-cases/37`, failing) **(seen)**

- **Three screens before the screenshot.** Default first screen: the pinned summary (title, four stat tiles *Duration / Attempts / Steps / Worker*, slowest step, wasted time, a two-row metadata strip) then the tab strip, then the headline card. The screenshot is at 2 000 px; fully expanded the page is 4 200 px tall (`app/pages/test-run-cases/[id].vue:631-778`).
- **The same fact three times.** *New regression* is a badge in the summary, a badge in the headline, and a chip in the *Regression status* card. The strongest clue is printed in the headline ("The one clue") and again as the first row of the *Clues* card below it. The cluster appears in the headline's fact row ("Same failure in 1 other test") and in a *Failure cluster* card in the right column, with its AI verdict, its triage note and two buttons (`TestCaseHeadlineCard.vue:70-79`, `CluesCard.vue`, `FailureClusterCard.vue`).
- **Fourteen cards, two columns, one jump-chip row.** Headline, Clues, Error, Failure timeline, jump chips, then a 3:2 grid — Test source, Failure evidence, Alternative locators, Environment diff, Visual diff, Console, Network, App state, ARIA snapshot, DOM snapshot on the left; Regression status, Failure cluster, Blocked tests, AI diagnosis on the right. Two of them say *nothing applies* ("Not a locator problem", "The environment is identical") and still take a card each.
- **Five page-level tabs.** Diagnosis, Steps (5), Artifacts, Performance, History (20). *Artifacts* repeats the console, network and app-state cards from Diagnosis; *History* repeats the chart and table of `/test-cases/:id` and links back to it (`[id].vue:1299-1364`).
- **The AI column when no provider is configured** is a dashed placeholder — 40 % of the width for "Configure in Settings" (`TestCaseAiCard.vue:251-264`).
- **At 390 px** the summary alone is a full screen (four tiles, two facts, metadata), followed by a *Hide summary* button and a *Diagnosis ▾* select before the headline.

### 1.2 The failure cluster page (`/failure-clusters/10`, fix verified) **(seen)**

- **One open card and seven folded headers.** The fix plan opens; Error message, Alternative locators, Environment diff, Visual diff, DOM snapshot, Test evidence and What changed are folded to one line each (`app/pages/failure-clusters/[id].vue:305-487`, `CollapsibleSectionCard.vue:29`). A first-time visitor sees a list of headings.
- **The right column is empty** without an AI provider — and a diagnosis that *was* stored disappears with the provider, because the result is rendered inside the `configured` branch (`DiagnosisPanel.vue:338-547`).
- **Triage is a separate card** with three stacked buttons and a note box; the fix verification badge and sentence sit in the summary; nothing on screen explains why *Fix verified* and *Open* can coexist.
- **Duplicates:** *Re-run in CI* twice (`FixPlanCard.vue:278-288`, `[id].vue:416-427`); the recommended locator in the fix plan **and** in the locator panel; the patch block implemented twice (`DiagnosisResult.vue:570-611`, `FixPlanCard.vue:133-169`); the diagnosis category in eight places; four header buttons in the diagnosis column (History, Copy prompt, Show context, Re-diagnose).
- **Extract**, the only bulk action, is a warning-coloured button in the *Test evidence* header whose label does not say what it extracts.

### 1.3 The run page (`/test-runs/2`, 3 failures) **(seen)**

- **Seven tabs do not fit at 1280 px:** *Executions (1…*, *Insigh…*, *Failure clusters (…*, *Since last pa…*, *Timeline (…*, *Compa…*, *Slow endpoints (…*. Four of them answer "what changed?" against three different baselines (`RunInsights.vue:157`, `RunCompare.vue:80-89`, `/regression-context`).
- **The header spends its first 300 px on counts.** Five tiles (Total / Passed / Failed / Skipped / Didn't run), then the same counts as a stacked bar, then Duration / Avg / P90 / Wasted, then two rows of metadata. Roughly 55 interactive controls before the first test row (`RunSummary.vue:373-613`).
- **Badges crush the title.** A failing row carries NEW, `@fixme`, Critical, `@smoke`, `@critical`, `@regression`, owner, feature and *Cluster #1*; the title is cut to "shoul…" (`TestCasesList.vue:639-687`, `TestRowBadges.vue`).
- **The clusters tab overflows horizontally** (the *Actions* column is off-screen at 1280 px) and each row has three equal buttons — *Show failing tests* (filters in place), *Diagnose* (a modal that renders a degraded diagnosis panel), *View* (navigates) (`FailureGroups.vue:216-244`).
- **Tree view** is a second rendering of the same rows with no column sort, no virtualization and a disabled *Collapse all* under filters (`TestCasesTree.vue`).

### 1.4 The project page (`/projects/1`) **(seen)**

- **Nine to eleven tabs**, truncated at 1280 px to *Test ru… · Test … · Co… · Failure c… · Flak… · Quar… · Spec … · AI … · Perfor… · Timel…* (`app/pages/projects/[id]/index.vue:210-268`). *Members* is the eleventh.
- **Six navbar buttons** (Delete, Import, Test functions, Selections, Edit, Refresh) plus the bell.
- **No status line.** The page opens on a filter row and a chart; the project's condition (latest run, pass rate, open clusters) is on Home's table but not here.
- **Compare exists five times** (Compare tab, *Run comparison* card in Performance — a verbatim copy sharing the same refs — "Compare selected runs" from the table, `/projects/:id/compare` redirect, the run page's own Compare tab). *Full runs only* has three implementations with three persistence policies. The *Spec health → test cases* drill-down passes `?file=` which nothing reads (`ProjectTestCasesTable.vue:49-60`).
- **The test cases table** stacks four lines of badges under a title truncated to "should valid…" at 1280 px.

### 1.5 Around them **(seen)**

- **Home**: five numbers that are not links ("5 failing now"), a project table, recent activity, and — on an empty instance — four inert feature cards under the wizard.
- **Test history** (`/test-cases/1`): six tiles, a duration chart, a *Status history* strip that restates the chart's colours, a 20-row table with a *View* button per row.
- **Words**: one attempt of one test is called *Executions*, *cases*, *test cases*, *Test case*, *tests* and *test-run-cases* on the run page alone; the grouping is *Failure clusters* on screen and *failure groups* in the tab's URL; *verdict* means three things; a timed-out case reads *failed* in lists and *Timedout* in Compare.

### 1.6 In numbers

| Measure | Before (2026-09-03) | Target | After (2026-09-04, re-measured in #459) |
|---|---|---|---|
| Execution page: height to the failure screenshot, default state, 1280 px | ~2 000 px | ≤ 900 px (on the first screen at 1280 × 800) | ~810 px — header, headline, top clue and the Screen tab on the first screen |
| Execution page: page-level tabs / cards on the Diagnosis tab | 5 / 14 | 0 / 5 | 0 / 5 |
| Cluster page: sections folded on first visit | 7 of 8 | 0 | 0 |
| Run page: page-level tabs / controls before the first row | 7 / ≈55 | 3 / ≤ 20 | 3 / ≈20 |
| Project page: page-level tabs / navbar buttons | 9–11 / 6 | 5 / 2 + overflow | 5 / 2 + overflow |
| List row: badges before the title is truncated | up to 15 | 3 + `+N` | 3 + `+N` |
| Words for "one execution" on the run page | 6 | 1 | 1 |
| Fold-state cookies on these pages | ~20 | 0 | 0 |
| Clicks from Home to a failing execution | 2 (+ scrolling) | 1 | 1 to the failure cluster, 2 to the execution |

---

## 2. Rules the new screens follow

1. **One reading order everywhere**: *what happened* (headline) → *why* (clues, changes) → *the evidence* (one tabbed card) → *what to do* (fix, verify, triage) → *the history*. A block that does not fit one of these five slots does not exist.
2. **One column.** The right column is gone from the execution and cluster pages. Width is spent on the evidence, not on a placeholder for an unconfigured provider.
3. **Nothing important starts folded, and no first impression depends on a cookie.** Evidence tabs open by relevance (the top clue's citation, else the timeline, else the screenshot). Fold cookies are removed on these pages; the only persisted preferences are filters (URL query) and grouping (one cookie per list).
4. **A fact appears once.** The signal badges live in the headline; the cluster lives in the headline's fact row; the counts live in one bar.
5. **Badges are for exceptions.** *New regression*, *Passed on retry*, `@fixme`/`@skip`/`@slow`, *Quarantined*. Tags, owner, priority and feature are visible on hover and in the details, capped at three visible with a `+N` overflow in lists.
6. **One primary action per page, in the header; everything else in an overflow menu.** Execution: *Copy retry command*. Cluster: *Re-run in CI* (or *Copy retry command* when CI re-run is not configured). Run: *Copy retry command* on a red run, *HTML report* on a green one. Project: *Import*.
7. **Page-level tab strips fit at 1280 px without truncation** — at most five tabs with plain labels. Everything else is a content-level tab inside a card, a section, or a grouping option.
8. **A list row is one component.** Same row in the run list, the file grouping, the cluster grouping, the cluster's affected tests and the project catalog; the row click opens the object (no *View* column).
9. **Empty states say one of three things** — *not captured (enable X)*, *nothing happened*, *not applicable* — and never own a card of their own: they live inside the tab they explain.
10. **One name per concept** (§3). Labels come from one helper per enum; no raw enum values on screen.
11. **Mobile first stays a rule** (`apps/application/AGENTS.md`): every screen is checked at 390 px before it is committed; a single column is what makes that cheap. Below the `sm` breakpoint the page gutter is at most 8 px per side and a card adds at most 12 px of its own — the panel padding and the card padding no longer stack at their desktop values, so about 40 px of a 390 px screen come back to the content.

---

## 3. One vocabulary

Terms used by this plan and, after it ships, by the UI. Each is defined once here and reused as is; the docs' [core concepts](../apps/docs/guide/concepts.md) already define the first four.

| Term | Meaning | Replaces on screen |
|---|---|---|
| **Run** | One `npx playwright test` invocation, all shards merged | *Test run* in tab labels (kept in prose and breadcrumbs as *Run #N*) |
| **Test** | The identity of a test across runs (`/test-cases/:id`) | *Test case* as a column header or tab label; the page is titled **Test history** |
| **Execution** | One attempt of one test on one browser in one run (`/test-run-cases/:id`) | *case*, *cases*, *test case* (row), *test-run case* |
| **Failure cluster** (or **cluster**) | Executions that failed the same way | *failure group*, *signature* as a column header |
| **Headline** | The one-line explanation of a failure, built from the parsed error (shipped, audit A) | *verdict* (never shown on screen) |
| **Clue** | A deterministic, cited finding about a failure (shipped, audit C) | — |
| **Evidence** | Everything captured about an execution: screen, source, network, console, state, timeline | *Failure evidence*, *Test evidence*, *Artifacts* |
| **Locator fix** | The ranked replacement locators for a broken locator (the locator-healing feature) | *Alternative locators* |
| **Fix plan** | Diagnosis + patch + locator edits + failing tests + owner + verify command (shipped, audit) | — |
| **Diagnosis** | The AI's analysis of a cluster or an execution | *AI verdict*, *Diagnosis result* |
| **Triage status** | The human-set state of a cluster: *Open* / *Resolved* / *Ignored* | *Status* column, raw enum values |
| **Fix verification** | The machine-observed outcome: *Stopped failing* / *Fix verified* / *Regressed* | *Resolution* |
| **Status** (of an execution) | *Passed* / *Failed* / *Timed out* / *Skipped* / *Didn't run*; timed-out counts as failed in every tally but reads *Timed out* everywhere | *timedout*, *Timedout*, *didnotrun* |
| **Passed on retry** | This execution failed at least once in this run and then passed | *flaky* (as a filter on a run), *Fl:* |
| **Flaky** | A test whose history alternates (the flakiness score) | *New flaky* becomes the badge **Newly flaky** |
| **Baseline** | The run a comparison is made against; by default the last passing run on the same branch | *Run A*, *last passing run* used as three different things |
| **Changes** | What differs between this run and its baseline (tests, durations, commits, environment) | *Insights*, *Since last pass*, *Compare*, *Regression* |

Two sentences to delete from the docs once this ships: "The run page's list still calls executions *cases* in a few labels" (`concepts.md`) and "API routes and a few components say *failure groups*" (same file — the route stays, the label goes).

---

## 4. The execution page

The page that gets the most attention. One column, no page-level tabs, five blocks.

### 4.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ‹ Home › e2e-checkout › Run #4 › should complete checkout with credit card   │
│                                     [Test history] [Share] [Export] [⋯ More]│
├──────────────────────────────────────────────────────────────────────────────┤
│ ● Failed   should complete checkout with credit card            [Copy retry] │
│            New regression · @fixme                     [Run locally ▾] (desk)│
│ tests/checkout/checkout.spec.ts:9 · chromium 1280×720 · 3.7 s (avg 4.3 s,   │
│ −15 %) · attempt 1 of 1 · main a1b2c3d4 · Build #1197 · 1 day ago  [Details ▾]│
├──────────────────────────────────────────────────────────────────────────────┤
│ !  Test timed out after 30 s while clicking getByRole('button', {name:'Pay'})│
│    element is not enabled                                                    │
│    ▸ Strong clue — The element is present but disabled: the button "Pay" is │
│      in the accessibility tree, but the action failed because it was        │
│      disabled, not because it was missing.                     [ARIA] [Error]│
│    New regression · failing since run #4 (1 day ago) · a1b2c3d4 by Alice    │
│    Chen · same failure in 1 other test → cluster #1 (Open · Fix verified)    │
│    · owner @checkout-team                                                    │
│    ▸ Show raw error                                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ Other clues (2)                                                              │
│  Medium  t−0.4 s  The environment changed since the last pass …   [Env diff] │
│  Weak             This failure was fixed before and has come back    [Prior] │
├──────────────────────────────────────────────────────────────────────────────┤
│ Evidence                                                                     │
│ [Timeline] [Screen ●] [Source ●] [Network 4] [Console 1] [State ●] [Perf]    │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ (the tab's content — e.g. Screen: the failure screenshot at full width,  │ │
│ │  visual diff toggle Overlay / Side by side, video, page structure (ARIA),│ │
│ │  DOM snapshot with "Pick a locator", traces & attachments)               │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────┤
│ Fix                                                                          │
│  Locator fix — only when the locator failed to resolve (recommendation,     │
│    provenance line first, then the alternatives)                             │
│  Fix plan — summary + patch state, "Open fix plan →" (cluster page)          │
│  Diagnosis — the cluster's diagnosis summary and confidence, or             │
│    [Diagnose with AI], or one line "AI is not configured · Configure · Copy  │
│    prompt"                                                                   │
│  Verify — [Re-run in CI] [Run locally]  (retry command is in the header)     │
├──────────────────────────────────────────────────────────────────────────────┤
│ History   ■■■■■■■■■■■■■■■■■■■■■□■■   failing for 1 run · last passed run #3  │
│           each square is an execution → link            [Test history →]     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Block by block

**Header** (replaces `TestCaseSummary.vue` and `FoldableSummary`).
- Line 1: status chip, title, the exceptional badges only (*New regression*, *Passed on retry*, *Newly flaky*, `@fixme`/`@skip`/`@slow`, *Quarantined*), the primary action *Copy retry command* and, in the desktop shell, *Run locally*.
- Line 2, one line of facts: path with open-in-IDE (the failing frame, as today) · browser and viewport · duration with the average and delta · attempts (chips as links when there is more than one, as shipped by quick win 7) · branch and commit · CI build link · started. A **Details** popover holds what was the metadata strip and the tiles: CI provider, workflow and job, environment label, Playwright and Piwi versions, worker, shard, step count, slowest step, wasted time, tags, entity links.
- The four stat tiles, the slowest-step and wasted-time lines, and the two metadata rows are removed from the first screen. *Worker* keeps a place in the timeline tab; *slowest step* and *wasted time* are performance facts and move to the Performance tab (the timeout-budget clue already says when they matter).
- The navbar keeps *Test history*, *Share*, *Export* and gains a **More** menu: *Quarantine this test* / *Release* (from `claude/audit-triage-actions`), *Link an issue*, *Copy failure*, *Refresh*. The navbar *Refresh* button goes into that menu — the page already updates over the run stream.
- `DidNotRunCard` stays pinned under the header for a did-not-run execution (it *is* that execution's story); the *blocked tests* list joins the Fix block ("Blocked by this failure (7) →").

**Headline** (keeps `TestCaseHeadlineCard.vue`, absorbs two cards).
- Unchanged first lines: the headline, the detail line, the strongest clue with its citation chips.
- The fact row absorbs the *Regression status* card and the *Failure cluster* card: why · failing since (first failing run, last passing run) · commit and author · the cluster as a link with its triage status and fix verification in brackets · owner. `TestCaseVerdictCard.vue` and `FailureClusterCard.vue` are deleted; their strip of recent executions moves to the History block.
- **Show raw error** is a disclosure at the bottom of the card: collapsed by default, the first error line visible as its label, expanding to today's ANSI-rendered error with the *Copy failure* action. The raw error is one click away, verbatim, and no longer the biggest thing on the page.

**Other clues** (`CluesCard.vue`, retitled). Lists the clues *after* the first one; hidden when there is only one. The strongest clue is not printed twice.

**Evidence** — one card, content-level tabs (`EvidenceTabs`, new). Each tab shows a count or a dot when it has data and is dimmed when empty; a dimmed tab still opens and shows the three-state empty message with its `/setup` link. The default tab is chosen by relevance: the section the top clue cites, else *Timeline* when it can place two or more items, else *Screen*. Tabs:

| Tab | Content | Comes from |
|---|---|---|
| **Timeline** | The failure timeline (axis + "what happened in this window"), with *Whole test* showing the full step table (category, duration, share of the test, bar) — the former Steps tab | `FailureTimelineCard.vue`, the Steps tab in `[id].vue:938-1084` |
| **Screen** | Failure screenshot at full width, *Visual diff* as a toggle on it (Overlay / Side by side) with the baseline note, video, page structure (ARIA snapshot), DOM snapshot with *Pick a locator*, then *Traces & attachments* (View trace, download, files) | `TestCaseEvidenceCard.vue`, `VisualDiffCard.vue`, ARIA block, `DomSnapshotCard.vue`, `TestCaseTracesCard.vue`, `TestCaseAttachmentsCard.vue` |
| **Source** | The failing line and its callers; *Full stack* toggle when a trace exists | `TestSourceCard.vue` |
| **Network** | Requests with inline backend logs and spans; *Full trace* toggle | `TestCaseNetworkRequests.vue` |
| **Console** | Console entries | `TestCaseConsoleCard.vue` |
| **State** | App state at test end (URL, storage keys, cookies) and the environment diff against the last pass (labelled *This run* / *Last pass*, as shipped) | `PageStateCard.vue`, `EnvironmentDiffCard.vue` |
| **Performance** | Performance hints, Web Vitals, slowest step, wasted time | the former Performance tab |

The jump-chip row is deleted: the tabs are the map. Clue and diagnosis citations keep working through the existing section locator (`useClusterSectionLocator`), which now switches the tab and scrolls to the block instead of unfolding a card. The Artifacts tab is deleted (everything it showed is a tab above). A passing execution shows the same card with *Timeline* selected, so the page shape never changes with the status.

**Fix** (`FixCard`, new — the execution and cluster pages share it).
- **Locator fix**: the current `LocatorHealingPanel` body, rendered only when the failure is a locator-resolution failure (already gated server-side by quick win 2). Its provenance line ("Pre-captured from the last passing run — highest confidence · captured 7 days ago") comes first, then the recommendation, then the alternatives. The "Not a locator problem" card disappears — a fact that nothing applies is not worth a card.
- **Fix plan**: one line with the diagnosis category, confidence, patch validation state and *Open fix plan →*; nothing else, the plan lives on the cluster page.
- **Diagnosis**: the cluster's diagnosis summary when one exists (with confidence and *Open →*), else *Diagnose this execution* when a provider is configured, else one line: *AI is not configured · Configure · Copy prompt*. The execution-scope diagnosis stays available (`TestCaseAiCard.vue` becomes a section of this card, on the unified panel of §10).
- **Verify**: *Re-run in CI* (when a dispatch is configured, as shipped by audit G), *Run locally* (desktop). The retry command is the header's primary action and is not repeated here.

**History**: the 24-square strip (each square an execution link, labelled and keyboard-focusable), the streak sentence, *Test history →*. The former History tab (duration chart + 20-row table) is deleted; `/test-cases/:id` is that page.

### 4.3 What is removed from this page

| Removed | Why |
|---|---|
| Page-level tabs Diagnosis / Steps / Artifacts / Performance / History | One page; steps live in the timeline, artifacts in Screen, performance in a tab, history in a block and on `/test-cases/:id` |
| Stat tiles, slowest step, wasted time, metadata strip | Not what a red execution is about; kept in the Details popover and the Performance tab |
| `TestCaseVerdictCard.vue` (*Regression status*) | Its chips are in the headline, its sentence in the fact row, its strip in History |
| `FailureClusterCard.vue` | The cluster is one fact in the headline and one section in Fix |
| The jump-chip row | The evidence tabs are the map |
| The Error card as the first screen | Becomes the *Show raw error* disclosure in the headline |
| "Not a locator problem" and "identical environment" cards | Facts that nothing applies do not get a card |
| Fold cookies (`piwi-section-fold-case-*`, `piwi-summary-fold-test-case`) | No first impression from a cookie |
| The AI placeholder column | One line in Fix |

---

## 5. The failure cluster page

Same shape as the execution page with an "across N tests" layer: an affected-tests selector on the evidence, an *Affected tests* block, and triage in the header.

### 5.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ‹ Home › Web Dashboard › Failure cluster #10       [Share] [Export] [⋯ More] │
├──────────────────────────────────────────────────────────────────────────────┤
│ toHaveCount mismatch on getByRole('row') in users.spec.ts       [Re-run in CI]│
│ assertion · 8 occurrences · 1 test · first seen run #70 (3 d) · last seen    │
│ run #63 (9 h) · owner @admin-team · known issue PROJ-123                     │
│ Triage  [Open][Resolved][Ignored] ✎ note        Fix verified in run #62 —    │
│                                                 open 1 d 2 h · Mark resolved │
├──────────────────────────────────────────────────────────────────────────────┤
│ !  Expected 26 rows, found 51 — getByRole('row') toHaveCount   (latest       │
│    occurrence, run #63)                                                      │
│    ▸ Strong clue — GET /api/users?page=1 returned 50 records … [Network]     │
│    ▸ Show raw error                                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ Other clues (1)                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ Evidence   from: [Users table paginates 25 rows per page ▾] · run #63 ·      │
│            [Open execution →]                                                │
│ [Timeline] [Screen ●] [Source ●] [Network] [Console] [State ●] [Perf]        │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
├──────────────────────────────────────────────────────────────────────────────┤
│ Fix                                                                          │
│  Diagnosis   app-bug · high confidence · 88        [Re-diagnose] [History ▾] │
│    Users table renders 50 rows instead of 25 — server-driven pagination …    │
│    evidence bullets with citations · suggested fix · patch (Applies cleanly) │
│    [Download .patch] [Copy git apply] · other hypotheses ▸ · 👍 👎           │
│  Locator fix  (when it applies)                                              │
│  Verify   npx playwright test "tests/admin/users.spec.ts" -g "Users tab…" 📋 │
│           [Re-run in CI] [Run locally]   Last re-run 2 h ago by Alice ↗      │
│  Fix plan  [Copy as Markdown]  — the same content assembled for an agent     │
├──────────────────────────────────────────────────────────────────────────────┤
│ What changed   baseline run #62 · commit demo010 ▾ · [Browse commits]        │
│   src/server/users.ts  −const PAGE_SIZE = 50; +const PAGE_SIZE = 25;  …     │
├──────────────────────────────────────────────────────────────────────────────┤
│ Affected tests (1)   ☐ select → [Move to a new cluster] [Quarantine]         │
│   ☐ Users table paginates 25 rows per page  users.spec.ts:7  Failed · 8 runs │
├──────────────────────────────────────────────────────────────────────────────┤
│ History   occurrences per run ▁▂▃▅▅▆▇▇ · diagnosed 3× · resolved 2026-09-02 │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Block by block

**Header** (replaces `ClusterSummary.vue` and the *Triage* card).
- The cluster name (AI title, else the deterministic title — as shipped), then one facts line; the raw signature is no longer on the first screen (it is under *Show raw error*).
- **Triage inline**: a segmented control *Open / Resolved / Ignored* that saves on click (toast, no Save button), a note icon opening a small popover. Next to it, **fix verification** as a badge with one sentence, and — when the two disagree — the reconciliation action the audit's G rules imply: *Fix verified in run #62 · still Open → Mark resolved* / *Regressed after run #62 → Reopen*. The word *Resolution* is retired; the block is *Fix verification*.
- Owner and known-issue link come from `claude/audit-triage-actions`; they sit in the facts line, not in a card.
- Primary action: *Re-run in CI* when configured, else *Copy retry command*. The **More** menu: *Quarantine all affected tests*, *Move tests to a new cluster…* (the former *Extract*), *Copy retry command*, *Copy summary*, *Refresh*.

**Headline**: the headline of the **latest** occurrence, labelled as such. This needs the audit's ⬜ *cluster exemplar refresh* (`sampleError` from the latest occurrence); until it ships, the headline is built from the stored sample error and labelled "first occurrence, run #70".

**Clues**: the clue engine run on the representative execution (the latest occurrence). This is new but cheap: the endpoint exists per execution; the cluster page calls it for the selected execution.

**Evidence**: the same `EvidenceTabs` card with a selector row on top — *from: [test ▾] · run #N · Open execution →* — replacing `ClusterTestEvidence.vue`'s per-case tab strip and its own five sub-sections. The cluster page and the execution page stop diverging (*Failure evidence* vs *Test evidence*, two sets of sub-sections, two fold behaviours).

**Fix** (`FixCard`, cluster variant):
- **Diagnosis** is the unified panel (§10): result first, *Re-diagnose* and a *History* menu in its header, *Show context* and *Copy prompt* in the More menu of the page. When no provider is configured, one line (*AI is not configured · Configure · Copy prompt*) — and a stored diagnosis stays visible.
- **Locator fix** appears once, here; the fix plan's *Suggested locator edits* block and the locator panel merge (same data, one rendering).
- **Verify**: the command, *Re-run in CI* once (the second instance in the evidence header is removed), *Run locally*, the last dispatch line.
- **Fix plan**: *Copy as Markdown* — the plan is what this card already shows, assembled for an agent. The `FixPlanCard` stops being a separate card.

**What changed**: the SCM diff, with the baseline picker and commit browser as a popover row instead of a toolbar. Its status sentence (*Unsupported SCM host*, *No last passing run*…) is the block's empty state, never shown next to "No changes found in this range".

**Affected tests**: a list of `TestRow`s (§10) with a checkbox, replacing the *Extract* modal's own table: *Move to a new cluster* (former Extract) and *Quarantine* act on the selection. Each row links to its latest execution.

**History**: occurrences per run as a sparkline, diagnosis versions count (the slide-over stays, opened from the Diagnosis header), resolution date.

### 5.3 What is removed from this page

The right column; the *Triage* card; seven folded headers and their cookies (`piwi-section-fold-cluster-*`, `piwi-summary-fold-failure-cluster`); the second *Re-run in CI*; the duplicated locator suggestion; `ClusterDiagnosis.vue` and the run page's *Diagnose* modal; the diagnosis header's four buttons (two move to the More menu); the dead `ref="locatorSection"` (`[id].vue:341`); `cluster.resolution` becomes `cluster.fix-verification`.

---

## 6. The run page

### 6.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ‹ Home › E2E Checkout › Run #2  (Newer run → #20)        [HTML report] [⋯]   │
├──────────────────────────────────────────────────────────────────────────────┤
│ ● Failed  Run #2  + label   After: Upstream payment API outage   [Copy retry]│
│ started 10 h ago · 2.4 min · main a1b2c3d4 Alice Chen · staging · Build #1199│
│ [Details ▾]                                                                  │
│ ████████████████████████████▓▓▓▓▓▓▓▓▓░░  9 passed · 3 failed · 1 on retry    │
│  (each segment is a filter)                                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Tests (12)]  [Changes]  [Timeline (4 workers)]                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ Group by [Cluster ▾]   🔍 Search tests   ● Passed ● Failed ● On retry ● …    │
│                        Browser [All ▾]   ☐ New regressions  ☐ Newly flaky    │
│                                                                              │
│ ▾ Error on getByRole('button') in checkout.spec.ts   2 tests · Resolved ·    │
│   Fix verified                                             [Open cluster →]  │
│   ☐ ✗ should complete checkout with credit card   NEW @fixme +3   3.6 s  ⊙  │
│       Test timed out after 30 s while clicking getByRole('button', …)        │
│       tests/checkout/checkout.spec.ts:9                                      │
│   ☐ ✗ should complete checkout with PayPal        NEW @fixme +2   4.3 s  ⊙  │
│ ▾ Timeout on getByLabel('Email address') in checkout.spec.ts   1 test · Open │
│   ☐ ✗ should complete checkout with Apple Pay     NEW +2          4.4 s  ⊙  │
│ ▸ Passed (9)                                                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Header (replaces `RunSummary.vue`)

- Line 1: status chip, *Run #N*, the label editor, the marker chip, the primary action (*Copy retry command* with its mode picker on a red run; *HTML report* on a green one; both exist, one is primary).
- Line 2: started, duration, branch and commit and author, environment, CI build. **Details** popover: shards, Playwright and Piwi versions, avg and P90 durations, wasted time, storage and every report, tags, links, custom data.
- **One count bar** with the numbers on the segments, each a filter: *9 passed · 3 failed · 1 passed on retry · 0 skipped · 0 didn't run* (zero segments hidden). The five tiles, the second bar and the T/P/F/S/DNR/Fl abbreviations go. Clicking a segment also switches to the Tests tab (today's tiles change hidden state on other tabs, `[id].vue:446-454`).
- Removed: the duplicate `run.partial` help hint (`RunSummary.vue:301-304`), the duplicate freshness pill (`[id].vue:701-706`), `RunReports.vue` (unreferenced), the summary fold cookie.

### 6.3 Three tabs

**Tests** — the executions list, one `TestRow` per execution, failures first.
- **Group by**: *Cluster* (default on a red run) · *File* (the former tree view) · *None*. One row component, three groupings; the tree view's separate rendering (`TestCasesTree.vue`) is deleted, and grouping keeps column sort inside each group, virtualization and the mobile card.
- A cluster group header carries the cluster name, its test count, triage status and fix verification, and *Open cluster →*. This replaces the *Failure clusters* tab, its overflowing table, its three buttons per row and the *Diagnose* modal. *Show failing tests* is what the grouping already does.
- Filters: search (title, path, **and error text**), five status chips (*Passed / Failed / Passed on retry / Skipped / Didn't run*), *New regressions* and *Newly flaky* as chips in the same row (not checkboxes), browser select. Filter state stays in the URL.
- Bulk triage from `claude/audit-triage-actions` (checkbox per failing row, bulk bar) works in every grouping, not only the flat view.
- Row: status icon · title (never truncated before ~40 characters at 1280 px) · badges capped at three with `+N` (hover or click opens the full set: tags, owner, priority, feature) · duration · browser icon · retries only when > 0 · wasted only when > 0. The headline and the path on the second and third lines as today. *Worker* is a hover detail and the Timeline's job.

**Changes** — one tab replacing *Insights*, *Since last pass* and *Compare*, built on one baseline.
- Top row: *Compared with* **[Run #9 — last passing run on main ▾]** · *Previous run* · *Pick a run…*; the default is the branch-aware baseline the docs define, and the three baselines the audit found (`RunInsights.vue:157`, `RunCompare.vue:80-89`, `/regression-context`) become one.
- Sections, each a list of `TestRow`s or a short table: **New failures** (passed in the baseline, failing here) · **Fixed** · **Still failing** · **Newly flaky / passed on retry** · **Slower / faster** (duration deltas) · **Commits since the baseline** (range, `git log` command, *View commits*) · **Environment changes** (the field diff, labelled *This run* / *Baseline*).
- *Slowest tests* and *Worker distribution* move to the Timeline tab; *New failure clusters* is the cluster grouping's *New* badge.
- The tab is disabled with an inline reason while the run is live, as the Insights tab is today.

**Timeline** — the workers timeline as today, plus the *Slowest tests* list beneath it; the *Span types* popover becomes one toggle, *Show hooks and waits*.

**Removed tabs**: Insights, Failure clusters, Since last pass, Compare, **Slow endpoints** (moves to the project's Performance tab with a run filter — per-run network data with no link to any test does not need a permanent slot on the run page).

---

## 7. The project page

### 7.1 Header

```
E2E Checkout   smoke · critical                      🔔  [Import]  [⋯ More]
End-to-end tests for the checkout flow
Latest run #1 failed 1 h ago · 33 % pass rate (last 20 runs) · 2 open clusters
· 2 flaky · 1 quarantined                                (each a link to its tab)
Environment [All ▾]  Branch [main ▾]  ☑ Full runs only
[Runs (16)]  [Tests (12)]  [Failures]  [Performance]  [Settings]
```

- A **status line** (the row Home's project table already computes) so the page states the project's condition on entry.
- **One filter bar** — environment, branch, *Full runs only* — the same control as Home and Analytics, persisted per project in one cookie. The pill rows, the per-row *Clear filter* buttons and the in-row branch chips go.
- Navbar: the bell, *Import* (primary), a **More** menu with *Edit*, *Test functions*, *Selections*, *Delete*, *Refresh*. Test functions and Selections are extension and CLI features; a menu is where they are found, not the page header.

### 7.2 Five tabs

| Tab | Content | Absorbs |
|---|---|---|
| **Runs** | Run trend chart (markers drawn on it; *Markers (3)* in the chart header opens a slide-over with the marker table and *Add marker*), the runs table; selecting two runs shows *Compare* which opens the newer run's **Changes** tab with the older as baseline (`/test-runs/:b?tab=changes&baseline=:a`) | Compare tab, Timeline tab, `/projects/:id/compare` |
| **Tests** | The catalog, one `TestRow` per test; *Group by* **File** shows the spec-health numbers (pass rate, flaky rate, failures) as group headers | Spec health tab, `/projects/:id/test-cases` (the broken `?file=` drill-down becomes a grouping) |
| **Failures** | A content-level segmented control **Clusters (2) · Flaky (2) · Quarantine (1)**; merge suggestions inline above the clusters; *Worth quarantining* becomes a *Quarantine* button on the flaky rows | Failure clusters, Flaky tests, Quarantine tabs |
| **Performance** | Duration trend, slowest tests (rows link to the test), timeout opportunities, **slow endpoints** (from the run page, with a run filter), AI-step coverage only when the project has AI-step artifacts | Performance, AI steps tabs; the *Run comparison* copy is deleted |
| **Settings** | Members (admin), and the edit form (label, description, tags, SCM token, AI instructions) as sections; `/projects/:id/edit` redirects here | Members tab, edit page |

The command palette's *This project* group lists exactly these five.

### 7.3 Removed

Tabs Compare, Spec health, AI steps, Timeline, Members (folded into the five above); the *Run comparison* card in Performance (`index.vue:1171-1286`); the pill filter rows; four of the six navbar buttons; the *View* column in every table (row click); the second date-range idiom (Performance's two date inputs use the shared filter bar's period select); `/projects/:id/compare.vue` and `/projects/:id/test-cases.vue`.

---

## 8. Home, the projects list and analytics

**Home** gains the first slice of the audit's **D** (the failure inbox) and loses decoration.
- **Open failures** card first: open clusters across the visible projects, newest first — headline, project, test count, age, owner, triage status; the row opens the cluster; `j`/`k` move, `o` opens, `r`/`i` set the triage status. This is the one-click path from Home to a failure.
- The stat strip stays but every number is a link (*5 failing now* → the Open failures card filtered to failing projects; *0 flaky* → Analytics' flakiest tests).
- *Project health* and *Recent activity* stay as they are.
- On an empty instance, the wizard stays and the four inert feature cards go (`index.vue:391-404`); `/setup` already covers them.

**Projects list**: the *View details* column goes (row click); the rest stays.

**Analytics**: out of scope for this plan except for consistency — it adopts the shared filter bar and the shared *Full runs only* preference. Whether Home and Analytics should merge is a later question.

---

## 9. The test history page (`/test-cases/:id`)

Already close to the shape; three changes.
- The six tiles become one facts line under the title (*20 runs · 85 % pass · 3 failed · avg 4.3 s · flaky score 0 · last run 1 h ago*), with the *Latest execution →* and *Reproduce locally* actions on the right.
- The *Status history* card goes; the duration chart already colours every bar by status. The strip stays as the chart's footer row so a click still lands on an execution.
- *Recent executions*: rows are `TestRow`s in history mode (date · status · duration · attempts · run · headline), the row opens the execution, the *View* column goes. The clusters and links sections stay.

---

## 10. Shared building blocks

**Build**

| Component | Used by | Replaces |
|---|---|---|
| `DetailHeader` — status, title, exceptional badges, one facts line, primary action, More menu, Details popover | execution, cluster, run, project (variant), test history | `TestCaseSummary`, `RunSummary`, `ClusterSummary`, `FoldableSummary`, `SummaryMetaStrip` as the first screen |
| `EvidenceTabs` — the tabbed evidence card with relevance-based default and three-state empty tabs | execution, cluster | ten evidence cards, `EvidenceCardEmpty`, the jump-chip row, `ClusterTestEvidence` |
| `FixCard` — locator fix, fix plan, diagnosis, verify | execution, cluster | `FixPlanCard` as a card, `TestCaseAiCard` as a card, the verify block duplicates |
| `TestRow` + `TestRowGroup` — one row, grouping by cluster / file / none, selection, mobile card | run Tests, run Changes, cluster Affected tests, project Tests, test history | `TestCasesList` row markup, `TestCasesTree`, `FailureGroups` rows, `ProjectTestCasesTable` rows, `ClusterExtractCasesModal` table |
| `BadgeGroup` — three visible, `+N` overflow with a popover | every `TestRow` | `TestRowBadges` + `TestMetaBadges` inline stacking |
| `ChangesView` — baseline selector + sections | run Changes, project Runs (compare) | `RunInsights`, `RegressionContext`, `RunCompare`, the project Compare tab and its copy |
| `TriageControl` — segmented status, note popover, fix-verification sentence with the reconcile action | cluster header, cluster group headers (read-only), bulk bar | the Triage card |
| `FilterBar` — environment, branch, full-runs-only; one cookie per scope | home, project, analytics | three implementations |
| `PatchBlock` — validation badge, download / git apply / copy, diff | diagnosis, fix plan | two copies |
| `HistoryStrip` — the 24 executions as labelled links + streak sentence | execution History, test history chart footer | the strip in `TestCaseVerdictCard`, the *Status history* card |

**Change**

- `DiagnosisPanel` becomes the one diagnosis component with a `scope` (cluster / execution): streaming, stages, cancel, history and screenshots for both; the result is rendered whether or not a provider is configured; *Show context* and *Copy prompt* move to the page's More menu; the browser-notification rows move to Settings → AI. `TestCaseAiCard.vue` and `ClusterDiagnosis.vue` are deleted.
- `LocatorHealingPanel` keeps its logic and loses its card: it renders inside `FixCard`, provenance line first, and never as a standalone "not a locator problem" card.
- `FailureTimelineCard` gains the whole-test step table (the former Steps tab) under *Whole test*.
- `DetailPageLayout` allows zero tabs and drops the summary fold; page-level strips keep the Settings-style navigation menu (the `AGENTS.md` rule) — there are simply fewer items.
- `formatStatusLabel` renders *Timed out* for `timedout`; `formatTriageStatus` and `fixVerificationBadge` are the only renderers of their enums.
- `useClusterSectionLocator` maps section ids to evidence tabs.

**Delete** (once the pages above ship): `TestCaseVerdictCard.vue`, `FailureClusterCard.vue`, `EvidenceCardEmpty.vue`, `TestCaseTracesCard.vue` (folds into Screen), `TestCaseEvidenceCard.vue` (folds into Screen), `ClusterTestEvidence.vue`, `ClusterExtractCasesModal.vue` (selection on Affected tests), `ClusterDiagnosis.vue`, `RunInsights.vue`, `RegressionContext.vue`, `RunCompare.vue`, `SlowEndpoints.vue` (moves), `FailureGroups.vue`, `TestCasesTree.vue`, `RunReports.vue`, `SpecHealthTable.vue` (becomes a grouping), `ProjectTimeline.vue` (becomes a slide-over), the *Run comparison* block, `pages/projects/[id]/compare.vue`, `pages/projects/[id]/test-cases.vue`, `useFoldedState` on these pages, `CollapsibleSectionCard` on these pages (it stays for settings and docs surfaces).

---

## 11. Delivery plan

PR-sized steps, each shippable alone, each with acceptance criteria that a screenshot scene can check. Order matters: the execution page first (it is where the audit's additions piled up), the cluster page second (it reuses everything), then the lists.

### Phase 0 — prerequisites (days)

1. ✅ Merged to `main` on 2026-09-03 (PR #441): the quarantine action on the execution navbar, *Quarantine all affected*, the owner and known-issue controls on the cluster page, and bulk triage on the run list now exist. PRs 1, 3 and 5 relocate them to the places this plan defines — never duplicate them.
2. Baseline scenes: `execution-before`, `cluster-before`, `run-before`, `project-before` at 1280 × 800 and 390 px, so the *In numbers* table can be re-measured after each phase.
3. Vocabulary helpers: `formatStatusLabel` renders *Timed out*; every triage and fix-verification render goes through the existing helpers; a unit test greps the app for the retired words (*failure group* as a label, *Alternative locators*, *Regression status*, *Resolution*, *AI verdict*, *test case* as a column header).

### Phase 1 — the execution page (two PRs)

**PR 1 — header and evidence.** ✅ #443 `DetailHeader` (execution variant, Details popover, More menu), `EvidenceTabs` with the seven tabs wrapping the existing card bodies, relevance-based default tab, section locator retargeted to tabs; delete the page-level tabs and the jump chips.
Accept when: at 1280 × 800 the first screen shows the headline, the strongest clue and the default evidence tab with the screenshot visible; at 390 px there is no horizontal scroll and the headline is above the fold after the header; `tests/*.spec.ts` that assert on *ARIA snapshot* (8 files), *DOM snapshot*, *Failure timeline* and *Clues* pass against the tabs.

**PR 2 — headline, fix, history.** ✅ #446 Fact row absorbs the two cards; *Show raw error* disclosure; *Other clues*; `FixCard` (execution variant) with the locator fix, fix plan line, diagnosis section, verify; `HistoryStrip`. Delete `TestCaseVerdictCard`, `FailureClusterCard`, the fold cookies.
Accept when: *New regression* appears once on the page; the raw error is reachable in one click; `case.verdict`, `case.evidence`, `case.artifacts` help topics are removed or retitled; docs `evidence.md` §"One execution, diagnosis-first" and the `gather-evidence` and `failure-headline` scenes are updated in the same PR.

### Phase 2 — the failure cluster page (two PRs)

**PR 3 — header, triage, evidence.** ✅ #444 `DetailHeader` (cluster variant) with `TriageControl` and the fix-verification sentence; `EvidenceTabs` with the affected-test selector; delete the Triage card, the right column and the fold cookies; the run page's *Diagnose* modal becomes a link.
Accept when: the first screen shows the name, triage, the headline and the default evidence tab; *Fix verified · still Open* shows the reconcile action; a cluster with no AI provider shows no placeholder column; `failure-clusters.spec.ts` passes.

**PR 4 — fix, changes, affected tests, history.** ✅ #453 Unified `DiagnosisPanel` (result outside the configured branch, history menu, context and prompt in the More menu); `FixCard` (cluster variant) merging the fix plan, the locator fix and verify; `PatchBlock`; What changed with the baseline popover; Affected tests with selection (*Move to a new cluster*, *Quarantine*); History block. Delete `FixPlanCard` as a card, `ClusterDiagnosis`, `ClusterTestEvidence`, `ClusterExtractCasesModal`.
Accept when: *Re-run in CI* and the recommended locator each appear once; a stored diagnosis is visible with the provider unset; `ai-diagnosis` scene and `ai-diagnosis.md` updated.

### Phase 3 — the run page (two PRs)

**PR 5 — header and Tests.** ✅ #445 `DetailHeader` (run variant) with the one count bar; `TestRow` + `TestRowGroup` + `BadgeGroup`; *Group by* cluster / file / none; filters as chips; bulk triage in every grouping; error-text search. Delete `RunSummary` tiles, `TestCasesTree`, `FailureGroups`, `RunReports`.
Accept when: three tabs fit at 1280 px untruncated; a fully annotated failing row shows its full title at 1280 px with three badges and `+N`; the count bar filters *and* switches to Tests; `run-live-activity` scene passes; `run-trend`/`failure-clusters` scenes updated.

**PR 6 — Changes and Timeline.** ✅ #450 `ChangesView` with the one baseline; move slowest tests and worker distribution to Timeline; move slow endpoints to the project. Delete `RunInsights`, `RegressionContext`, `RunCompare`, `SlowEndpoints` on the run page.
Accept when: the same run shows one *new failures* count everywhere; `run-insights` scene is replaced by `run-changes`; `flaky-tests.md` §Run insights rewritten as *Changes*.

### Phase 4 — the project page (two PRs)

**PR 7 — header, filter bar, five tabs.** ✅ #451 Status line; `FilterBar` with one cookie per project; the tab regrouping (Runs with markers slide-over, Tests with file grouping, Failures with the segmented control, Performance with slow endpoints, Settings with members and the edit form); More menu in the navbar. Delete Compare, Spec health, AI steps, Timeline, Members tabs, the *Run comparison* copy, the two extra routes.
Accept when: five tabs fit at 1280 px; the command palette's *This project* group matches them; the spec-health numbers are visible as group headers in Tests; `project-detail`, `flaky-detection`, `performance-trends`, `performance` scenes updated; `ui-overview.md` §Project detail rewritten.

**PR 8 — lists everywhere.** ✅ #456 `TestRow` in the project catalog, the flaky list, the quarantine list and the test history; *View* columns removed; the test history page's tiles and *Status history* card replaced.
Accept when: every table with a per-row *View* button has none; `test-case-detail` scene updated.

### Phase 5 — home and the sweep (two PRs)

**PR 9 — Open failures on Home.** ✅ #442 The card, keyboard handling, linked stat numbers; the feature cards removed. This is the audit's D at its smallest useful size; the full inbox (snooze, assign, bulk, "since you last looked") stays in the audit.
Accept when: Home → a failing cluster is one click; the `home` scene is updated.

**PR 10 — vocabulary and docs sweep.** ✅ #459 (open) The retired-words test turned on for `app/`, `apps/docs/` and `shared/demo/`; `concepts.md`, `ui-overview.md`, `evidence.md`, `ai-diagnosis.md` aligned with §3; demo mirror (`app/demo/api/`) and `app:seed:demo` re-run where response shapes changed; `app:screens:docs` regenerated; `app:screens:check` green.

### Delivery record (2026-09-04)

All ten PRs were produced by separate sessions from this plan, one PR each, in dependency waves; PRs 1–9 are merged, the sweep (#459) is open. Three PRs landed alongside: **#452** (page and card gutters shrink below `sm`, rule 11 of §2), **#455** (the evidence tabs render their sections bare, no card inside a card — the second half of rule 11) and **#454** (the audit's cluster exemplar refresh, so the cluster headline now reads the latest occurrence instead of the first). #457 added the rule that every UI change sends screenshots.

Deviations from the text above, all recorded in the PR bodies: `RunReports.vue` and `ProjectTimeline.vue` were kept because the project pages still import them (Appendix A listed them for deletion); `AnalyticsScopeBar` stays as a thin wrapper that composes the shared filter bar and adds the period and project pickers; Analytics' environment and branch filters became multi-select to match the shared control; status badges keep the app's title-case rendering ("Timed Out"); Home reaches the failure *cluster* in one click and the individual execution in two. Phase 0 step 2 (baseline scenes) was replaced by ad-hoc captures kept in this session; the numbers in §1.6 come from those and from #459.

### Cost and risk

| Risk | Where | Mitigation |
|---|---|---|
| E2E specs assert on labels and card titles | `tests/*.spec.ts` — *ARIA snapshot* (8 files), *Insights* (3), *Failure clusters* (3), *Slow endpoints* (3), *Diagnose*, *Regression status*, *Since last pass*, *Show failing tests* | Each PR updates the specs it touches; the retired-words test catches stragglers |
| The offline export and the share-link page render the investigation | `server/utils/export-*.ts`, share route | Check whether they compose the same components; if they render their own template, align the reading order in PR 2 / PR 4, do not block on it |
| The demo SPA mirrors every response | `app/demo/api/` | No new endpoints in Phases 1–3 except the cluster clues call, which reuses the execution endpoint |
| Docs screenshots are committed | `apps/docs/public/screenshots/` | Regenerate per PR with `app:screens:docs`; `docs-drift` and `app:screens:check` guard |
| Help topics referenced by removed blocks | `app/utils/help-content.ts` | Remove with the block; the anchor test (`tests/unit/docs-drift.test.ts`) fails on a dangling `doc:` |
| Two audit big bets not started need a home | E (attempt diff), F (reproduction bundle), J (structural page diff), K (memory) | Places reserved: an *Attempts* tab in `EvidenceTabs` when attempts > 1; a *Reproduce* section in `FixCard` › Verify; a *Page diff* toggle on the Screen tab; a *Fixed before* line in the Fix block — none built here |

---

## 12. What this plan does not do

- It does not change what is captured, stored or computed (that is the audit's territory), except one addition: running the clue engine for the cluster's representative execution.
- It does not redesign Settings, Setup, MCP, the API docs, the desktop-only cards or the browser extension pages.
- It does not decide whether Home and Analytics merge; it makes them share a filter bar.
- It does not build D beyond the *Open failures* card, nor E, F, J, K; it reserves their places (§11, last row).
- It does not touch the visual theme (colours, radii, type) — the point is fewer things in a fixed order, and Nuxt UI's defaults already look right once the density is gone.

---

## Appendix A — Removals and moves by file

| File | Action | Goes to |
|---|---|---|
| `app/pages/test-run-cases/[id].vue` | rewrite: no page tabs, five blocks | §4 |
| `app/components/test-case/TestCaseSummary.vue` | delete | `DetailHeader` |
| `app/components/test-case/TestCaseVerdictCard.vue` | delete | headline fact row + `HistoryStrip` |
| `app/components/test-case/FailureClusterCard.vue` | delete | headline fact row + `FixCard` |
| `app/components/test-case/CluesCard.vue` | keep, retitle *Other clues*, skip the first clue | §4.2 |
| `app/components/test-case/TestCaseEvidenceCard.vue`, `TestCaseTracesCard.vue`, `TestCaseAttachmentsCard.vue`, `VisualDiffCard.vue`, `DomSnapshotCard.vue` | bodies move | `EvidenceTabs` › Screen |
| `app/components/test-case/TestSourceCard.vue`, `TestCaseNetworkRequests.vue`, `TestCaseConsoleCard.vue`, `PageStateCard.vue`, `shared/EnvironmentDiffCard.vue` | bodies move | `EvidenceTabs` › Source / Network / Console / State |
| `app/components/test-case/FailureTimelineCard.vue` | gains the step table | `EvidenceTabs` › Timeline |
| `app/components/test-case/TestCaseAiCard.vue` | delete | unified `DiagnosisPanel` inside `FixCard` |
| `app/components/shared/EvidenceCardEmpty.vue` | delete | `EvidenceEmptyState` inside the tab |
| `app/components/shared/LocatorHealingPanel.vue` | loses its card wrapper | `FixCard` › Locator fix |
| `app/components/shared/FoldableSummary.vue`, `composables/useFoldableSummary.ts` | delete | `DetailHeader` |
| `app/components/shared/CollapsibleSectionCard.vue` | no longer used on these pages | stays for settings |
| `app/pages/failure-clusters/[id].vue` | rewrite: one column, seven blocks | §5 |
| `app/components/cluster/ClusterSummary.vue` | delete | `DetailHeader` + `TriageControl` |
| `app/components/cluster/FixPlanCard.vue` | becomes sections of `FixCard` | §5.2 |
| `app/components/cluster/ClusterTestEvidence.vue`, `ClusterExtractCasesModal.vue`, `ClusterDiagnosis.vue` | delete | `EvidenceTabs`, Affected tests, `DiagnosisPanel` |
| `app/components/cluster/ClusterInvestigation.vue` | toolbar becomes a popover row | What changed |
| `app/components/diagnosis/DiagnosisPanel.vue` | one component, `scope` prop, result always rendered | §10 |
| `app/components/diagnosis/DiagnosisResult.vue` | patch block extracted | `PatchBlock` |
| `app/pages/test-runs/[id].vue` | three tabs | §6 |
| `app/components/run/RunSummary.vue` | delete | `DetailHeader` (run variant) with the count bar |
| `app/components/run/TestCasesList.vue` | becomes the list container over `TestRow` | §6.3 |
| `app/components/run/TestCasesTree.vue`, `FailureGroups.vue`, `RunInsights.vue`, `RegressionContext.vue`, `RunCompare.vue`, `RunReports.vue` | delete | grouping, `ChangesView`, Details popover |
| `app/components/run/SlowEndpoints.vue` | move | project Performance |
| `app/components/run/WorkersTimeline.vue` | gains slowest tests; one span toggle | Timeline tab |
| `app/pages/projects/[id]/index.vue` | five tabs, status line, filter bar | §7 |
| `app/pages/projects/[id]/compare.vue`, `test-cases.vue`, `edit.vue` | delete / redirect | Runs, Tests, Settings tabs |
| `app/components/project/SpecHealthTable.vue`, `ProjectTimeline.vue` | grouping / slide-over | Tests, Runs |
| `app/components/project/FailureClustersList.vue`, `FlakyTestsList.vue`, `QuarantineTable.vue` | one segmented tab, `TestRow` rows | Failures |
| `app/components/project/ProjectTestCasesTable.vue`, `ProjectTestCasesTree.vue` | `TestRow` + file grouping | Tests |
| `app/pages/index.vue` | Open failures card, linked numbers, no feature cards | §8 |
| `app/pages/test-cases/[id].vue` | facts line, no status card, `TestRow` rows | §9 |
| `app/components/home/HomeFilters.vue`, `analytics/AnalyticsScopeBar.vue` | one `FilterBar` | §10 |
| `app/layouts/default.vue` | palette *This project* group = five tabs | §7 |

## Appendix B — Renames on screen

| Today | After |
|---|---|
| Executions (tab) / cases / test cases / Test case (column) | **Tests** (tab), **N executions** (count), **Test** (column) |
| Test case (page `/test-cases/:id`, navbar link) | **Test history** |
| Failure clusters (run tab) / failure groups (URL) | the **Cluster** grouping of Tests; `?tab=failure-groups` redirects to `?tab=test-cases&group=cluster` |
| Insights · Since last pass · Compare | **Changes** |
| Failure evidence · Test evidence · Artifacts | **Evidence** |
| Alternative locators | **Locator fix** |
| Regression status (card) · Failure verdict (help) | gone — the headline's fact row |
| AI verdict · Diagnosis result | **Diagnosis** |
| Resolution | **Fix verification** |
| Status (cluster column) | **Triage** |
| Signature (column) | **Failure** (the cluster name) |
| Flaky (run filter) · Fl: · New flaky | **Passed on retry** (filter) · **Newly flaky** (badge) |
| failed (for `timedout`) · Timedout | **Timed out** |
| Extract | **Move to a new cluster** |
| Timeline (project tab, markers) | **Markers** (slide-over on the Runs chart); *Timeline* stays the run's worker view |

## Appendix C — Preferences to retire

Cookies removed: `piwi-section-fold-case-*` (ten keys), `piwi-section-fold-cluster-*` (eight keys), `piwi-summary-fold-test-case`, `piwi-summary-fold-failure-cluster`, `piwi-summary-fold-test-run`, `piwi-tree-view-test-cases`, `piwi-tree-view-project-test-cases`. Cookies kept or added: `piwi-group-by-run-tests` (cluster / file / none), `piwi-group-by-project-tests` (file / none), one `piwi-filters-project-<id>` and the existing `piwi-home-filters` / `piwi-analytics-scope`, all writing the same shape. Tab state stays in the URL.

## Appendix D — Method

Three parallel code inventories (run page and its components; cluster, diagnosis and locator-healing components; project, home, history, navigation) listing every block, control, label, empty state and duplicate with file references, plus a first-hand walk through the seeded dashboard at 1280 px and 390 px: `/test-run-cases/37` folded, fully expanded and on a phone, `/test-runs/2` on every tab, `/failure-clusters/10` (fix verified) and `/failure-clusters/2`, `/projects/1` on six tabs, `/test-cases/1`, home, the projects list and analytics. The committed docs screenshots were read as the intended design. The in-progress branch `claude/audit-triage-actions` was diffed so the controls it adds (quarantine, owner, known issue, bulk triage) have a place here rather than a competing one.
