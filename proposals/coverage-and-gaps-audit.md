# Coverage and gaps on every tool: a second audit

An audit of the coverage and gap features as a person and an agent meet them on each of Piwi's tools: the dashboard's
Coverage tab, the pull-request comment and the merge gate, the reporter and the two backend packages that record
coverage, probes, the editors, the browser extension, the MCP server with its skills, the command line and the docs.
It follows [`missing-tests-audit.md`](missing-tests-audit.md), written seventeen days and nine releases earlier, which
asked how best to find a missing test. This one asks three other questions: is what these features show **reliable**,
is it **useful** enough to act on, and is it **easy to use**. It lists the defects found, with the file and the input
behind each, says what to change and in what order, and proposes new features that the stored data already allows.

**Status.** Proposed 2026-11-17, against `main` at v0.72.0 (`5efbb7c`). Nothing in it is built. A pull request that
builds part of §11 updates this paragraph.

**Summary.** The area holds a lot: the reference lists 24 detectors, coverage is recorded per test in the browser and
on two backends and combined with unit suites per commit, and the dashboard, the pull request, two editors, the
extension and the MCP server each show the result. The code written since the earlier audit is where most of the new
defects are: appendix A lists 165, of which 24 are high, and 63 were reproduced by running the code. Ten findings lead
(§0):

- **A verdict does not hold.** Accepting or snoozing a gap is lost when the gap closes and reopens, and partial runs
  close gaps that the next full run reopens.
- **A pull request's gaps outlive it.** They never close once the pull request is merged or abandoned, and a verdict
  on one pull request silences the same file on the next.
- **The pull-request comment can fail whole.** One missing figure makes the comment builder throw, so no comment and
  no status is posted, and a passing run can overwrite a failing run's status.
- **Coverage figures can drop or vanish without a word.** A late upload for an old commit removes the newest commits'
  detail, a commit whose unit job did not upload owns the day's trend point, and two shards that disagree on a file's
  version erase its coverage.
- **Browser coverage has blind spots that nothing reports.** Large inline source maps, same-site popups, Playwright's
  own `page.coverage`, and Firefox or WebKit projects each record wrong lines or nothing.
- **In the editor, running one test hides what the others ran.** The lines read "no test runs this line" until every
  test has run again, and VS Code's *Run with Coverage* does not record coverage.
- **A probe run can reach what the test protects.** A request the test mocks at context level goes to the real
  backend, and a streamed response is withheld.
- **The extension's percentage can be wrong by construction.** A page whose key no test recorded reads "0% tested",
  and a hash-routed application is one page.
- **An agent cannot finish the loop.** An accepted gap leaves every MCP read, *covered by* closes a gap for good
  without a test, and nothing proves a new test closed anything.
- **An empty screen reads as a clean one.** On every tool, "nothing to show" covers "no data", "wrong branch", "not
  set up" and "nothing wrong" alike.

§11 ranks the changes: 13 quick wins that make what exists true, 12 medium items, and the programs the earlier audit
already named. §12 lists 18 feature opportunities. Security and permission findings are not in this document: they
were reported to the maintainers apart.

This document is written for the maintainers. Every finding carries a file reference and a marker of how it was
confirmed:

- **(seen)**: observed first-hand on a seeded instance (`npm run app:seed:dev`, the dev server, driven in Chromium).
- **(run)**: reproduced by executing the real code on a scenario: the shared handlers on a temporary SQLite database,
  the reporter's capture fixtures in Chromium, the extension's built overlay, the editor service's tests.
- **(read)**: read in the code, not executed. A finding marked *suspicion* could not be tied to an input.

Paths under `shared/`, `server/` and `app/` are in `apps/application/`. `SG:n` is line n of
`apps/application/shared/handlers/scenario-gaps.ts`. In the tables of appendix A, `R/` is
`packages/reporter/src/`, `C/` is `packages/core/src/`, `E/` is `packages/editor/src/`, `X/` is `apps/extension/src/`,
`V/` is `apps/vscode/src/` and `J/` is `apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/`.

The vocabulary is that of [`coverage-and-the-test-map.md`](../adr/coverage-and-the-test-map.md) and of the earlier
audit: a **gap** is a test to write, proposed by a **detector**; a **finding** is a fault a probe showed in the
application, listed with the gaps; a **verdict** is what a person answers to a gap (accept, snooze, covered by,
dismiss); the **evidence window** is the 30 default-branch runs the detectors read; **lines not run** are executable
lines no test or suite ran; an **uncovered change** is a changed file no test reached; **patch coverage** is the share
of a diff's changed lines that ran. The ids of appendix A continue the earlier audit's (`TM`, `PB`, `CV`, `CT`) and add
`CP` (capture), `UI` (dashboard screens), `ED` (editors), `EX` (extension), `AG` (agents, command line and docs) and
`DM` (demo).

## 0. The ten findings that matter most

1. **A verdict on a gap does not hold through the gap's life.**
   - **Lost on reopen.** A gap that closes because one recompute does not detect it, then is detected again, comes
     back `open`: its acceptance, its assignee and its snooze are dropped while `acceptedAt` and `snoozedUntil` stay
     set (SG:3747, SG:3792-3795) **(run)**. The accepted gap leaves the Home queue.
   - **Closed by partial runs.** The evidence window counts partial runs: thirty runs of one test on the default
     branch, or a smoke suite every fifteen minutes, empty it of the routes they do not call, and the gap closes as
     `not-detected` until the next full run reopens it (SG:1576-1584, `shared/run-eligibility.ts:201-206`) **(run)**.
   - **Closed or withheld by a cap.** The two coverage detectors keep 30 files before reading the gaps table. One new
     file pushes another out, whose gap closes with nothing changed; a file past the thirtieth is never raised; and
     thirty dismissed files leave the detector with nothing to say (`shared/handlers/code-gaps.ts:58`, `:149-154`,
     `:272-274`) **(run)**.

   Each of these also changes what the precision figures count, since a closure is counted whatever its reason.

2. **A pull request's gaps do not follow the pull request.**
   - **Never closed.** The gaps a pull request raises (*new error path*, *new control*, *intent without a test*) close
     only on a later run of the same pull request (`server/utils/scm/change-time-gaps.ts:83-103`). Once it is merged
     or abandoned they stay open in the project's list for good, and an accepted one stays in the Home queue
     **(run)**.
   - **One row per file.** A gap is one row per project, detector and key, and the key of an uncovered change is the
     file's path (SG:562). The last pull request to run takes the row, so the first loses its link and its count; a
     dismissal or a *covered by* given on one pull request keeps the file silent on every later one (SG:3787,
     SG:3792) **(run)**.
   - **Noise at the source.** *Intent without a test* opens a gap for `chore(deps): bump vite` and `docs: update
     README`; *new error path* reads a re-indented `throw` and a comment naming a 503 as new statuses
     (`shared/change-time.ts:9-14`, `:76-98`) **(run)**.

3. **The pull-request comment and its statuses can be missing or wrong, and nothing says so.**
   - **The builder throws.** With the file list withheld, no combined coverage for the head commit and one open
     pull-request gap, `renderChangeCoverage` reads `patch!.executedLines` of a null value
     (`shared/pr-feedback.ts:364-365`). Nothing is posted, and the pending status stays on the commit **(run)**. A
     muted *changed, unreached* detector is enough to withhold the file list.
   - **One status context.** Every run of a commit posts under the same context, `piwi/tests`
     (`shared/pr-feedback.ts:39-48`, `server/utils/scm/pr-feedback.ts:510-515`). A smoke workflow that passes after
     the full one failed turns a required check green **(read)**.
   - **The newest does not win.** A long run of an older push overwrites the comment of a newer one, and the comment
     names no commit. Past 100 earlier comments, GitHub gets a new comment per run (`GitHubProvider.ts:459-470`).
   - **Silence.** With no token, or a write the host refuses, the providers answer null and nothing is logged or
     shown (`server/utils/scm/pr-feedback.ts:545-550`).

4. **Coverage figures can be lost, lowered or contradicted without a note.**
   - **The prune keeps the wrong commit.** It orders commits by their reports' last update, everything else by
     arrival. Re-running an old commit's job the same day makes it the newest, and the next sweep removes the file
     detail of the two commits that really are (`server/utils/coverage-reports.ts:558-591`) **(run)**.
   - **A missing suite owns the trend.** A commit whose unit job failed or uploads later gets end-to-end totals alone
     (20% where the previous commit read 84%), and that is the day's trend point, with no mark
     (`server/utils/coverage-totals.ts:264-285`) **(run)**.
   - **Disagreement erases.** Two shards that name different versions of one file (line endings, a build step, a
     backend redeployed mid-run) leave the file with no version, and a file with no version counts nothing: 0 of 0
     for the commit (`server/utils/coverage.ts:803-815`, `shared/coverage-combine.ts:302-304`) **(run)**.
   - **A five-second timer.** Totals, trend rows and the comment's refresh are computed by an in-process timer five
     seconds after the last upload. A restart in that window leaves the commit without them, and nothing recomputes
     them on the default branch (`server/utils/coverage-totals.ts:700-730`) **(read)**.

