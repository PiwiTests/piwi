# Local runs in the editor

- Status: accepted
- Date: 2026-10-07

A plan to make the editor extensions keep up with the developer's own test runs. Today the VS Code extension and the
JetBrains plugin show the latest **complete CI run** of the branch, read once a minute: a test fixed and re-run from the
editor stays red until CI runs the whole suite again, the failure markers drift as the file is edited above them, the
status bar opens the dashboard when a click should refresh, and the failures are a flat list. This plan turns the
editor's own run into the thing the editor is built around: it reports back at once, its partial results overlay the
CI baseline, its failures follow the edits, its breakpoints pause the browser with Piwi's picker open, and the status
bar and the failures view are rebuilt around that loop.

**Status.** Proposed 2026-10-06. Built in one pull request, merged to `main` on 2026-10-07 (#775), in the
order of [Delivery](#delivery): every step is built (steps 1 to 6; the last one adds `run=<id>` and `origin=local` to
`branch-failures`, since "my local runs only" needs the server to read local runs alone). Where the build differs
from this text, the [docs](../apps/docs/features/editor-runs.md) and the code are right: the breakpoints have their own page,
[Breakpoints in the browser](../apps/docs/features/editor-breakpoints.md); `piwi/applyPick` takes the file as the run
reported it and answers the file's URI with the edit; the live gutter finds a test that begins by its title within its file, since the run stream's
`test-begin` carries no test case id; the verdict's counts come from the run's details; only a CI
run's failures are anchored at its commit (a developer's run ran the working tree, so its failures are followed from
the files as saved when first placed, as are a run's without a commit); a failure is dropped only when its test was
in the spec the run saw and left it, so a test with a computed title keeps its marker; a test fixed since
reads `fixed locally in run #124 (failing in run #120)`; in the finalize path only the outbound effects of a run
(notifications, the pull-request comment and status, auto-heal, AI diagnosis, the incident and interrupted events)
follow D11, while fix verification, change coverage, the scenario gaps and the hand-back outcomes run for every run as
before, each under its own use; the notice of a run that never reached the instance is its own notification
(`piwi/notice`) rather than a field of `piwi/runStatusChanged`; a rerun of a command (the Run tool window's Rerun, a
VS Code terminal shared by the runs of a folder when the shell has no integration) is recognized by its ref through
the event stream, with no second poll, and `piwi/commandStarted` tells the service when a command ran in a terminal
whose environment carries another ref; the poll backs off to five minutes while the stream is connected; and the
editors page was split, the runs, the local runs and the status bar moving to
[Runs from the editor](../apps/docs/features/editor-runs.md).

**Summary.** Six observations from using the extensions, and what each becomes:

| Observation | Part |
| --- | --- |
| The editor does not update after a run; it notices up to a minute later, and never while the run executes | [Part 1 — The editor knows when a run ends](#part-1--the-editor-knows-when-a-run-ends) |
| A run started from the editor to verify one test is a partial run, which the editor ignores: the CI failures stay, the local result is lost | [Part 2 — Partial runs count](#part-2--partial-runs-count) |
| Failure markers end up on the wrong line once the file is edited, and stay on a line that no longer fails | [Part 3 — Failures follow the edits](#part-3--failures-follow-the-edits) |
| A breakpoint should pause the browser and open Piwi's picker, as the failure-time picker already does | [Part 4 — Breakpoints open the picker](#part-4--breakpoints-open-the-picker) |
| Clicking **Piwi** in the status bar should refresh, not open the web app | [Part 5 — The status bar refreshes](#part-5--the-status-bar-refreshes) |
| The failures list is hard to read; a tree or a table would be | [Part 6 — A readable failures view](#part-6--a-readable-failures-view) |

[Part 7](#part-7--around-the-run) adds what falls out of the first six once they exist: re-running the failing tests
in one click, a verdict when the editor's run ends, live gutter icons while it runs, and the reporter version check that
tells a developer why breakpoints did nothing.

## What exists

The parts below build on code that is there today. File paths are the ones to open.

| Piece | Where | What it gives us |
| --- | --- | --- |
| The branch's latest run and its failures | `apps/application/server/utils/branch-failures.ts`, `GET /api/projects/:id/branch-failures` | The newest **complete** run (`isFullRun = 1`, finished), a CI run preferred (`CI_RUN_ORIGINS`), its failed executions with `location`, `frames`, `message`, traces and screenshot |
| The eligibility rule | `apps/application/shared/run-eligibility.ts` | One rule per use; `branch-failures` reads complete runs only and leaves out lab and investigation runs. Local, desktop and editor runs are otherwise first-class |
| The run's origin | `packages/reporter/src/internal/config/env.ts` (`PIWI_ORIGIN`, `PIWI_ORIGIN_REF`), `test_runs.origin` | A run started from the editor is stamped `editor` (`EDITOR_RUN_ENV` in `packages/editor/src/server.ts`); `GET /api/projects/:id/latest-run?origin=editor&ref=…` finds a run by the ref its launcher stamped |
| Partial-run detection | `packages/reporter/src/public/reporter.ts` (`isFullRun`, `filterDetails`) | A `--grep`, a file filter or a selection makes the run partial: what every run from the editor is |
| Run events | `GET /api/stream` (global: `run-started`, `run-finished`, `run-submitted`, `run-cancelled`, with `projectId`), `GET /api/test-runs/:id/stream` (per run: `test-begin`, `test-completed`, `run-progress`, `run-finished`), `apps/application/server/utils/run-events.ts` | Push instead of polling. Both accept the `X-API-Key` header (`extractApiKey` in `server/utils/auth.ts`); the global bus lives in process memory, so a multi-instance deployment needs sticky sessions, which polling covers |
| The editor service's run model | `packages/editor/src/context.ts` (`refreshRun`, `runBranch`, `failures`), `server.ts` (`pollRuns`, `publishFailures`, `runStatus`, `FILE_SUMMARY_REQUEST`, `FAILURES_REQUEST`) | One poll a minute (every 15 s only while the **shown** run is active, which a partial run never is); failure diagnostics placed at the reported line on whatever the file holds now, re-placed from scratch at every publish |
| The catalog's per-test status | `getProjectTestCases` in `apps/application/shared/handlers/projects.ts` (`lastStatus`, `notLabExecutionInProject`) | Reads partial and local runs too. So the gutter icon (`casesOf` in the service) can already say *passed* from an editor run while the Problems panel still says *failed*: the two answers disagree today |
| Line diffs | `@piwitests/core/line-diff` (`diffLines` → `DiffFile.hunks` with `oldStart`, `newStart`, `removed`, `added`), `committedText` in `packages/editor/src/workspace.ts` | Mapping a line of a committed file to the unsaved buffer, as the locator-break analysis already does for application files |
| The action proxy | `wrapLocator` in `packages/reporter/src/internal/capture/capture-fixtures.ts` | Every locator action and presence assertion runs through a proxy that knows its call site (`captureCallerLocation()`, cwd-relative `file:line:col`) **before** the action runs |
| The failure-time picker | `packages/reporter/src/internal/capture/pick-on-failure.ts` (`runLocatorPicker`), `inspect-on-failure.ts` (the headed, never-CI gate), `@piwitests/picker-dom` (`installPickerOverlay`, `showAnchorPicker`, `showPickerChoices`) | Piwi's own in-page overlay: pick an element, bless stable parents, confirm a ranked locator; the test timeout is lifted while it waits; the pick is folded into the run's locator snapshots |
| Send to editor | `@piwitests/core/editor-send`, `apps/vscode/src/send-listener.ts` (`POST /piwi/send` on the loopback), `apps/jetbrains/.../PiwiSendHandler.kt` (`POST /api/piwi/send` on the IDE's built-in server) | A paired, token-protected way for a process on the machine to put a locator in the editor |
| The status bar | `statusBarView` in `apps/vscode/src/glue.ts`, `Glue.statusView` in `apps/jetbrains/.../Glue.kt` | Click opens the run's page (`piwi.openRun`, `StatusAction.OPEN`) |
| The failures list | `PiwiFailuresToolWindow.kt` (a `JBList` of `WorkspaceFailure`) | Title, headline and `file:line` in one row; VS Code has the Problems panel only |
| Running tests from the editor | `piwi/runArgs` → a terminal (VS Code, `runInTerminal`) or the Run tool window (JetBrains, `PiwiCommands.run` with `KillableColoredProcessHandler`) | The command `piwi run` would build, with `PIWI_ORIGIN=editor`; the editor never learns when it ends |

## Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | Every answer comes from the editor service; the clients render. | The rule both client guides state, and the way both editors keep giving the same answers. A new feature is a service request first. |
| D2 | The service subscribes to the instance's event stream and keeps polling as the fallback. | Push makes the editor update within a second of a run ending; the poll covers an instance behind a proxy that buffers, a multi-instance deployment, and a dropped connection. The service holds the one connection per instance, not each client. |
| D3 | Partial runs overlay the baseline **server-side**, in `branch-failures`, behind an opt-in query parameter. | One query, one eligibility rule, one place the demo mirrors (`app/demo/api/router.ts` already routes to `getBranchFailures`). An older service keeps today's answer. |
| D4 | A failure is anchored to the text of its line at the run's commit, and re-placed through a line diff on every edit. | The run reports a line of a commit, not of the buffer. `diffLines` already exists; `git show <commit>:<path>` is cached per commit and file. A changed line becomes a state (*edited since the run*), not a deletion: the developer sees that a run is needed. Only a test that left the file loses its marker. |
| D5 | Breakpoints are the IDE's own line breakpoints; a run started from Piwi honors them, headed, with Piwi's overlay, never Playwright's inspector; a pick lands in the editor through Send to editor. | No new gutter concept; the pause bar extends the picker that exists; the pairing and the token exist. `page.pause()` would open the Playwright Inspector, which is what the request rules out. |
| D6 | A click on the status bar item refreshes; the run's page moves to the tooltip's links (VS Code) and to the menus (JetBrains). | What was asked. The links stay one click away. |
| D7 | The failures view is a native tree in both editors, grouped by file by default, by cluster or owner on a toggle. | A tree reads at a glance, follows the editor's theme and keyboard, and both editors have one (`TreeView`, `Tree`). A webview table would not. |
| D8 | New protocol fields are optional and new requests are additive; the service reads the project's reporter version to explain a feature the reporter cannot do yet. | A published client talks to an older service and the other way round; `PIWI_PAUSE_AT` is ignored by a reporter that predates it, which must not be silent. |
| D9 | The baseline choice is explicit, kept on the machine (VS Code `workspaceState`, JetBrains `PiwiLocalSettings`), and defaults to today's ladder. | A developer comparing with `main` or with their own runs is making a local choice, like choosing the desktop app. |
| D10 | One status bar item: it shows the live run while one executes and returns to the baseline when it ends; both are in the tooltip. | Fewer things in the bar. |
| D11 | A developer's run feeds no notification and no pull-request feedback unless it is complete: an `editor` run never, a `local` or `desktop` run only when it ran the whole suite. | A one-test re-run is the developer's business; the editor reports its verdict itself. A full local run on a pull-request branch is still a signal. |

## Part 1 — The editor knows when a run ends

**Today.** `pollRuns` reads `branch-failures` every minute, every 15 s only while the shown run is active. A run started
from the editor is partial, so it is never the shown run: the fast poll never engages for it, and the editor learns
nothing until the next minute, and then only once Part 2 makes partial runs count.

**1a. Push from the instance.** `PiwiContext` opens `GET /api/stream` on its instance with the context's key
(`X-API-Key`), in a new `packages/editor/src/run-stream.ts`: a small SSE reader over `fetch` (the service runs on the
editor's Node, 20 or later; no dependency), reconnecting with a backoff from 1 s to 60 s, one connection per instance
shared by the contexts that read it. On `run-started` / `run-initializing` for the context's project the run becomes
*live* (1c); on `run-finished`, `run-submitted` or `run-cancelled` the context runs `refreshRun()` (debounced 500 ms, so a
sharded run's shards collapse into one read). While the stream is connected, `pollRuns` backs off to five minutes; when
it drops, the poll returns to a minute. The status bar tooltip says `live` or `read every minute`.

**1b. The run the editor started.** `piwi/runArgs` and `piwi/runSelection` mint a ref per command (`ed-<8 random
chars>`) and put it in the command's environment as `PIWI_ORIGIN_REF` beside `PIWI_ORIGIN=editor` (`EDITOR_RUN_ENV`
becomes a function). The service then watches for that run: `GET /api/projects/:id/latest-run?origin=editor&ref=<ref>`
every 2 s for up to two minutes, until the run exists, then `GET /api/test-runs/:id/stream` for its `test-completed`
and `run-finished` events. The run is known to the editor as **its own**: it is the first overlay of Part 2, it drives
the live status of 1c and the verdict of Part 7, and a run that never reaches the instance (reporter not installed,
instance unreachable) is reported as such when the command ends (1d) rather than left as silence.

**1c. Live status.** `RunStatus` gains `live: { runId, status, done, total, failed, startedAt, own: boolean } | null`:
the run in progress on the branch, the editor's own or anyone's. The status bar shows `$(sync~spin) Piwi: 4/9 · 1
failing` while it runs (both clients already render an active run; the field makes the partial one visible), and the
gutter flips each test's icon on `test-completed` (Part 7).

**1d. The command's end.** The clients tell the service when the command they started ends:
`piwi/commandEnded { ref, exitCode }`. VS Code reads it from shell integration
(`window.onDidEndTerminalShellExecution`, VS Code 1.93 and later, looked up at run time like the MCP API; without it,
nothing is sent and 1b alone applies); JetBrains from a `ProcessListener` on the `KillableColoredProcessHandler`
(`processTerminated`), and the Run tool window gains **Rerun** through `RunContentExecutor.withRerun`. On the end, the
service reads the run once more; if no run with that ref exists after a few seconds, `piwi/runStatusChanged` carries
`live: null` and a `notice`: `The run ended (exit code 1) but did not reach https://piwi.example.com: is the Piwi
reporter in the Playwright config?`, shown once as a warning.

**1e. `piwi/refreshRun`.** A request that reads the run and its failures only (not the indexes, selections and
vocabulary `piwi/refresh` reads), for the status bar click (Part 5) and the view's Refresh (Part 6). It answers with
`RunStatusResult`.

## Part 2 — Partial runs count

**Today.** `getBranchFailures` picks the newest complete run on the branch, a CI run first. A developer who sees three CI
failures, fixes one and runs that test from the editor gets a green terminal and an editor that still shows three
failures; the gutter, read from the catalog, may already say *passed* for that test. The run they just made is in the
instance (`origin: editor`, `isFullRun: 0`) and nothing reads it.

**2a. The baseline and its overlays (server).** `GET /api/projects/:id/branch-failures?branch=…&overlays=1` answers:

```jsonc
{
  "run": { /* the baseline, as today */ "commit": "a1b2c3d" },
  "overlays": [
    { "id": 124, "status": "passed", "origin": "editor", "isFullRun": false, "startTime": "…", "commit": "a1b2c3d",
      "totalTests": 1, "passedTests": 1, "failedTests": 0, "flakyTests": 0, "skippedTests": 0 }
  ],
  "failures": [ { /* as today */ "source": "baseline" | "overlay", "runId": 120, "browserName": "chromium",
                  "clusterTitle": "…", "isNew": true, "owner": "@team-checkout", "duration": 4120 } ],
  "resolved": [ { "testCaseId": 7, "title": "…", "file": "…", "line": 12, "browserName": "chromium",
                  "runId": 124, "executionId": 9001, "baselineExecutionId": 8800 } ]
}
```

- **Overlays** are the finished runs of the branch newer than the baseline that the `branch-failures` use does not
  exclude (lab and investigation runs stay out; incidents stay out), **whatever their origin and whether partial or
  full**, newest first, at most 20. A newer complete CI run would be the baseline itself, so overlays are by
  construction the partial runs and the local full runs since the last CI run: exactly the developer's verification
  runs. Without `overlays=1` nothing changes.
- **Per test and Playwright project** (`testCaseId`, `browserName`), the newest last-attempt status across the
  baseline and the overlays wins (`lastAttempts` from `#shared/status-classify`, as today). A failure whose newest
  status is `failed` or `timedOut` is in `failures` with the execution that failed last and `source` saying where; a
  baseline failure whose newest status is `passed` moves to `resolved`; a test that passed in the baseline and failed
  in an overlay is a `failures` item with `source: 'overlay'` and `isNew: true`. An overlay that did not run the
  failing test's project (CI failed on `firefox`, the developer re-ran on `chromium`) does not resolve it; the item
  says `passed on chromium in run #124` in `note`.
- **Extra fields on each failure**, cheap joins the view needs (Part 6): `browserName` and `duration` from the
  execution, `isNew` from `isNewRegression`, `clusterTitle` from `failure_clusters.title`, `owner` from
  `test_cases.owner`. The runs carry `commit` from `metadata.scm.commit` (Part 3 reads it).
- Files: `server/utils/branch-failures.ts` (`getBranchFailures(db, projectId, branch, { overlays })`),
  `server/api/projects/[id]/branch-failures.get.ts` (the parameter, the OpenAPI description), `shared/run-eligibility.ts`
  (an `editor-overlay` entry in `RUN_USES`, `completeOnly: false`, so the rule stays in one place),
  `app/demo/api/router.ts` (pass the query through), `tests/unit/branch-failures.test.ts` (a partial editor run
  resolving a baseline failure; one failing a passing test; the browser mismatch; a lab run ignored),
  `tests/branch-failures.spec.ts` (one end-to-end case through the reporter with `PIWI_ORIGIN=editor`).

**2b. The cumulative model (service).** `PiwiClient.branchFailures(projectId, branch, { overlays: true })`;
`PiwiContext.failures` keeps the whole answer. `publishFailures` labels the diagnostic's message with its source:
`… (removes a row, CI run #120)` as today, `… (removes a row, your run #124, 3 min ago)` for an overlay the editor
started, `… (removes a row, local run #124)` for another local run. A resolved failure publishes nothing. `fileSummary`
gives a resolved test `status: 'passed'` with its title `passed locally in run #124 · failing in CI run #120 · push to
verify`, and `piwi/failures` lists resolved items with `state: 'fixed-locally'` for the view. `RunStatus` gains
`resolved: number` and `overlays: number`; the status bar says `Piwi: 2 failing · 1 fixed locally`.

**2d. What a developer's run must not do.** `finalizeRun`'s side effects (`server/utils/run-finalize-side-effects.ts`)
run `emitRunNotifications` and `postRunPrFeedbackInBackground` for every run the `notifications` use accepts, and that
use excludes lab runs and incidents only; neither `scm/pr-feedback.ts` nor `notifications/run-notifications.ts` reads
`isFullRun` or the origin. So a developer verifying one test from the editor, on a branch with an open pull request,
posts a pull-request comment and sends the team's notifications for a one-test run. Once Part 1 and this part make
the editor's runs frequent, that is noise at best. PR 1 changes the `notifications` use: an `editor` run never feeds
it (the editor gives its own verdict, Part 7), and a `local` or `desktop` run feeds it only when complete (a full
local run on a pull-request branch is a legitimate signal; a one-test re-run is not), as a `completeOnlyFor` list on
the rule beside `excludes`, with its unit tests and a line in `reference/test-metadata.md`.

**2c. Choosing the baseline.** A new notification `piwi/setBaseline { root, choice }` with `choice` one of
`{ kind: 'ladder' }` (today's: the checked-out branch, else the default branch, else any), `{ kind: 'branch', branch }`,
`{ kind: 'run', runId }` or `{ kind: 'local' }` (no CI baseline: the newest local full run, else the overlays alone, for a
developer working offline from CI). `RunStatus.baseline` describes the choice and the run it found. VS Code: **Piwi:
Compare with…** (a QuickPick listing the ladder, the default branch, the branches with runs, *a run by id…*, *my local
runs only*), kept in `workspaceState`; JetBrains: the same under **Tools → Piwi** and the view's toolbar, kept in
`PiwiLocalSettings`. The status bar tooltip and the view's header name the baseline. This item ships after 2a and 2b,
which are useful without it.

## Part 3 — Failures follow the edits

**Today.** `publishFailures` puts each diagnostic on `site.line - 1` of the current buffer, and does so again from
scratch whenever anything changed (a poll, a refresh, a document opened). VS Code shifts a diagnostic along with the
edits until the next publish, then it jumps back. A failure whose line the developer rewrote stays an error until a
complete run covers it.

**3a. The anchor.** With `run.commit` from Part 2a, the service reads the file as that commit holds it:
`committedTextAt(repoRoot, commit, repoRelative)` in `workspace.ts` (`git show <commit>:<path>`, null when the commit is
not in the local repository), cached per commit and file for the life of the run. Without it (no commit on the run, a
commit not fetched, a file outside the repository), the anchor is the text of the buffer the first time the failure is
placed, kept with the failure.

**3b. The placement.** One pure function in `analysis.ts`, unit-tested in `tests/analysis.test.ts`:

```ts
/** Where a line of `before` is in `after`, through the hunks of `diffLines(path, before, after)`. */
export function placeLine(line: number, hunks: DiffHunk[]): { line: number; state: 'same' | 'moved' | 'edited' | 'gone' };
```

A line before every hunk is `same`; a line after hunks shifts by their net size (`moved`); a line inside a hunk's
removed block whose text is among the hunk's added lines (whitespace trimmed) is `moved` to that line; inside a hunk
with no such line it is `edited`, placed on the hunk's first added line, or on the line before the hunk when the hunk
only removes. Then: `same` and `moved` keep today's rendering; `edited` publishes at `DiagnosticSeverity.Information`
with the message prefixed `Edited since run #120 — run the test to verify:` and the quick fix **Run this test**
(`piwi.runTests` with the test's id); and when the test's `test(…)` call itself is gone from the buffer (no `TEST_CALL`
match by title), the failure publishes nothing (`gone`). The same mapping moves the failure's `frames` (the hover's
call chain), `TestFailure.line` and the `✗ reason`, **Screenshot** and **Trace** summary lines, and the `line` of each
`piwi/failures` item, so the Problems panel, the CodeLens, the gutter background and the view move together.

**3c. Live.** `documents.onDidChangeContent` already debounces `validate` through `schedule`; the same timer re-places
the failure diagnostics of that document (one diff of one file; the committed text is cached) and publishes when the
placement changed. `TestFailure` gains `state`, and `piwi/failuresChanged` (a new notification carrying
`FailuresResult`) tells the clients that the list changed without the run changing; the JetBrains annotator and Code
Vision already re-read `fileSummary` on each daemon pass.

**3d. After a run.** A local run covering the test (Part 2) replaces the `edited` state with its real result: the
overlay's execution carries its own location at the overlay's commit, anchored the same way.

## Part 4 — Breakpoints open the picker

**Today.** The failure-time picker (`pickLocatorOnFailure`, `inspectOnFailure`) opens Piwi's overlay on the page a test
failed on, after the failure. Nothing pauses a running test at a line; `page.pause()` opens Playwright's inspector.

**4a. The pause (reporter).** A new environment variable, `PIWI_PAUSE_AT`, lists the lines to pause at:
`tests/login.spec.ts:42,tests/pages/checkout.page.ts:9` (cwd-relative or absolute; matched the way the proxy's
`callerLocation` is written, `file:line`, so a page-object line pauses too). In `wrapLocator`, right before
`callMethod(target, prop, callArgs)` for an action method, and before `_expect`, the proxy asks `pauseAt.shouldPause(
callerLocation)` (a new `packages/reporter/src/internal/capture/pause-at.ts`, unit-tested: the parsing, the matching,
the gate). The gate is the one `inspect-on-failure.ts` has (headed, never under CI); under CI or headless, the variable
is ignored and the reason is logged once, as `environmentalSkipReason` does today. On a pause the fixture highlights
the element (`locator.highlight()`), lifts the test timeout and re-arms it with the time spent paused once resumed
(`testInfo.setTimeout(remaining)`), and opens the pause bar.

**4b. The pause bar (picker-dom).** A new `showPauseBar(arg)` in `packages/picker-dom/src/overlay-pause.ts`, exported
from the package's index, injected with `page.evaluate` like the other overlays and answered over the same `global`
transport (`__piwiPauseState`): a bar at the top of the page with the place (`login.spec.ts:42`), the action about to
run and its locator (`click · getByRole('button', { name: 'Pay' })`), and four buttons: **Resume** (run on to the next
breakpoint), **Step** (pause again at the next action, breakpoint or not), **Pick a locator** (the existing element →
anchors → confirm flow; the bar returns once a locator is confirmed or the pick is dismissed), **Finish** (resume and
pause no more in this test). Esc resumes. Every attempt pauses; **Finish** disables the test's pauses for the attempt.

**4c. The pick lands in the editor.** The editor passes its Send to editor pairing to the run it starts, as
`PIWI_EDITOR_SEND=<url>#<token>` (the address **Pair with Piwi Picker** copies; VS Code starts its listener when a run
with breakpoints starts, if it is not running). On a confirmed pick the fixture posts
`{ kind: 'locator', text: "getByRole('button', { name: 'Pay now' })", at: { file: 'tests/login.spec.ts', line: 42 } }`
to it: `EditorSendPayload` gains the optional `at` (validated in `parseSendPayload`: a relative path, a positive line).
With `at`, the editor asks the service for the edit, `piwi/applyPick { uri, line, locator }`, which replaces the
locator on that line (`replaceLocatorOnLine` in `analysis.ts`, the chain the pause named first); when the line no
longer holds it, the client inserts the locator at the caret as a plain send does and says so. The pick is also
printed in the terminal and folded into the run's snapshots as the failure-time picker does (`applyPickToSnapshots`),
so the dashboard's healing panel shows it too.

**4d. The editors.** `RunTestsArgs` gains `breakpoints?: Array<{ uri: string; line: number }>` (0-based). VS Code reads
`vscode.debug.breakpoints` (the enabled `SourceBreakpoint`s whose file the context holds), JetBrains
`XDebuggerManager.getInstance(project).breakpointManager.allBreakpoints` (the `XLineBreakpoint`s, enabled, in the
project's files). With breakpoints, `piwi/runArgs` writes `PIWI_PAUSE_AT` into `RunCommand.env` with cwd-relative
paths, appends `--headed` to the arguments and the command, and the client adds `PIWI_EDITOR_SEND`. So a breakpoint
set with the IDE's own gutter click pauses the next run Piwi starts: **Run them**, **Run the tests that reach this
file**, **Run selection…**, **Run this test** (Part 3b), **Re-run the failing tests** (Part 7). A setting turns it off
(`piwi.breakpoints`, default on; **Settings → Tools → Piwi** in JetBrains).

**4e. The reporter the project has.** The service reads `node_modules/@piwitests/reporter/package.json` under the
config's folder (once per refresh). When breakpoints are passed to a reporter older than the one that ships
`PIWI_PAUSE_AT`, `RunCommand` carries `notice: 'Breakpoints need @piwitests/reporter 0.48 or later; this project has
0.46.'`, which the client shows once as a warning while the run starts anyway (D8).

## Part 5 — The status bar refreshes

**VS Code.** `statusBarView` returns `action: 'refresh' | 'connect' | 'none'`; a click runs `piwi.refreshRun` (Part 1e),
the item shows `$(sync~spin)` until the answer, and the tooltip becomes a trusted `MarkdownString`: the run's counts
and branch, the baseline (Part 2c), `Updated 12 s ago · live` or `· read every minute`, then the links **Open run
#120**, **Open the failures view**, **Compare with…**, **Open the dashboard**, each a `command:` link. `piwi.openRun`
stays a command and in the palette. Not connected: the click still runs **Piwi: Connect**.

**JetBrains.** `Glue.StatusAction.REFRESH` replaces `OPEN`; the click runs the light refresh (`piwi/refreshRun` and
`refreshStatus()`, not the config search `Piwi.Refresh` does), the widget text shows `Piwi: refreshing…` meanwhile, and
the tooltip carries the same sentences. A new action **Open the Latest Run in the Dashboard** (`Piwi.OpenLatestRun`)
goes under **Tools → Piwi** and in the tool window's toolbar, beside **Open in Dashboard**, which keeps opening the
file's test.

## Part 6 — A readable failures view

**6a. The data (service).** `WorkspaceFailure` grows to what a tree needs, all optional for an older service:
`file` (relative to the config), `status` (`failed` | `timedOut`), `source` (`ci` | `local` | `own`), `state`
(`failing` | `edited` | `fixed-locally`), `browserName`, `clusterId`, `clusterTitle`, `owner`, `isNew`, `duration`,
`hasScreenshot`, `testCaseId`, and `FailuresResult` gains `run` (the baseline's id, branch, counts, `startTime`),
`overlays` (id, origin, `startTime`, counts, `own`) and `updatedAt`. The service already has every value after Part 2.

**6b. VS Code: a Piwi view in the Panel.** `contributes.viewsContainers.panel` (icon `media/piwi.svg`) with one view,
`piwi.failures`, a `TreeView` (`src/failures-view.ts`, its pure grouping and labels in `glue.ts`, tested):

- The root shows the run: `Run #120 · CI · feature/x · 3 failing · 1 fixed locally · 4 min ago`, with a child
  `Your runs since: #124 (2 min ago, 1 passed)` when overlays exist.
- Groups by **file** (default), **cluster** (the roadmap's "forty red tests become three problems") or **owner**, or
  **flat**, switched from the view title menu and kept in `workspaceState`. A group's description counts its failures.
- A leaf is a test: an icon for its state (`$(error)` failing, `$(edit)` edited since the run, `$(check)` fixed locally,
  greyed), its title, `description` `file:line · chromium · new` and a tooltip with the headline and the message.
  Click opens the failing line (`vscode.open` with the selection). Inline actions: **Run this test**, **Open the trace**,
  **Open in dashboard**; the context menu adds **Open the screenshot**, **Heal** (when the healing has an edit),
  **Copy context for agent**, **Reproduce in the desktop app**.
- View title actions: **Refresh** (Part 1e), **Re-run the failing tests** (Part 7), **Open the run in the dashboard**,
  **Compare with…** (Part 2c), **Group by…**. `TreeView.badge` shows the failing count; `viewsWelcome` says why when
  the view is empty (not connected → **Connect**, no failure → `No failure in run #120`). A **Follow the editor**
  toggle reveals the node of the active file. The Problems panel keeps its diagnostics: the view complements it.

**6c. JetBrains: the tool window becomes a tree.** `PiwiFailuresToolWindow.kt` replaces the `JBList` with a `Tree` on
a `DefaultTreeModel` built by `Glue.failureTree(failures, grouping)` (pure, tested in `GlueTest.kt`), a
`ColoredTreeCellRenderer` (title, the headline in `GRAYED_ATTRIBUTES`, `file:line · browser` in
`GRAYED_SMALL_ATTRIBUTES`, the icon per state), `TreeSpeedSearch`, and the same groups as `ToggleAction`s in the toolbar,
kept in `PiwiLocalSettings`. Double-click or Enter opens the line; the right-click menu holds the per-test actions
through `PiwiCommands`. The header line above the tree keeps the connection summary and adds the run and the baseline.
A `TreeTable` (Test · Why · Where · Browser) is the alternative if the headline column needs to align; the tree ships
first.

**6d. Both.** The view refreshes on `piwi/runStatusChanged` and `piwi/failuresChanged`; while the editor's own run
executes, its node shows the live counts (Part 1c).

## Part 7 — Around the run

What the first six parts make cheap, in the order they pay off:

1. **Re-run the failing tests.** `piwi.rerunFailing`: `piwi.runTests` with the ids of every current failure (the
   baseline's and the overlays'), from the view, the status bar menu and the palette; **Run this test** on each failing
   test's reason line in the CodeLens and Code Vision, beside **Screenshot** and **Trace**. Breakpoints are honored.
2. **A verdict when the editor's run ends.** From 1b: `Piwi: run #124 — 1 of 3 CI failures fixed, 2 still failing
   (login.spec.ts › logs in, checkout.spec.ts › pays)`, with **Open the failures**, **Open in dashboard** and **Re-run
   failing**; a run with a new failure says so. A notification in VS Code, a balloon in JetBrains; the setting
   `piwi.runNotifications: 'always' | 'failures' | 'never'` (default `always`).
3. **Live gutter.** While a run streams (1c), a test that `test-completed` names flips its icon at once; a test that
   `test-begin` names shows `media/test-running.svg`. The annotator and the decorations already redraw on
   `piwi/runStatusChanged`.
4. **The reporter version** (4e), also shown in the status bar tooltip and the view's header when it is older than the
   service expects for any feature it offers.
5. **Rerun in the JetBrains Run tool window** (1d) and the terminal reuse VS Code already has.
6. **Trace and screenshot from the view** (6b, 6c) reuse `piwi.openTrace` and `piwi.openScreenshot`.

## Delivery

Each pull request ships on its own, in this order. The scopes are `app` for the server, `reporter` for the fixture, `ide`
for the service and both clients (one commit per scope), `docs` where only the docs change.

| PR | What | Parts |
| --- | --- | --- |
| 1 | `feat(app)` overlays, `commit` and the view's fields in `branch-failures`, editor runs out of notifications; `feat(ide)` the cumulative model, the labelled diagnostics, `resolved` in the status bar | 2a, 2b, 2d |
| 2 | `feat(ide)` the event stream, the editor's own run by ref, `piwi/refreshRun`, the command's end, the status bar click and tooltip | 1a–1e, 5 |
| 3 | `feat(ide)` the commit anchor, `placeLine`, the edited state, live re-placement, `piwi/failuresChanged` | 3a–3d |
| 4 | `feat(ide)` the failures view in both editors, re-run failing, run this test, the verdict, the live gutter | 6, 7.1–7.3 |
| 5 | `feat(reporter)` `PIWI_PAUSE_AT` and the pause bar; `feat(ide)` breakpoints in `piwi/runArgs`, `PIWI_EDITOR_SEND`, `at` in Send to editor, the reporter version notice | 4a–4e, 7.4 |
| 6 | `feat(ide)` the baseline choice, grouping and follow toggles kept, polish from use | 2c |

PR 1 comes first because it corrects the wrong answer the editor gives most often, and PRs 2–4 render its data. PR 5
depends on none of them beyond the entry points that run tests, and can land in parallel.

## File-by-file checklist

### Server (`apps/application/`)

- [ ] `server/utils/branch-failures.ts` — `getBranchFailures(db, projectId, branch, { overlays })`: the overlays query
      (newer than the baseline, finished, `editor-overlay` eligibility, at most 20), the per-test-and-project merge,
      `resolved`, `source`, `isNew`, `browserName`, `duration`, `clusterTitle`, `owner`, `commit` on runs.
- [ ] `server/api/projects/[id]/branch-failures.get.ts` — the `overlays` parameter and the OpenAPI description (the API
      reference is generated from it).
- [ ] `shared/run-eligibility.ts` — the `editor-overlay` use; `editor` among the origins `notifications` excludes.
      `tests/unit/run-eligibility.test.ts`.
- [ ] `app/demo/api/router.ts` — pass `overlays` to `getBranchFailures`.
- [ ] `tests/unit/branch-failures.test.ts`, `tests/branch-failures.spec.ts`.

### Editor service (`packages/editor/`)

- [ ] `src/protocol.ts` — `RunStatus.live`, `.resolved`, `.overlays`, `.baseline`, `.updatedAt`, `.notice`;
      `WorkspaceFailure` and `FailuresResult` fields of 6a; `TestFailure.state`; `RunTestsArgs.breakpoints`;
      `RunCommand.notice`; `REFRESH_RUN_REQUEST`, `FAILURES_NOTIFICATION`, `SET_BASELINE_NOTIFICATION`,
      `COMMAND_ENDED_NOTIFICATION`, `APPLY_PICK_REQUEST`.
- [ ] `src/run-stream.ts` — the SSE reader, one connection per instance, reconnection, the per-run stream.
- [ ] `src/piwi-client.ts` — `branchFailures(…, { overlays })`, `latestRunByRef`, the stream URLs.
- [ ] `src/context.ts` — the cumulative model, the own run by ref, the baseline choice, the reporter version.
- [ ] `src/workspace.ts` — `committedTextAt`, `reporterVersion`.
- [ ] `src/analysis.ts` — `placeLine`, the `PIWI_PAUSE_AT` value from breakpoints and the config root.
- [ ] `src/server.ts` — the labelled diagnostics, the edited state, live re-placement, `piwi/refreshRun`,
      `piwi/failuresChanged`, `piwi/setBaseline`, `piwi/commandEnded`, `piwi/applyPick`, `--headed` and the env in
      `piwi/runArgs` and `piwi/runSelection`, the ref in `EDITOR_RUN_ENV`.
- [ ] `tests/lsp.test.ts` — the stub instance serves `/api/stream`, `/api/test-runs/:id/stream`, `latest-run` by ref and
      `branch-failures?overlays=1`; cases for each request above. `tests/analysis.test.ts` for `placeLine`;
      `tests/run-stream.test.ts` for the reader.
- [ ] `AGENTS.md` — the new requests and notifications in the protocol list; the push-and-poll rule.

### VS Code (`apps/vscode/`)

- [ ] `package.json` — the Panel view container and view, `viewsWelcome`, the commands (`piwi.refreshRun`,
      `piwi.rerunFailing`, `piwi.runTest`, `piwi.compareWith`, `piwi.groupFailuresBy`, `piwi.followEditor`), the `view/title`
      and `view/item/context` menus, the settings (`piwi.breakpoints`, `piwi.runNotifications`).
- [ ] `src/glue.ts` — `statusBarView` with `refresh` and the tooltip links; the tree's grouping and labels; the verdict
      text. `tests/glue.test.ts`.
- [ ] `src/failures-view.ts` — the `TreeDataProvider`, the badge, follow the editor.
- [ ] `src/breakpoints.ts` — the enabled source breakpoints of a context, as `RunTestsArgs.breakpoints`.
- [ ] `src/extension.ts` — the click, the tooltip, the shell-integration end, `PIWI_EDITOR_SEND` on a run with
      breakpoints, the notifications, the live decorations.
- [ ] `src/send-listener.ts` — `at` → `piwi/applyPick`. `tests/send-listener.test.ts`.
- [ ] `media/piwi.svg`, `media/test-running.svg`.
- [ ] `tests/integration/suite.cjs` — the view lists the stub's failure; the click refreshes; a resolved failure leaves
      the Problems panel; an edit above the failing line moves the diagnostic.
- [ ] `README.md`, `AGENTS.md`.

### JetBrains (`apps/jetbrains/`)

- [ ] `Protocol.kt` — every field and request of the service's `protocol.ts` change, in the same change.
- [ ] `Glue.kt` — `StatusAction.REFRESH`, the tooltip, `failureTree`, the verdict. `GlueTest.kt`.
- [ ] `PiwiProjectService.kt` — `refreshRun`, the baseline and grouping in `PiwiLocalSettings`, the breakpoints.
- [ ] `PiwiLspServerSupportProvider.kt` — `piwi/failuresChanged`.
- [ ] `PiwiStatusBar.kt`, `PiwiActions.kt` (`Piwi.OpenLatestRun`, `Piwi.RerunFailing`, `Piwi.CompareWith`),
      `PiwiCommands.kt` (the process end, `withRerun`, `PIWI_EDITOR_SEND`, the version notice).
- [ ] `PiwiFailuresToolWindow.kt` — the tree, the toolbar toggles, the menu.
- [ ] `PiwiSendHandler.kt` — `at`. `PiwiConfigurable.kt` — the breakpoints and notifications settings.
- [ ] `plugin.xml` — the actions, the description. `PiwiPluginTest.kt` — the tree from a stub answer; the click
      refreshes.
- [ ] `AGENTS.md`.

### Reporter and shared packages

- [ ] `packages/reporter/src/internal/capture/pause-at.ts` (new), `capture-fixtures.ts` (the pause before an action and
      an assertion, the highlight, the timeout), `src/internal/config/env.ts` (`PIWI_PAUSE_AT`, `PIWI_EDITOR_SEND`),
      `tests/` for the parsing, the matching, the gate and the post.
- [ ] `packages/picker-dom/src/overlay-pause.ts` (new), `src/index.ts`.
- [ ] `packages/core/src/editor-send.ts` — `at` in the payload and `parseSendPayload`; its tests.

### Docs (`apps/docs/`, same commit as the code)

- [ ] `features/editors.md` — **After a run** (push, the own run, the verdict), **Your local runs** (overlays, the
      baseline, the labels), **Failures follow your edits**, **Breakpoints**, **The status bar** (click refreshes),
      **The failures view**, the commands table, the JetBrains section.
- [ ] `guide/capture-fixtures.md` and `features/locator-healing.md` — `PIWI_PAUSE_AT` beside the two failure-time aids.
- [ ] `reference/test-metadata.md` — the editor origin and `PIWI_ORIGIN_REF` as the editor sets them.
- [ ] `ROADMAP.md` — a *Recently shipped* entry once the last PR lands; `plans/` mirrors through `/plan-management`.

## Verification

Automated: the server's unit and end-to-end tests above; the service's `lsp.test.ts` against the stub instance (the
stream, the overlays, the placement, the breakpoints' env); `glue.test.ts` and `GlueTest.kt` for every pure rendering;
the VS Code integration suite and the JetBrains platform tests for the view and the click; the reporter's tests for the
pause with a fake page. Run typecheck, lint and the tests of each touched workspace once before each PR's final commit.

By hand, on the sample project with a running instance:

1. Push a branch whose CI run fails three tests. Open the workspace: three errors, the status bar says `3 failing`.
2. Fix one test, click its **Run this test**. Within a second of the terminal ending, the error is gone, the gutter is
   green, the status bar says `2 failing · 1 fixed locally`, the view shows the test under *Fixed locally* and the run
   under *Your runs since*, and the notification names the two still failing.
3. Add lines above a failing line: the error stays on the call. Rewrite the failing line: the marker turns into the
   information *Edited since run #120*. Delete the test: the marker leaves.
4. Set a breakpoint on a `click` line, run the test from the lens: the browser opens headed, highlights the button and
   shows the pause bar. **Pick a locator**, pick the button, confirm: the locator replaces the one on the breakpoint's
   line in the editor; **Resume** finishes the test.
5. Click the status bar item: it spins and refreshes; the tooltip's **Open run #120** opens the dashboard.
6. Switch the grouping to *cluster* and *owner*; close and reopen the editor: the choice is kept.
7. Stop the instance: the status bar says the stream is gone and the poll is back; start it: the stream reconnects.
8. The same seven in WebStorm.

## Risks

- **The event stream behind a proxy or on several instances.** A buffering proxy delays events; a multi-instance
  deployment delivers them to one instance's subscribers only. The poll stays, at a minute when the stream is down and
  five when it is up, so the worst case is today's behavior.
- **`git show` on large repositories.** One process per (commit, file), cached for the run's life; only the files that
  carry failures are read. A commit not fetched locally falls back to the buffer anchor.
- **Overlay semantics.** A local run at an older commit, or on another Playwright project, must not clear a CI failure
  by accident: the merge is per test and project, and the item says which run and project answered. A full local run
  newer than CI overrides per test, which is what the developer expects of their own run.
- **A paused test holds a worker.** The pause is headed and local only, never under CI (the gate), the timeout is
  lifted only while paused, and **Finish** ends the pauses of an attempt. A retry pauses again, so a flaky test under
  `retries: 2` pauses up to three times; the bar says which attempt it is.
- **Editor API versions.** `onDidEndTerminalShellExecution` needs VS Code 1.93 (`engines.vscode` stays at 1.91 and the
  API is looked up at run time, as the MCP API is); `XDebuggerManager` exists on 2024.1. A client without the end
  signal still gets Part 1b.
- **A pick at a line that changed.** `replaceLocatorOnLine` finds the chain the pause named; when the line was edited
  meanwhile, the editor falls back to inserting at the caret and says so, never edits blindly.
- **Protocol drift.** Every new field is optional and read defensively in both clients; `Protocol.kt` changes in the
  same commit as `protocol.ts`, as the JetBrains guide requires.

## Open questions

1. **Overlays across a detached head.** A developer checking out a commit has no branch; `refreshRun` reads the default
   branch's run. Recommendation: overlays stay on the baseline's branch; a run from a detached head records no branch
   and is not an overlay. Revisit if it comes up.
2. **Should the view also list the baseline's passing tests?** Recommendation: no; the Playwright extension's Test
   Explorer lists the suite. The view is the failures and what happened to them. A Test Explorer integration (a
   `TestController` whose runs are Piwi's runs, with `TestMessage` locations) is a possible later route for VS Code, not
   this plan.

## Not in this plan

- Running tests through a debugger. The IDE's breakpoints pause the browser with Piwi's picker; stepping through
  JavaScript stays with the editor's own debugger and Playwright's.
- A webview table in the editors. The tree is native in both; a table becomes a question only if the tree is not enough.
- Opening the trace viewer inside the editor. `npx playwright show-trace` stays the way; the dashboard's trace page is
  one click away from each item.
- Picking a locator on a failing line without a run (opening the page in a browser from the editor). It is the
  recorder's launcher with a different purpose, and belongs to a plan of its own.