5. **Browser coverage is wrong or empty in cases nothing reports.**
   - **Large inline source maps.** The map's URL is searched in the last 4,096 characters of the script
     (`packages/core/src/source-map.ts:321-325`). A longer inline map, which is what Vite and Nuxt dev servers serve
     for most modules, is not found, so function and line ranges are those of the compiled output **(run)**.
   - **Same-site popups.** A page opened with `window.open` shares its opener's renderer. Its coverage is lost, and
     what the opener ran before the popup opened is lost with it
     (`packages/reporter/src/internal/capture/code-reach.ts:939`, `:860-861`) **(run)**.
   - **A second coverage client.** A suite that already uses `page.coverage` (monocart, v8-to-istanbul) records no
     Piwi coverage at all (`code-reach.ts:999-1003`) **(run)**.
   - **Other browsers.** Firefox and WebKit projects record nothing, and a misspelled `coverage.browser` value turns
     coverage off; neither logs a line (`code-reach.ts:901`, `coverage-settings.ts:50-61`) **(read)**.

6. **The editors show the wrong lines after the most natural action.**
   - **One local run hides the rest.** After an edit, the test a person runs records the file's new version, and the
     editor then reads that version alone: every line the other tests ran reads "no test runs this line"
     (`packages/editor/src/coverage.ts:266-270`, `:363-391`) **(run)**.
   - **Run with Coverage records none.** VS Code's coverage profile starts a run without the coverage option, then
     shows whatever the instance already held (`apps/vscode/src/test-explorer.ts:196`, `:775-781`) **(read)**.
   - **Covered above total.** The Test Coverage view can be handed 10 covered lines of 4
     (`apps/vscode/src/glue.ts:1090`) **(run)**.
   - **No uncovered change outside Nuxt.** The mark can only appear on `pages/**`, `server/api/**` and
     `server/routes/**`, so an ASP.NET Core project, which the docs name, gets none
     (`packages/editor/src/coverage.ts:56-60`) **(run)**.

7. **A probe run can touch what the test keeps away, and can stall.**
   - **Mocked requests go out.** The probe intercepts with `page.route('**/*')` and `route.fetch()`. A request the
     test mocks with `context.route` reaches the real backend, and the verdict is decided on a response the test
     never sees (`packages/reporter/src/internal/probe/interception.ts:146`, `:234`) **(run)**.
   - **Streams are withheld.** A server-sent event stream is buffered whole before it is passed on; the pair every
     page shares is planned first, so a first probe run waits on each test (`interception.ts:234-235`) **(run)**.
   - **A green job with nothing.** `piwi probe` exits 0 when Playwright did not start or no outcome was written
     (`packages/reporter/src/cli/probe.ts:144`, `:155-158`) **(read)**.

8. **The extension's Tested elements figure depends on the page key, and the key is fragile.**
   - **Unknown key.** On a page whose key no run recorded (a slug, a 24-character id, a locale prefix, a trailing
     slash), the panel reads "0/34 tested" and "No locator of the project finds anything on this page" while two
     rows beside it name locators that match (`apps/extension/src/content/coverage-overlay.ts:409-415`) **(run)**.
   - **Hash routes.** The fragment is not part of the key (`packages/core/src/page-key.ts:53`), so every view of a
     hash-routed application is one page, and another view's locators read "Not found as the page loads", which the
     docs describe as a test about to fail **(run)**.
   - **The percentage mixes two things.** An element a test only asserted on, and every interactive ancestor of a
     matched node, count as tested (`coverage-scan.ts:302-343`) **(read)**.

9. **An agent cannot go from a gap to a test that closes it with the tools alone.**
   - **The accepted gap disappears.** `list_scenario_gaps` passes no status and has no status argument
     (`server/utils/mcp/tools.ts:3223-3229`), so a gap leaves every read once accepted **(run)**.
   - **Closing needs no test.** `triage_gap` with `covered-by` and no test closes the gap for good and counts for the
     detector; with a test, nothing checks that it reaches the subject (SG:4219-4231) **(run)**.
   - **No recompute, no single gap.** No tool recomputes the map, reads one gap, or reads map health, so "the gap
     closed" cannot be shown.
   - **A graph too large to read.** `get_feature_graph` on a route that 300 tests reach answers 1.2 million characters
     and leaves 100 tests out without a flag (`server/utils/feature-graph.ts:33`, `:83`) **(run)**.
   - **The assistant has no gap tool**, and its coverage tools are keyed on the file page, not on the Coverage tab
     (`server/utils/assistant/tools.ts:60-85`) **(read)**.

10. **Empty is shown as clean, on every tool.**
    - **Dashboard.** A project with no Test Map input reads "No open gaps" **(seen)**; a branch filter with no coverage
      reads "No combined coverage yet: upload a report" although the default branch has coverage; a link to a gap
      that no longer exists reads "No open gaps".
    - **Editors.** The `none` state covers nine situations (not connected, key refused, capture off, wrong project,
      file outside the root, no test ran the file) and both clients draw nothing for all of them.
    - **Extension.** Finding 8's "no locator finds anything".
    - **MCP.** `get_change_coverage` answers the same empty object for a missing token, a run of another project, a
      run with no baseline and a failed fetch.
    - **Command line.** `piwi probe` with an empty plan exits 0 without a reason; a coverage upload on a detached
      HEAD goes to the default branch without a word.

    One vocabulary of reasons, returned by the server and drawn by every client, would close a dozen findings at
    once (§11, M12).

Two findings of the earlier audit still shape what a person sees, and no defect below matters as much:

- **The ranking is still flat.** On the seeded project, 102 open gaps share 21 scores and 53 of them score 0.05 or
  0.04 **(seen)**. The order is the detectors' constants. Item M6 of the earlier audit is not built.
- **One subject still gets several rows.** 14 routes or files carry two or three gaps each, each with its own
  buttons, although one test closes them together **(seen)**.

## 1. Method

- **Scope by tool.** Nine reviews ran in parallel, one per area: the Test Map's detectors and the life of a gap;
  coverage from the wire to the figures; the pull request; capture in the reporter and the backends; probes; the
  dashboard's screens, by reading their code; the extension; the editors; agents, the command line and the docs. Each
  read the earlier audit first and reported only what it does not hold, plus the state of its ids (appendix B).
- **The dashboard, first-hand.** The Coverage tab's three views, the file page, an execution's coverage, a run's
  coverage line, the settings and Home were driven in Chromium on the seeded instance, at 1280 and 420 pixels, with
  their menus, dialogs and requests (§2).
- **Reproductions.** 63 findings are marked **(run)**: each was reproduced in a temporary test that was deleted
  afterwards. The high-severity findings that rest on reading were read again in the code for this document.
- **Limits.** A usage limit cut every review short, so depth is uneven. Not covered: change impact and test
  selection; the CSS capture and the page inventory's reader; the PostgreSQL schema and the coverage migrations; the
  Bitbucket diff path; `gate.ts`, `select.ts` and `plan.ts` of the command line; the demo's seed beyond one project.
  Nothing was run in a real VS Code, JetBrains IDE or Firefox, and `dotnet` was not installed, so every ASP.NET Core
  item is **(read)**.

## 2. What a person meets: the Coverage tab

Seen on the seeded *Web Dashboard* project unless a file is named.

### 2.1 The Gaps view

- **A row needs the docs to be read.** Each row shows a class badge (`blind-spot`), a detector id
  (`declared-never-hit`) and `Score 0.070 · churn 0.1 · age 0.1 · escape 0.1 · priority 0.1`. The four factors are
  at their floor on most rows, so the line says nothing. The row shows no age, no pull request, no run and no test,
  although the endpoint returns them.
- **Nothing to narrow the list with.** The only control is the status. The endpoint filters by kind, class and
  detector; the view offers none of them, no search and no paging, and 103 rows render at once. Past 200 gaps the
  rest cannot be reached, and the caption names a feature filter that does not exist (UI-6, TM-27).
- **Accept copies a draft nobody sees.** The button accepts the gap, fetches the draft and writes it to the
  clipboard. When the write fails, or the page is served over plain HTTP, the toast still reads "Accepted, draft
  copied to clipboard" (`app/components/gaps/GapRow.vue:56-58`), and the draft has no other place in the app (UI-1).
  Clicking Accept again, the only way to copy it again, restarts the Home queue's seven days (UI-2).
- **The draft is a skeleton.** For the finding "clickhouse (via GET /api/reports/revenue): unhandled failure", the
  draft knows the nearest test (*renders the revenue chart*) and still holds `// No reached path to this gap` and
  `// TODO: assert what clickhouse should produce`, under a test named after the gap's title. It also lists the first
  five catalog methods without a URL pattern as "matching this page", whatever the page (SG:4680, TM-31) **(run)**.
- **Covered by asks for a test case id.** The dialog takes a number. Nobody knows a test's id; a search over the
  project's tests, starting with those that reach the subject, is what the action needs (UI-11).
- **No way back.** Dismiss has no confirmation, no toast and no undo; no verdict reopens a gap; and every verdict is
  offered on every status, so Accept on a closed gap makes it accepted (UI-3). A viewer sees every button and gets
  "Triage failed" (UI-4).

### 2.2 The Map view

- **Every feature is red.** A feature takes the color of its worst gap, and the four features all hold one
  *false-comfort* gap. The earlier audit's item S12 (color by counts per class) is still open.
- **No reach figures.** A feature's line reads "8 routes · 5 pages · 12 controls · 4 tests". How many of the 8 routes
  a test reaches, the one figure a reader looks for under the word *coverage*, is not shown.
- **Words that need a glossary.** "1 hub, a node most tests reach or most features group, counts under no feature",
  and in map health "Wakes Control nobody exercises": *hub* and *wakes* are the code's words, not the reader's.
- **A node does not lead to its gaps.** The inspector shows a class badge only; the file card's "and N more open, in
  the Map view" points at a view that cannot list them (UI-9). A test node reads `test:4711`, with no title and no
  link (UI-20).
- **Without feature tags there is no way in.** A project that never wrote `piwi:feature`, which is every new project,
  gets an empty state in place of the map, and the graph opens only from a feature (UI-15).

### 2.3 The Code view and the file page

- **Three figures for one file.** The file page of `api/Users/UsersEndpoints.cs` reads "3 tests run 13 of its 28
  executable lines", then "67.9% of its 28 lines ran" (19 lines, every suite), then "15 lines no test ran", while the
  Gaps view says "9 not run" for the same file. Each is right for its population (tests or suites); nothing on the
  page says which is which.
- **A card that contradicts the header.** Beside "3 tests run 13 of its 28 executable lines", the Test Map card reads
  "File api/Users/UsersEndpoints.cs: this file · no test reaches it" (`app/components/project/FileTestMapCard.vue:63`).
  A file node never receives a reach edge, so the sentence shows on every file (UI-26).
- **The filters above the tab mostly do not apply.** Gaps and Map ignore every one of them; Code reads the branch
  only. Nothing says so (UI-12).
- **A gap's lines come from another branch.** The lines shown under a pull request's gap are the default branch's,
  with no commit named (UI-7).

### 2.4 Empty and first states

- **No input reads as no gap.** *UI Components* has no Test Map input (map health: 0 of 7). Its Gaps view reads "No
  open gaps, recompute to look against the latest graph". What to turn on is in the Map view (UI-27).
- **Recompute on that project raises a font.** Its first gaps after Recompute are `GET
  https://design.example.com/fonts/Inter-Variable.woff2: no error path under test`, then a stylesheet and a script.
  The demo seed stores asset requests and keys them with their origin; the reporter records neither (DM-1). The
  public demo shows it to anyone who clicks Recompute.
- **A request fails on every load.** On a project without coverage, the Gaps view asks `/gaps/code` and gets a 404,
  logged as an error in the console (UI-28).

## 3. The Test Map and the life of a gap

The detectors of the earlier audit's quick wins are in place: the window reads the default branch, trust is recent,
and a muted detector leaves the map and MCP. What is new is the gaps table's behavior over time.

- **Identity.** A gap is `(project, detector, key)`. That is right for a route or a control, whose key is stable, and
  wrong for anything tied to a change: a file in a pull request, an intent, a status a patch adds (TM-21, TM-22).
  Finding 2 follows from it, and so do the pull-request counts of *acted on*, which go to whichever pull request ran
  last.
- **Closing.** Three rules close a gap that is still true: a partial run's silence (TM-18), a file leaving the
  thirty candidates (TM-24), and a coverage read that failed or returned totals only, which closes every *code nobody
  executes* gap (TM-28). One rule never closes a gap that is no longer true: an *error path never executed* gap whose
  file left the thirty scanned files, which is what writing its tests does (TM-23).
- **Reopening.** A reopened gap loses its verdict (TM-19). Since TM-18 and TM-24 close and reopen gaps on ordinary
  days, an accepted gap is likely to lose its acceptance before its test is written.
- **Drift.** *Surface drift* compares with the newest run of the window, whatever its status. A run still in
  progress, or two runs finishing before one recompute, hides the new route for good (TM-20).
- **Drafts of pull-request gaps.** A *new control* draft reads `page.getByRole('/settings', { name: 'button "Save
  order"' })`; a *new error path* draft finds no node, although the route and its page exist (TM-25).
- **Detectors that still do not run.** `detectMatrix` and `detectPhantomCoverage` have no caller, and `triggers`
  edges are never written (TM-17).

## 4. Coverage figures

Beyond finding 4:

- **What is dropped is not said.** An entry without a version, an entry at another version than the commit's, and a
  file whose shards disagree all count nothing, and the only note is `no-inventory` (CV-19 to CV-21). A file at
  another version is also hidden from *Files without coverage data*.
- **A report can only grow.** A wrong upload (wrong `--root`, wrong suite) cannot be replaced or deleted; it stays
  until pruned, up to ninety days on the default branch (CV-25).
- **Two clocks.** A commit's arrival is the earliest of its reports' creation, on the server's clock, and its runs'
  start, on the reporter's. Carry-forward compares across them, so a CI clock a few minutes off reorders "the latest
  commit" (CV-24).
- **A suite's ratio reads lower than its own tool's.** A unit suite at 85% in its report reads 30% here, because the
  ratio is over every file of the commit. Both are true; only one is shown.
- **Parsers.** Cobertura with two `<source>` roots and one relative file name merges two files (CV-26); a `<line`
  followed by CRLF is dropped (CV-29); Clover XML is read as Cobertura and the upload answers "check --root"
  (CV-31); an LCOV `FNDA` before its `FN` reads the function as not run (CV-28).
- **Export.** A function reads as hit when any function that ran starts on its line; a file with functions and no
  line exports `line-rate="1"` (CV-32).
- **Still open from the earlier audit.** Scheduled browser coverage is not carried into a commit that has an
  end-to-end suite (CV-1), and no warning says a suite's file count dropped (CV-2).

## 5. The pull request

Beyond findings 2 and 3:

- **Triggers.** `pull_request_target`, a merge queue (`merge_group`) and `issue_comment` runs carry no pull-request
  number, and the branch lookup misses forks (CT-24). The CI guide still shows `on: [push]`
  (`apps/docs/guide/ci.md:32`) and names none of these.
- **Runs that should not count.** A one-test editor run on a pull-request branch starts the same analysis: it closes
  that pull request's gaps as `not-detected` and spends 50 to 70 calls to the host; the next CI run reopens them
  (CT-25).
- **A number from another repository.** The diff path uses the run's pull-request number without the repository check
  the comment path has. A suite repository run by the application repository's CI stamps gaps with the wrong pull
  request, and when that number is a closed pull request of the suite repository, the run's branch graph and
  coverage rows are deleted (`server/utils/scm/change-coverage.ts:302`, `:401-413`, CT-20).
- **Two projects, one repository.** Besides the shared comment (CT-3), one project's later post stops the other's
  coverage refresh (CT-23).
- **The gate.** A retried gate step counts twice (CT-28), and from a shard job the command exits 2 until the last
  shard ends (CT-29). The two rules about untested changes can warn but not block.

## 6. Capture: the reporter and the backends

Beyond finding 5:

- **Paths that are dropped.** A source under any directory named `public`, `static`, `dist`, `build`, `out` or
  `wwwroot` is taken for build output, wherever the directory sits (`src/public/home.js`), and dropped (CP-4).
- **Pages that close themselves.** A payment, sign-in or print window that calls `window.close()` loses everything it
  ran; only `page.close()` and `context.close()` read coverage first (CP-5).
- **A run that stops early.** With `--max-failures` or an interrupt, the "last test" never comes, so server coverage
  is fetched in `onEnd`, after Playwright stopped the `webServer`: the last batch is marked incomplete and the run
  gets an `unreachable` gap (CP-7).
- **A failed upload.** A failed chunk of run-level coverage logs one warning; later chunks are not sent, nothing
  retries, and a run saved for replay while the dashboard is down carries none (CP-6).
- **Nitro in a container.** A coverage build with no `.git` in its context writes paths relative to the application
  folder (`server/api/x.ts` for `apps/web/server/api/x.ts`), which match no repository file; no option, no warning
  (CP-10).
- **Partial runs.** The narrowing flags are read from `process.argv`, so `test.only`, `--project`, `--max-failures`
  and `--shard` still count as complete (CV-3).
- **Setup.** Browser coverage is one option, but its granularity depends on the dev server's maps (CP-1) and on
  `codeReachRoots`, which has to be guessed. Server coverage is three changes (a build flag, an environment gate, a
  reporter option). Neither side says "nothing was recorded, and here is why".

## 7. Probes

Beyond finding 7, and with the earlier audit's item M8 (probes that learn) still not built:

- **Server probes halve the client plan.** The server share of the budget is taken before the client plan and never
  returned. The form is two free-text inputs: `Throw, status-500` is stored as no fault, and `/api/r1` matches no
  route key. The person gets no error and half the probes (PB-22) **(run)**.
- **Findings from ordinary noise.** A *not handled* finding counts the whole test's console errors and dialogs, not
  those after the fault. Any application that logs one `console.error`, or a test that accepts a `confirm()`, gets a
  finding that never closes by itself (PB-23).
- **Redirects are replaced.** A route that answers 302 is fulfilled with its target under the original URL, also when
  the fault does not apply, so a probe recorded as "not applied" still changed what the page saw (PB-24).
- **Dependent tests run alone.** The plan runs by title. A test of a `describe.serial` runs without its predecessors,
  fails for that reason, and is recorded as *noticed* (PB-25).
- **First outcome.** Fixtures, a default-branch run, then a command that nothing schedules: no workflow, template,
  MCP tool or button names it. The `probes` table is read by the planner only; no screen shows an outcome, a *noticed*
  one included.

## 8. The editors

Beyond finding 6:

- **Which coverage is shown is never said.** The answer's branch is not read, no commit, run or date appears, and on
  a branch without coverage the default branch's shows as the branch's (ED-10). The file-level label is drawn by
  neither client.
- **Paths.** In a monorepo, a file outside every config folder is read against the repository's first config, so a
  page that project B covers gets "no test reaches this file" from project A (ED-5). A workspace opened through a
  symlinked path shows nothing (ED-6).
- **Edits.** A renamed file is an uncovered change on every line (ED-7); a formatter pass turns run lines into
  "changed since the coverage run" (ED-8).
- **Load.** JetBrains asks coverage for every open tab and again on each status push; VS Code asks visible editors
  only (ED-12). An unreachable instance costs two requests per pause in typing (ED-13).
- **Marks.** Run, not run and uncovered are three solid bars that differ by color alone, and the legend names the
  colors even after the person changed them (ED-14).
- **Parity.** JetBrains can run the tests behind a line and jump to the next line no test runs; VS Code cannot. VS
  Code shows a run's coverage across files; JetBrains declares the request and never calls it. Neither offers an
  action on a line no test runs.

## 9. The browser extension

Beyond finding 8:

- **Stale answers.** The pick dialog reads a cached index of any age and never revalidates, so "not reached by any
  test" can be days old (EX-3). An overlay left open keeps its index (EX-14), and changing the active project in the
  popup does not change an open overlay (EX-8).
- **Boxes in the wrong place.** Elements clipped by a scrolling ancestor get boxes outside it, over other content
  (EX-4); a modal built from a `div` is painted over by the boxes of what is behind it (EX-5).
- **Cost.** A page that never settles (a clock, an animation) is scanned again in full every 1.3 seconds; 5,000
  elements take a 586 ms scan with long tasks (EX-6).
- **Limits without notice.** Past 500 untested elements, the rest are neither boxed nor listed (EX-9); content added
  later inside a shadow root is never picked up (EX-7).
- **No next step.** An untested element offers *Copy locator* only. Part 4 of
  [`test-map-accuracy.md`](test-map-accuracy.md) (gaps on the page, record from an untested element, the viewport
  filter) is not built.
- **Privacy docs.** *Find in Piwi* puts the locators generated from the live element in the query string of a link to
  the instance, on click. The docs page says "Nothing about the page is sent to your instance", and
  `apps/docs/guide/privacy.md` does not list it (EX-19).

## 10. Agents, the command line and the docs

Beyond finding 9:

- **A gap carries no address.** `list_scenario_gaps` returns no subject, kind, feature, file or lines, so the node
  for `get_feature_graph` is guessed from the title; findings are listed unmarked; `limit: 200` returns 50 with no
  cursor (AG-4).
- **Three detectors contradict the tool's description.** The description and the skill say "never instrumented
  coverage", while *code nobody executes*, *single covering function* and *error path never executed* are raised
  from coverage (AG-5). Their evidence names at most four line ranges, with an en dash that `get_coverage` refuses
  (AG-12).
- **The skill has no path for an uncommitted change.** `get_change_coverage` needs pushed commits and a token;
  `get_impacted_tests` takes a working diff. The skill names only the first, and step 8 asks for "the test's id"
  without saying a new test has none until a run reports it.
- **The digest.** `piwi report` refuses `--dashboard gaps-digest`, which the docs tell a scheduler to use (AG-7); its
  rows and tiles link to the tab, not to the gap (AG-10).
- **A project's decline does not reach MCP.** A project that turned the Test Map off still has its gaps listed and
  triaged by an agent (AG-17).
- **Docs.** The corrections of the earlier audit's appendix B landed. What is missing is a page that starts from the
  question: no page answers "I see no gaps" or "which coverage mode do I need", and the prerequisites of combined
  coverage and change impact are stated late.

## 11. What to change, ranked

Each item names the findings it closes.

### Quick wins (S)

| # | Change | Closes |
|---|---|---|
| S1 | Restore a gap's verdict when it reopens, and mark it *reopened* in the list | TM-19 |
| S2 | Let only complete runs' silence close a gap; compare drift with the last run a recompute read | TM-18, TM-20 |
| S3 | Pull-request comment: no throw without patch coverage, always close the pending status, name the commit, refuse a post older than the newest, edit by the stored comment id, log and show why nothing was posted | CT-18, CT-21, CT-22, CT-26, CT-27 |
| S4 | Coverage: order the prune by arrival; note the entries left out and why; mark a trend point that lacks a known suite; recompute missing totals at startup | CV-17 to CV-22 |
| S5 | Reporter: read the map URL from `Debugger.scriptParsed`; warn once per cause when nothing was recorded (other browser, unknown value, second coverage client, no map); apply the build-directory rule at the root only | CP-1, CP-3, CP-4, CP-8, CP-9 |
| S6 | Probes: exit non-zero and say why when nothing ran; `maxRedirects: 0`; skip event streams; give the unused server share back; count console errors after the fault only; validate the two settings fields | PB-20 to PB-24 |
| S7 | Editors: covered is executable minus not run; pass coverage to the Coverage profile's run; resolve real paths; follow a rename; give `none` a reason and draw it | ED-2, ED-3, ED-6, ED-7, ED-9 |
| S8 | Extension: say "no run recorded this page" with the remedy; revalidate with `If-None-Match`; follow the popup's project; say when the 500 cap applies | EX-1, EX-3, EX-8, EX-9, EX-14 |
| S9 | MCP: a `status` argument and a `get_gap` tool; return the subject, node and files of each gap; cap `get_feature_graph` and flag truncation; refuse `covered-by` without a reported test; one error shape; fix the descriptions | AG-1 to AG-6, AG-9, AG-13 |
| S10 | Gaps view: show the draft in a panel; hide what the role cannot do; Reopen and Undo; a test search for *Covered by*; filters, search and paging with a total; right empty states | UI-1 to UI-6, UI-11, UI-13, UI-27, TM-27 |
| S11 | File page and Map: drop "no test reaches it" on a file node; say which figure counts tests and which suites; link a node to its gaps; `showPageLoadError` | UI-9, UI-14, UI-26 |
| S12 | Docs and command line: `piwi report --dashboard gaps-digest`; exit codes of `probe`; a CI page naming each trigger; the privacy page | AG-7, AG-19, CT-24, EX-19 |
| S13 | Demo: normalize seeded URLs as the product does and keep asset requests out of the graph | DM-1 |

### Next (M)

| # | Change | Closes |
|---|---|---|
| M1 | **A gap belongs to its pull request.** A table joining gaps and pull requests: verdicts on change gaps per pull request, close on merge or abandon, counts per pull request | TM-21, TM-22, CT-23 |
| M2 | **One card per subject**: the reasons of every detector on one route or file together, one verdict | TM-26 |
| M3 | **A draft that is a test**: the nearest test's stored steps, the fault through `page.route` for an error-state gap with the documented status, catalog methods by the shared matcher, drafts for pull-request gaps and for a range of lines | TM-25, TM-31, [`coverage-tab.md`](coverage-tab.md) |
| M4 | **Proof of closure**: *covered by* checks that the test reaches the subject or its lines on its latest run, and the gap records which test closed it | AG-2, UI-11 |
| M5 | **Coverage detectors**: rank after reading verdicts, say "30 of N files", close a gap whose file left the scope, never close on a failed read | TM-23, TM-24, TM-28 |
| M6 | **Change-time precision**: compare added lines with removed ones; skip dependency, docs and chore changes; analyze only CI runs at the pull request's head | TM-29, TM-30, CT-25 |
| M7 | **One status context and one comment section per project and run label** | CT-19, CT-3 |
| M8 | **Coverage ingestion**: run coverage in a transaction; replace and delete for a report; a history per suite with a warning when its file count drops | CV-2, CV-23, CV-25 |
| M9 | **Browser capture per renderer**: stop same-renderer pages in sequence, read a page before it closes itself, keep run-level coverage with a saved run and retry it | CP-2, CP-5, CP-6, CP-7 |
| M10 | **Editors**: place every version's lines through its own diff and unite them; decide an uncovered change by asking the pull request's rule | ED-1, ED-4, ED-8 |
| M11 | **Extension**: a scan that backs off and slices, clipping and modal awareness, *acted on* and *checked* as two figures | EX-4 to EX-6, EX-10 |
| M12 | **One vocabulary of reasons for an empty answer**, returned by the server and drawn by the dashboard, the editors, the extension, MCP and the command line | finding 10 |

Items M6 (exposure that discriminates), M8 (probes that learn), M9 (inventory) and M10 (the seeded-fault benchmark)
of the earlier audit are still the next largest gains, and none is started.

### Programs (L)

The five programs of the earlier audit stand (a reference with no setup, production signals, field-level checks, the
extension as a source, guided exploration). This audit adds one: **probe safety** (a probe run that knows what the
test mocks, runs a control first and never forwards a write the test kept local), which finding 7 makes a condition
for recommending probes on a real backend.

### Sequence

1. **S1 to S4.** They stop verdicts and figures from being lost, which every later measure reads.
2. **S5 to S13.** Each tool says the truth about what it shows.
3. **M1 to M4.** A gap has one identity, one card, a usable draft and a proven closure.
4. **The rest of M**, with the earlier audit's M6.

## 12. New feature opportunities

Each names what exists and what is missing. They are ordered by what a team would feel first.

1. **From gap to test in one place.** A panel on the gap with its draft, its files and lines, and three actions: copy,
   record (the extension's recorder opened on the gap's page), send to the editor. Exists: the draft endpoint, the
   recorder, *Send to editor*, the file page's nearest test. Missing: the panel and the hand-off.
2. **Gaps a pull request opened, closed and left.** With M1, the comment and a pull-request page say what the change
   added to the list and what its tests removed. Exists: the pull-request detectors and their close reasons.
3. **Annotations on the lines no suite ran.** Check-run annotations or review comments on the diff. Exists: the
   ranges (`ChangedLines.notRun`). Missing: a provider method. With it, the owner of each uncovered file, from the
   CODEOWNERS file already fetched for failures.
4. **A health card for coverage and gaps.** One place that says whether the figures can be trusted: the share of
   executions with coverage, incomplete captures, unreachable backends, the last upload of each suite, the map's
   inputs, the last probe run. Exists: `test_runs.server_coverage_gaps`, the payloads' `incomplete`, `coverage_reports`,
   map health. Missing: the card.
5. **What changed between two commits.** The files behind a coverage drop. Exists: `coverage_totals` per commit,
   suite and area, and a fragment id per report file that changes when the file's coverage does. Missing: the view.
6. **Mocked-only route**, a new detector: every response of a route in the window was fulfilled by the test, so the
   real backend is never exercised. Exists: `network_requests.fulfilled`.
7. **The value of a test.** Which tests are the only ones to run some code, and which add nothing. Exists:
   `test_coverage` and `coverage_fragments`; `get_coverage_loss` answers on demand for 50 tests. Missing: the
   project-wide list, useful before quarantining or deleting a test.
8. **Lines only the end-to-end suite runs**, as candidates for unit tests, with their trend. Exists:
   `e2e_only_lines` in `coverage_totals` and `coverage_daily`.
9. **Reach per feature.** "Checkout: 14 of 18 routes reached, 62% of its lines." Exists: the feature map's counts and
   the files behind each node. Missing: the two figures, which are what the tab's name promises.
10. **The extension as a client of the Test Map.** The gaps of the page drawn on its elements, a verdict from the
    element's card, and the viewport filter ("no test reaches the menu on a phone"). Exists: the gaps endpoints, and
    `viewports` and each use's Playwright projects in the locator index.
11. **Actions on a line no test runs, in the editor.** Run the tests behind a line in VS Code, record or draft from an
    uncovered page, and "changed and still not run" after a local run. Exists: `piwi/coverageTests`, `marks`,
    `filePageTarget`.
12. **A probe on demand.** One gap or one test, with a control run first, as `piwi flake` has. Then faults for the
    whole test (`RouteRule.match: 'all'` exists), which makes `stale-value` real, and faults on the API fixture,
    which every `APIRequestContext` already passes through.
13. **GraphQL operations as routes.** Key `POST /graphql` by operation name, so reach, probes and gaps are per
    operation and not one verdict for the endpoint.
14. **Tools for agents and the terminal.** `get_gap`, `recompute_gaps`, `get_map_health`, the probe plan in
    read-only, and `piwi gaps` to list the first gaps and print a draft. The assistant gets the gap tools on the
    Coverage tab.
15. **Detectors whose code exists.** `detectMatrix` (a route one browser reaches) and `detectPhantomCoverage` have no
    caller; `buildTriggerEdges` would give a draft the click that causes a route; functions that only untrusted tests
    run is one join away.
16. **Capture that explains itself.** The scripts that resolved to no file, sent once per worker, and a check command
    that loads one page and prints "N scripts, M resolved, K without a map". Then workers and cross-site frames, and
    the code that `beforeAll` and global setup run.
17. **A blocking mode for the gate's two rules about untested changes**, which only warn today.
18. **A page that starts from the question**: "What do my tests miss?", with a table of what reach, server, browser,
    CSS and uploaded coverage each cost and give first, and a troubleshooting section for an empty tab.

## 13. Open questions

1. Should a change gap be keyed by pull request, or stay keyed by file with a verdict per pull request (M1)?
2. Should a partial run's evidence open a gap at all, or only add to one a full run opened?
3. Should *Accept* stay one verb for "I will write it" and "give me the draft", or become two?
4. Should hash routes enter the page key for every project, or behind a project setting, given that it changes
   existing keys?
5. Should the 30-file cap of the coverage detectors become a share of the files in scope?
6. Is a probe run acceptable against a backend the suite partly mocks, or should probes require a declared test
   backend?

## Appendix A. Defects found, with locations

Severity: **H** high, **M** medium, **L** low. *run*, *read* and *seen* as defined above; *susp.* is a suspicion.

### The Test Map and the life of a gap

| ID | Defect | Location | Sev. | How |
|---|---|---|---|---|
| TM-18 | Partial runs fill the 30-run window; their silence closes gaps that the next full run reopens | SG:1576-1584, SG:2130-2135; `shared/run-eligibility.ts:201-206` | H | run |
| TM-19 | Accept and snooze are lost when a gap closes and reopens | SG:3747, SG:3792-3795 | H | run |
| TM-20 | Surface drift is missed when a newer default-branch run exists, whatever its status | SG:2131, SG:2453, SG:508 | H | run |
| TM-21 | A change gap is one row per file: the last pull request takes it, and a verdict silences later pull requests | SG:562, SG:3774-3795 | H | run |
| TM-22 | Pull-request gaps never close once the pull request is merged or abandoned | `server/utils/scm/change-time-gaps.ts:83-103`; SG:2697-2715 | H | run |
| TM-23 | An *error path never executed* gap never closes once its file leaves the 30 scanned | `shared/handlers/code-gaps.ts:355-358`, `:388-415` | M | run |
| TM-24 | The two coverage detectors keep 30 files before reading verdicts: gaps close with nothing changed, others are never raised | `code-gaps.ts:58`, `:149-154`, `:272-274`; SG:2713-2714 | M | run |
| TM-25 | Drafts of pull-request gaps are wrong (*new control*) or empty (*new error path*) | SG:1464, SG:1489, SG:4439-4466, SG:4661-4663 | M | run |
| TM-26 | One subject gets one row per detector, each with its own verdict | SG:3718 | M | seen |
| TM-27 | The list stops at 200 with no total and no paging, while the feature map counts every gap | SG:3951; `server/api/projects/[id]/gaps/index.get.ts:48-60` | M | read |
| TM-28 | A failed or totals-only coverage read closes every *code nobody executes* gap | SG:2597; `code-gaps.ts:49-53` | M | read |
| TM-29 | *Intent without a test* opens a gap for dependency and docs changes | `shared/change-time.ts:76-98` | M | run |
| TM-30 | *New error path* reads moved lines and comments as new statuses | `shared/change-time.ts:9-14`, `:40-52` | M | run |
| TM-31 | A draft lists catalog methods with no URL pattern as matching any page; its nearest test is not ordered | SG:4597-4609, SG:4642-4655, SG:4680 | M | run |
| TM-32 | *Single covering function* trusts flaky and failing tests | `code-gaps.ts:240-268` | L | read |
| TM-33 | Evidence always says "30 runs", also with 3 stored | SG:2604, SG:2619, SG:309, SG:363 | L | read |
| TM-34 | *Fix did not hold*: "regressed N days later" counts the days to today | SG:2537, SG:1046 | L | read |
| TM-35 | Triage on a closed gap keeps `closedAt`; closures are counted without their reason | SG:4185-4237; `shared/handlers/analytics/scenario-gaps.ts:84-85` | L | read |
| TM-36 | The graph rebuild after a test merge, and the sweep's pruning, run outside the project lock | `server/api/test-cases/[id]/merge.post.ts:42`; `server/tasks/graph/sweep.ts:69-90` | L | read |

### Coverage figures

| ID | Defect | Location | Sev. | How |
|---|---|---|---|---|
| CV-17 | A late upload for an older commit makes the prune remove the newest commits' file detail | `server/utils/coverage-reports.ts:558-591` | H | run |
| CV-18 | A commit with no unit upload gets end-to-end totals alone and owns the day's trend point, unmarked | `server/utils/coverage-totals.ts:264-285`; `shared/handlers/analytics/coverage-trend.ts:198-209` | H | run |
| CV-19 | Two requests naming different versions of one file erase its coverage for the commit | `server/utils/coverage.ts:803-815`, `:1085`; `shared/coverage-combine.ts:302-304` | H | run |
| CV-20 | A report file without a version is stored and counts nothing | `shared/coverage-combine.ts:302-304`; `server/api/projects/[id]/coverage-reports.post.ts` | M | run |
| CV-21 | An entry at another version than the commit's counts zero lines and hides the file from *Files without coverage data* | `shared/coverage-combine.ts:302-304`, `:373-376` | M | run |
| CV-22 | Totals, trend rows and the comment's refresh depend on an in-process 5 s timer with no catch-up | `server/utils/coverage-totals.ts:700-730` | M | read |
| CV-23 | Run coverage merges under an in-process lock, outside a transaction: two instances lose a shard's lines | `server/utils/coverage.ts:1005-1024`, `:1039-1106` | M | susp. |
| CV-24 | A commit's arrival mixes the server's clock and the reporter's, and is kept as a minimum | `server/utils/coverage-totals.ts:219-233`, `:259-262` | M | read |
| CV-25 | A report can only grow: no replace, no delete | `server/utils/coverage-reports.ts:374-380` | M | read |
| CV-26 | Cobertura: two `<source>` roots with one relative file name merge into one file | `C/coverage-formats.ts:138-148`, `:300-301` | M | run |
| CV-27 | An upload without a branch is the default branch's; the command sends none on a detached HEAD outside a known CI | `server/utils/coverage-reports.ts:342`; `R/cli/coverage.ts:311` | M | read |
| CV-28 | LCOV: an `FNDA` before its `FN` reads as not run; two functions on one line become one | `C/coverage-formats.ts:403-414`, `:121-132` | L | run |
| CV-29 | Cobertura: `<line` followed by CRLF is dropped | `C/coverage-formats.ts:277` | L | run |
| CV-30 | Cobertura: a class with method lines and no class lines has functions and no executable line | `C/coverage-formats.ts:315-324` | L | run |
| CV-31 | Clover XML is detected as Cobertura; the upload then answers "check --root" | `C/coverage-formats.ts:73`; `R/cli/coverage.ts:437-440` | L | run |
| CV-32 | Export: a function reads hit when any function that ran starts on its line; `line-rate="1"` with no line; `FN` in the LCOV 2 form | `C/coverage-writers.ts:40-44`, `:54`, `:67-69` | L | run |
| CV-33 | `filesWithoutData.count` is the commit's while its paths are filtered by folder and area | `server/utils/coverage-summary.ts:755-760` | L | read |
| CV-34 | One commit can show two figures: the live summary and the stored totals | `server/utils/coverage-summary.ts:186-195`; `server/utils/coverage.ts:511-567` | L | read |
| CV-35 | Commit ids match as exact strings: an abbreviated id never combines with a full one | `server/utils/coverage-reports.ts:62`; `server/utils/coverage-summary.ts:251`, `:289` | L | read |
| CV-36 | The latest commit is searched in the 50 newest covered runs of every branch | `server/utils/coverage-summary.ts:222-238` | L | read |
| CV-37 | One run with a start time in the future stops per-test coverage from updating | `server/utils/code-reach.ts:220-223` | L | susp. |

### Change time and delivery

| ID | Defect | Location | Sev. | How |
|---|---|---|---|---|
| CT-18 | The comment builder throws without patch coverage: no comment, no status, a pending status left | `shared/pr-feedback.ts:347-349`, `:364-365`; `server/utils/scm/pr-feedback.ts:421-425` | H | run |
| CT-19 | One status context for every run of a commit: a passing run overwrites a failing one | `shared/pr-feedback.ts:39-48`; `server/utils/scm/pr-feedback.ts:510-515` | H | read |
| CT-20 | The diff path trusts the run's pull-request number without the repository check; a closed one deletes the run's branch rows | `server/utils/scm/change-coverage.ts:302`, `:401-413` | M | read |
| CT-21 | An older run overwrites a newer push's comment; the comment names no commit | `server/utils/scm/pr-feedback.ts:489-504`; `shared/pr-feedback.ts:594-609` | M | read |
| CT-22 | GitHub: a new comment per run once 100 comments precede Piwi's; the stored comment id is never used | `GitHubProvider.ts:459-470`; `pr-feedback-posts.ts:83`; `GitLabProvider.ts:497-507` | M | run |
| CT-23 | The check for a newer post has no project filter: one project stops another's refresh | `server/utils/scm/pr-feedback-posts.ts:65-71` | M | run |
| CT-24 | `pull_request_target`, merge-queue and `issue_comment` runs carry no pull-request number; the fallback misses forks | `R/internal/collect/metadata-collector.ts:94`; `GitHubProvider.ts:421-424` | M | read |
| CT-25 | Local, editor and partial runs rewrite a pull request's gaps and spend 50 to 70 calls to the host | `server/utils/run-finalize-side-effects.ts:151`, `:173`; `change-coverage.ts:320-349` | M | read |
| CT-26 | Nothing says why nothing was posted | `GitHubProvider.ts:454`, `:482`; `server/utils/scm/pr-feedback.ts:545-550`, `:635` | M | read |
| CT-27 | Header "Uncovered changes · 0 of 0 files" when only pull-request gaps exist | `shared/pr-feedback.ts:364-373` | L | run |
| CT-28 | A retried gate step counts twice | `server/utils/gate-evaluations.ts:93-130` | L | read |
| CT-29 | `piwi gate` from a shard job exits 2 until the last shard ends | `server/api/test-runs/[id]/gate.post.ts:133-135` | L | read |
| CT-30 | `baseSha` holds a branch name for pull-request runs, and keys a 10-minute compare cache | `change-coverage.ts:353`; `GitHubProvider.ts:170-173` | L | read |
| CT-31 | No timeout on two provider calls awaited without a catch | `GitHubProvider.ts:380`, `:404`; `server/utils/scm/pr-feedback.ts:266` | L | read |
| CT-32 | GitLab: a repeated `pending` status is rejected; no ref or pipeline id is sent | `GitLabProvider.ts:509-530` | L | susp. |

### Capture

| ID | Defect | Location | Sev. | How |
|---|---|---|---|---|
| CP-1 | An inline source map longer than 4,096 characters is not found: ranges are the compiled output's | `C/source-map.ts:321-325`; `R/internal/capture/code-reach.ts:310`, `:360` | H | run |
| CP-2 | A same-site popup loses its coverage and what its opener ran before it opened | `R/internal/capture/code-reach.ts:939`, `:860-861`; `capture-fixtures.ts:655-657` | H | run |
| CP-3 | A test that uses `page.coverage` records no Piwi coverage, without a message | `R/internal/capture/code-reach.ts:999-1003` | H | run |
| CP-4 | Sources under any directory named `public`, `static`, `dist`, `build`, `out` or `wwwroot` are dropped | `R/internal/capture/code-reach.ts:86`, `:275` | M | run |
| CP-5 | A page that closes itself loses everything it ran | `R/internal/capture/capture-fixtures.ts:671`, `:743-755` | M | run |
| CP-6 | Run-level coverage is lost when a chunk's upload or the run's submit fails | `R/internal/collect/test-coverage.ts:490-500`; `R/public/reporter.ts:1543-1544` | M | read |
| CP-7 | A run that stops early fetches server coverage after the `webServer` is gone | `R/internal/collect/test-coverage.ts:186-192`; `R/public/reporter.ts:1483-1488` | M | read |
| CP-8 | Firefox and WebKit projects record nothing, and no line says so | `R/internal/capture/code-reach.ts:901` | M | read |
| CP-9 | A misspelled coverage value turns coverage off silently | `R/internal/collect/coverage-settings.ts:50-61`; `R/internal/config/env.ts:558-561` | M | read |
| CP-10 | Nitro: paths are relative to the application folder when the build has no `.git` | `integrations/nitro/src/module.ts:59-64` | M | read |
| CP-11 | `'lines'` without a source map counts comment lines as executable | `C/code-reach.ts:111-128`, `:400-423` | L | run |
| CP-12 | The Nitro transform skips a module it cannot instrument, without a warning | `integrations/nitro/src/coverage-transform.ts:340-341` | L | read |
| CP-13 | The two backends refuse an oversized collect call with different statuses (413, 400) | `integrations/nitro/src/coverage-runtime.ts`; `PiwiServerCoverage.cs` | L | read |
| CP-14 | Source maps are fetched one at a time, 5 s each, inside the test's teardown | `R/internal/capture/code-reach.ts:465-467`, `:544` | L | susp. |

### Probes

| ID | Defect | Location | Sev. | How |
|---|---|---|---|---|
| PB-19 | A request the test mocks at context level is sent to the real backend | `R/internal/probe/interception.ts:146`, `:208`, `:234` | H | run |
| PB-20 | A streamed response is withheld while the probe buffers it | `R/internal/probe/interception.ts:234-235` | H | run |
| PB-21 | `piwi probe` exits 0 when it produced nothing | `R/cli/probe.ts:115-118`, `:144`, `:155-158` | M | read |
| PB-22 | Server probes take half the budget even when no server item can be planned; the form accepts any text | `shared/handlers/probes.ts:487-489`; `shared/server-probes.ts:62-64`, `:86` | M | run |
| PB-23 | A *not handled* finding counts console errors and dialogs from before the fault | `R/internal/capture/capture-fixtures.ts:4254-4255`, `:3154` | M | read |
| PB-24 | A redirect is replaced by its target, also when the fault does not apply | `R/internal/probe/interception.ts:234-248` | M | run |
| PB-25 | The plan runs a dependent test alone, by a substring of its title | `R/cli/probe.ts:58-63`; `R/internal/probe/mode.ts:124-128` | M | read |
| PB-26 | A page created outside a test never gets the fault | `R/internal/capture/capture-fixtures.ts:3018-3019` | L | susp. |
| PB-27 | A `test.fail()` test reads inverted | `R/internal/probe/mode.ts:124-128` | L | susp. |
| PB-28 | The temporary folder is never removed, and a failed POST loses the run's outcomes | `R/cli/probe.ts:121`, `:183-185` | L | read |

### The dashboard's screens

| ID | Defect | Location | Sev. | How |
|---|---|---|---|---|
| UI-1 | Accept reports a draft as copied when the write failed, and the draft has no other place | `app/components/gaps/GapRow.vue:56-58` | H | read |
| UI-2 | Accepting again, to copy the draft, restarts the Home queue's week | SG:4161, SG:4303 | M | run |
| UI-3 | Every verdict is offered on every status; nothing reopens or undoes; Dismiss has no confirmation | `GapRow.vue:160-167`; SG:4013-4019 | M | run |
| UI-4 | Triage and Recompute are drawn for roles that cannot use them, and the refusal's reason is dropped | `GapRow.vue:42`, `:160-167`; `GapsPanel.vue:178`, `:211-219` | M | read |
| UI-5 | A link filter (`?gap=`, `?gapPr=`, `?gapFile=`) overrides the status filter silently; its empty state reads "No open gaps" | `GapsPanel.vue:91-97`, `:185-189`, `:204-210` | M | read |
| UI-6 | Past 200 gaps the rest cannot be reached; the caption names a feature filter that does not exist | `GapsPanel.vue:52`, `:271-273`; SG:3913-3927 | M | read |
| UI-7 | A gap's lines come from the default branch, with no commit named, also for a pull request's gap | `GapsPanel.vue:130-133`; `GapRow.vue:114-118` | M | read |
| UI-8 | A file opened from the Code view can show another version with other figures, unexplained | `app/pages/projects/[id]/coverage.vue:143-151`, `:203-209` | M | read |
| UI-9 | The Map view cannot show a node's gaps, although the file card sends the reader there | `FileTestMapCard.vue:112-115`; `NodeInspector.vue` | M | read |
| UI-10 | The graph draws a subject that has no node (a file, a cluster, a bug) as a real node reached by 0 tests | `server/utils/feature-graph.ts:71-197`; `GapRow.vue:168-176` | M | run |
| UI-11 | *Covered by* asks for a numeric test case id, and its text says the gap closes on the next recompute (it closes at once) | `GapRow.vue:182-193` | M | run |
| UI-12 | Gaps and Map ignore every project filter, with no note | `app/components/project/ProjectCoverageTab.vue:57`, `:60` | M | read |
| UI-13 | The Code view says "No combined coverage yet" when the filters' branch has none and the default branch has | `app/components/project/ProjectCodeCoverage.vue:54-58` | M | read |
| UI-14 | The file page answers 200 for a missing or forbidden project | `app/pages/projects/[id]/coverage.vue:68` | M | read |
| UI-15 | Without `piwi:feature` tags, the Map view has no way into the graph and shows no gap count | `FeatureMapView.vue:278-282`; `TestMapPanel.vue:51` | M | read |
| UI-16 | Gap list responses can land out of order | `GapsPanel.vue:87-119` | L | read |
| UI-17 | The file tree asks one request per folder ever opened and renders every child | `app/components/combined-coverage/CoverageTree.vue:39-42`, `:83-140` | L | read |
| UI-18 | *Not run* and gap counts are hidden on a phone | `CoverageTree.vue:206` | L | read |
| UI-19 | An execution's coverage row opens the file without its branch or version | `ExecutionCoverageSection.vue:225`; `app/utils/coverage-view.ts:77-85` | L | read |
| UI-20 | A test node shows `test:4711`, with no title and no link | `FeatureGraphView.vue:299-303`, `:330` | L | read |
| UI-21 | Map texts point at a list that moved to the Gaps view | `FeatureMapView.vue:407-415` | L | read |
| UI-22 | Map accessibility: focusable groups inside `role="img"`, no focus ring, one badge color for two classes, paths cut at their end | `FeatureMapView.vue:288`, `:309`; `app/utils/gap-classes.ts:10-41` | L | read |
| UI-23 | "1 tests"; a file path starting with capitals and a space reads as a route; folder selection replaces history | `NodeInspector.vue:115`; SG:4439 | L | run |
| UI-24 | The Home queue's rows open the whole accepted list, name no project and stop at 100 | `app/pages/index.vue:486-491` | L | read |
| UI-25 | The analytics widgets open the tab unfiltered | `ScenarioGapsSummary.vue:49`; `NewScenarioGaps.vue:44` | L | read |
| UI-26 | The file page reads "no test reaches it" on a file some tests run | `app/components/project/FileTestMapCard.vue:63` | M | seen |
| UI-27 | A project with no Test Map input reads "No open gaps" | `GapsPanel.vue` | M | seen |
| UI-28 | The Gaps view's request for a gap's code answers 404 on a project without coverage, on every load | `server/api/projects/[id]/gaps/code.get.ts:37` | L | seen |

### The editors

| ID | Defect | Location | Sev. | How |
|---|---|---|---|---|
| ED-1 | One local run makes every other test's lines read "no test runs this line" | `E/coverage.ts:266-270`, `:363-391`; `E/server.ts:1912` | H | run |
| ED-2 | VS Code's *Run with Coverage* does not record coverage | `V/test-explorer.ts:196`, `:775-781`; `E/protocol.ts:327-334` | H | read |
| ED-3 | The Test Coverage view can get more covered lines than lines | `V/glue.ts:1090`; `E/coverage.ts:365`, `:190` | H | run |
| ED-4 | Uncovered changes never show for a server file outside Nuxt's file routing | `E/coverage.ts:56-60`, `:108` | M | run |
| ED-5 | Monorepo: a file outside every config folder is read against the repository's first config | `E/server.ts:1148-1153` | M | read |
| ED-6 | A workspace opened through a symlinked path shows no coverage | `E/workspace.ts:73-76`; `E/server.ts:1721` | M | run |
| ED-7 | A renamed file is an uncovered change on every line | `E/context.ts:1141-1143`; `E/coverage.ts:69-72` | M | run |
| ED-8 | A re-indent or a formatter pass turns run lines into "changed since the coverage run" | `E/coverage.ts:323-326` | M | read |
| ED-9 | `none` covers nine situations and both clients draw nothing for all of them | `E/server.ts:1716-1723`, `:1791-1797`; `E/coverage.ts:462-474` | M | read |
| ED-10 | Which coverage is shown (branch, commit, date) is never said | `E/piwi-client.ts:83`; `E/server.ts:1909-1910` | M | read |
| ED-11 | After a checkout, the code index is the previous branch's for up to 5 minutes | `E/context.ts:597-601`, `:848`, `:1120-1124` | M | susp. |
| ED-12 | JetBrains asks coverage for every open tab, and again on every status push | `J/PiwiCoverageMarks.kt:98`, `:138-140`; `J/PiwiProjectService.kt:917` | M | read |
| ED-13 | An unreachable instance costs two requests per pause in typing | `E/context.ts:935`; `E/server.ts:1750`, `:1779` | L | read |
| ED-14 | Run, not run and uncovered marks differ by color alone; the legend names the colors | `V/extension.ts:736-739`; `J/PiwiCoverageMarks.kt:341-343`; `E/coverage.ts:35-40` | L | read |
| ED-15 | The gap lens builds `?tab=gaps&gapFile=`, and lists nothing for a change not yet pushed | `E/piwi-client.ts:964` | L | read |
| ED-16 | Uncovered-change marks are absent on a detached HEAD, a shallow clone or an unusual default-branch name | `E/workspace.ts:127`, `:133-140`; `E/context.ts:1135-1140` | L | read |
| ED-17 | VS Code gets statement coverage only, although the functions that ran are known | `V/test-explorer.ts:200-205`, `:716-719` | L | read |
| ED-18 | The editor guide and two comments contradict the code | `packages/editor/ARCHITECTURE.md:1805`, `:1818`; `E/protocol.ts:387-390` | L | read |

### The browser extension

| ID | Defect | Location | Sev. | How |
|---|---|---|---|---|
| EX-1 | A page whose key no run recorded reads "0% tested, no locator finds anything", although locators match | `X/content/coverage-overlay.ts:409-415`; `X/content/coverage-panel.ts:725-733` | H | run |
| EX-2 | Hash routes: every view is one page, and other views' locators read "Not found as the page loads" | `C/page-key.ts:53`; `X/content/coverage-risk.ts:235-262` | H | run |
| EX-3 | Pick results read a cached index of any age and never revalidate | `X/content/results-panel.ts:439-441`; `X/devtools/panel-viewport.ts:40-41` | M | read |
| EX-4 | Elements clipped by a scrolling ancestor get boxes outside it | `X/content/coverage-layer.ts:50-75`; `X/content/coverage-scan.ts:306` | M | run |
| EX-5 | A modal built from a `div` is painted over by the boxes of what is behind it | `X/content/coverage-overlay.ts:323-329` | M | run |
| EX-6 | A page that never settles is scanned again in full every 1.3 s; 5,000 elements take 586 ms | `X/content/coverage-overlay.ts:623-630`, `:795-801`; `X/content/coverage-scan.ts:272-310` | M | run |
| EX-7 | Content added later inside a shadow root is never picked up | `X/content/coverage-overlay.ts:805-821` | M | run |
| EX-8 | Changing the active project in the popup does not change an open overlay | `X/popup/main.ts:233-243`; `X/content/coverage-overlay.ts:756-772` | M | read |
| EX-9 | Untested elements past 500 are neither boxed nor listed, with no notice | `X/content/coverage-scan.ts:135`, `:435`; `X/content/coverage-panel.ts:650-657` | M | run |
| EX-10 | The tested figure counts elements a test only asserted on, and every interactive ancestor of a match | `X/content/coverage-scan.ts:302-308`, `:332-343` | M | read |
| EX-11 | A popup override drops the branch of the matching URL mapping | `X/shared/active-project.ts` (`resolveActiveProject`) | M | run |
| EX-12 | A page element whose id starts with `piwi-` is left out | `X/content/coverage-overlay.ts:72-75`, `:85-88` | M | run |
| EX-13 | An expired key ends in "Try again" only, over stale data | `X/content/coverage-panel.ts:377-384` | L | read |
| EX-14 | The index is revalidated only when the overlay opens; "updated X ago" is the download's time | `X/content/coverage-overlay.ts:719-726` | L | read |
| EX-15 | Two English-only texts reach the panel in every language | `X/content/coverage-scan.ts:250`; `X/content/coverage-risk.ts:158` | L | read |
| EX-16 | Badges take pointer events and overlap on dense rows | `X/content/coverage-style.ts:70`; `X/content/coverage-layer.ts:263-270` | L | read |
| EX-17 | A project's own test id attribute is not observed for changes | `X/content/observed-attributes.ts` | L | read |
| EX-18 | List rows are keyed by position, so focus returns to another element's row | `X/content/coverage-panel.ts:701`, `:790` | L | read |
| EX-19 | *Find in Piwi* sends locators from the live element in a link's query, which the docs say does not happen | `X/content/results-panel.ts:414-426`; `apps/docs/features/tested-elements.md:20`; `apps/docs/guide/privacy.md` | L | read |

### Agents, the command line and the docs

| ID | Defect | Location | Sev. | How |
|---|---|---|---|---|
| AG-1 | An accepted gap disappears from every MCP read; no tool reads the accepted queue | `server/utils/mcp/tools.ts:3223-3229`; SG:3941-3942 | H | run |
| AG-2 | `covered-by` closes a gap for good with no test and no check | SG:4017, SG:4219-4231; `shared/handlers/detector-precision.ts:139` | H | run |
| AG-3 | `get_feature_graph` is unbounded (1.2 million characters) and cut at 200 nodes per level without a flag | `server/utils/feature-graph.ts:33`, `:83`; `tools.ts:3288-3293` | H | run |
| AG-4 | `list_scenario_gaps` returns no subject, node, file or lines; `limit: 200` returns 50 with no cursor | `tools.ts:3220-3253`, `:341-343` | M | run |
| AG-5 | The tool and the skill say "never instrumented coverage"; three detectors are raised from coverage | `shared/mcp-tools.ts:1915`; `code-gaps.ts:96`, `:112`, `:192`, `:328` | M | read |
| AG-6 | `draft_scenario` is described as read-only and records a row | `shared/mcp-tools.ts:1939`; SG:4486-4494 | M | run |
| AG-7 | `piwi report` refuses the gaps digest the docs tell a scheduler to print | `R/cli/quality-report.ts:22`, `:103-104`; `apps/docs/features/scenario-gaps.md:113-115` | M | read |
| AG-8 | The assistant has no gap tool, and its coverage tools are keyed on the file page | `server/utils/assistant/tools.ts:60-85` | M | read |
| AG-9 | `get_change_coverage` answers one empty object for six causes and returns no gap id | `tools.ts:3151-3193`; `server/utils/scm/change-coverage.ts:574`, `:611` | M | run |
| AG-10 | The digest's rows and tiles link to the tab, not to the gap | `shared/reports/widget-documents.ts:980-992`, `:1052` | M | read |
| AG-11 | The skill's step 8 asks for a test's id that a new test does not have | `packages/reporter/templates/skills/write-the-missing-test/SKILL.md` | M | read |
| AG-12 | A coverage gap's evidence names four ranges at most, with a dash `get_coverage` refuses | `code-gaps.ts:60-67`; `shared/coverage-insights.ts:104` | L | read |
| AG-13 | "Not found" has three shapes (`{error}`, `null`, an empty list) | `tools.ts:3261`, `:2824` | L | run |
| AG-14 | `covered-by` on a file gap stores no trace of the test | SG:4060 | L | run |
| AG-15 | "Accepted but unwritten" reads no feature and no test, and stops at 100 | SG:4308-4323; `shared/analytics/metrics.ts:329` | L | read |
| AG-16 | One widget counts a muted detector's gaps in its tile and not in its table | `shared/handlers/analytics/scenario-gaps.ts:67-75`; `feature-graph.ts:302-308` | L | read |
| AG-17 | A project's decline of the Test Map does not reach MCP, and the prompt is served whatever is declined | `server/utils/mcp/filter.ts:13-21`; `server/routes/mcp.post.ts:229-231` | L | read |
| AG-18 | `coverage upload --dry-run` reads the default scope, not the project's | `R/cli/coverage.ts:306-309` | L | read |
| AG-19 | `probe` documents no exit code | `apps/docs/reference/cli.md:298-314` | L | read |

### The demo

| ID | Defect | Location | Sev. | How |
|---|---|---|---|---|
| DM-1 | Recompute on the *UI Components* project raises gaps on a font, a stylesheet and a script, keyed with their origin | `apps/application/scripts/generate-demo-seed.mjs:724-734`, `:1947-1973` | M | seen |
| DM-2 | The demo's gaps inbox and precision ignore the persona's projects; its triage skips the schema | `app/demo/api/router.ts:3379-3403`, `:3435-3447` | L | read |

### Found on the way, outside the scope

- **A dialog left open at the test's end** kept the capture fixture's teardown from ending within 15 seconds, in the
  reviewer's harness, with coverage off and on. Not checked in a real Playwright run.
- **The legs of a GitHub Actions matrix share one run label** unless each sets its own, and then cancel each other's
  live runs. This is documented ([`ci.md`](../apps/docs/guide/ci.md#parallel-jobs-in-one-pipeline)), not a defect; it
  is noted here because CT-19 has the same cause, one identity for several jobs of a commit.

## Appendix B. The earlier audit's ids, on v0.72.0

| | Fixed | In part | Still open | Not checked again |
|---|---|---|---|---|
| Test Map | TM-3, TM-8, TM-11 | TM-1, TM-2, TM-6, TM-10, TM-12, TM-15, TM-16 | TM-4, TM-5, TM-7, TM-9, TM-13, TM-14, TM-17 | |
| Probes | PB-1, PB-3, PB-6, PB-15 | PB-2, PB-7 | PB-4, PB-5, PB-8, PB-10 to PB-14, PB-17, PB-18 | PB-9, PB-16 |
| Coverage | | CV-3, CV-6, CV-8 | CV-1, CV-2, CV-4, CV-5, CV-7, CV-10 to CV-16 | CV-9 |
| Change time | CT-4 | CT-1, CT-2, CT-6, CT-11, CT-12, CT-16 | CT-3, CT-5, CT-7 to CT-10, CT-13, CT-15 | CT-14, CT-17 |

Notes:

- **TM-2** is fixed for branches; TM-18 and TM-20 are what remains of it.
- **TM-4** (ids that do not collapse in a key) now also causes EX-1.
- **CV-3**: `--last-failed`, `--only-changed`, `--test-list` and `--grep` are partial; `test.only`, `--project`,
  `--max-failures` and `--shard` are not.
- **CV-4** is documented as a limit ([`server-coverage.md`](../apps/docs/features/server-coverage.md)).
- **CV-6** is fixed when the file version's function list is stored; without it, a nested function still reads as
  run.
- **CT-1** is fixed for branches of the same repository; the CI guide still shows `on: [push]`.
- **Appendix B of the earlier audit** (docs against code): the corrections landed, AG-5 aside.

## Appendix C. Measurements

- **The seeded Gaps list** (web-dashboard, 10 tests): 102 open gaps, 21 distinct scores; 27 gaps at 0.04, 26 at 0.05,
  11 at 0.07, 9 at 0.06. 14 subjects carry two or three gaps. 103 rows render at once **(seen)**.
- **A draft**: 9 lines for a finding whose nearest test is known, 2 of them TODO comments **(seen)**.
- **`get_feature_graph`**, a route 300 tests reach, default depth: 340 nodes, 8,100 edges, 1,226,140 characters; 100
  tests not expanded **(run)**.
- **The probe plan**: budget 10 with 10 unprobed pairs gives 10 items with server probes off, 5 with them
  on and no server item possible **(run)**.
- **The extension's scan**: 5,000 buttons and a 19-chain index, 586 ms, long tasks of 319 ms and 217 ms; a clock
  updating every 200 ms caused 6 scans in 8 s; 5,000 untested elements gave 300 rows and 500 boxes **(run)**.
- **A stream under a probe**: first chunk after 11 ms without the probe, none within 8 s with it **(run)**.
- **Coverage**: commit 1 at 92 of 110 lines; commit 2 with the end-to-end run alone at 2 of 10, as the day's trend
  point **(run)**.
