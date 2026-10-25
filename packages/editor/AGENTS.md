# Editor service — agent guide

Rules for working inside `packages/editor/` (`@piwitests/editor`, the Piwi language server). Read
[`../../AGENTS.md`](../../AGENTS.md) first for repo-wide conventions.

## What it is

One language server, bundled into `dist/piwi-language-server.cjs` by `npm run editor:build`, that every editor client
ships and starts over stdio: the VS Code extension and the JetBrains plugin. All editor logic lives here, so the
clients stay thin and both editors give the same answers.

- `src/server.ts` wires the protocol: diagnostics, quick fixes, hover and completion, plus the custom requests of
  `src/protocol.ts` (`piwi/fileSummary`, `piwi/testsForFile`, `piwi/testAt`, `piwi/testItems`, `piwi/runArgs`, `piwi/status`, `piwi/runStatus`,
  `piwi/failures`, `piwi/agentContext`, `piwi/trace`, `piwi/screenshot`, `piwi/mcp`, `piwi/renderSteps`, `piwi/coverage`, `piwi/refresh`, `piwi/refreshRun`,
  `piwi/desktopJob`, `piwi/shareDesktopJob`, `piwi/record`, `piwi/stopRecording`, `piwi/recordingCommand`,
  `piwi/pageCandidates`, `piwi/applyPick`, `piwi/runId`, `piwi/runControl`, `piwi/pausedPage`, the `piwi/setCredentials`, `piwi/setBaseline`, `piwi/commandStarted`, `piwi/commandEnded`, `piwi/declineRecord` and `piwi/setRunBreakpoints` notifications, and the
  `piwi/runStatusChanged`, `piwi/failuresChanged`, `piwi/runEnded`, `piwi/statusChanged`, `piwi/notice`,
  `piwi/desktopJobChanged`, `piwi/recordingChanged`, `piwi/recordRequested`, `piwi/coverageChanged` and
  `piwi/runSessionChanged` notifications it sends). A client renders `piwi/fileSummary` natively (CodeLens, Code
  Vision), `piwi/runStatus` in its status bar, and `piwi/failures` as a tree in both editors (the JetBrains IDEs'
  LSP client highlights open files only): each item carries its spec relative to the config, its test, cluster,
  owner, project, duration and whether it is new, and, when one context alone has a run, runs laid over none or
  failures, the answer its latest complete run (`run`), the runs laid over it (`overlays`), its baseline and when they
  were read (`updatedAt`, which alone changing sends no `piwi/failuresChanged`). Each item names the folder of its
  Playwright config (`root`), which a run of its test takes (`RunTestsArgs.root`), whatever file the failure shows in.
  The answer also holds the tree both clients draw (`tree`, `src/failure-tree.ts`, `failuresAnswer`: the run, the
  runs laid over it, the failures grouped as the last `piwi/failures` asked, `grouping`, which the service keeps for
  what it pushes), the run as its root names it (`runLabel`), the tests still failing (`failing`) and what **Re-run the
  failing tests** runs (`rerun`); a client adds a run's age and its own run in progress. When several contexts have
  one of those, the tree holds a `context` node each, in the contexts' order (its folder as `contextLabel` in
  `src/workspace.ts` names it, also `label` in `piwi/status`, its project and counts, `root`, its run's `url`), over
  that context's tree, or its run alone without a failure; the key of a node under it is the context node's and its
  own, on two lines. `run`, `overlays` and `baseline` are then left out, `runLabel` is null, and `updatedAt` is the
  latest read. The `run` node names its context too (`root`), so a client runs a context's failing tests (`rerun` with
  that `root`), chooses its baseline and shows the editor's own run in progress on the right run. `piwi/runId` reads a run id typed for **A run by id…** (1 to 2147483647, the run ids of an
  instance). `piwi/agentContext` answers the block **Copy context for
  agent** copies, for a failure the view names or the quick fix (`piwi.copyAgentContext`) names once it is picked.
- `piwi/status` says what keeps a context from the instance's data (`problemKind`: `not-configured`, `no-project`,
  `refused`, `unreachable`), so a client tells an instance that did not answer apart from a missing connection. While
  one does not answer, the contexts are read again 15 s later, then twice as long each time, up to the refresh's pace
  (`retryUnreachable`, `UNREACHABLE_RETRY_MS`).
- The latest run on the checked-out branch is read again whenever a run ends or `HEAD` moves (a checkout, a commit:
  below), and polled besides (below); while that branch has none, the default branch's, else the newest of any
  branch (`runBranch` and `checkedOut` in `piwi/runStatus`). That ladder is the default baseline; a client may choose
  another per context
  (`piwi/setBaseline { root, choice }`, `PiwiContext.baseline`): a branch's latest complete run, a run by its id
  (`branch-failures?run=`; a 400 or 404 is no run), or a developer's own runs only (`branch-failures?origin=local` on
  the checked-out branch: the newest complete local run, else the local runs alone, `run: null`). A choice is read
  once: a branch or a run with no data reads nothing else. The client keeps the choices on its machine and sends them
  in `EditorCredentials.baselines` (initialization options and every `piwi/setCredentials`), so a restarted service
  has them; credentials without `baselines` leave the choices as they are, credentials with them replace them all.
  `piwi/runStatus` carries `baseline` (the choice and `baselineLabel` in `src/context.ts`: `CI run #120 on
  feature/x`, `your local runs only`, `release (no run)`) and `branches` (the default branch, then those of the
  locator index), and `piwi/failures` the `baseline` of the context it shows.
  Its failures are published as `ci-failure` diagnostics in every file they point to, merged with the analysis of
  open documents, with the severity `EditorCredentials.failureSeverity` chooses (`error` when absent; `failureSeverity`
  in `src/server.ts`): a run on another branch than the checked-out one is a warning at most, an edited line an
  information, and `off` publishes none, while `piwi/failures`, `piwi/fileSummary` and the hover still give them. The instance lays over that run the runs of its branch finished since, whole or partial (a test
  re-run from the editor, `piwi run`, the desktop app: `branch-failures?overlays=1`), per test and Playwright project,
  the newest result winning: a failure may be listed from a later run (`source: 'overlay'`, labeled `local run #N`
  when it did not run in CI, like a failure of a baseline that did not, `your run #N` when the editor started it),
  and a failure a later run passed moves to `resolved`, which publishes no diagnostic: its test's line says
  `fixed locally in run #N` with `status: 'passed'`,
  `piwi/failures` lists it as `fixed-locally`, and `piwi/runStatus` counts it in `resolved` beside `failingTests` and
  `overlays`, which the status bars show.
  A failure follows the edits since its run (`placeLine` in `src/analysis.ts`, through the hunks of `diffLines`): its
  diagnostic, `TestFailure.line` and the reason, **Screenshot** and **Trace** lines above it, the hover's call chain and
  its `piwi/failures` item are its lines as the run reported them, placed on the files as they stand, saved or not.
  The files as the run saw them are those of its commit for a run that ran in CI (`committedTextAt` in
  `src/workspace.ts`, `git show <commit>:<path>`, read once per commit and path and kept while the latest run stays the
  same: `PiwiContext.textAtCommit`); for a run on a developer's machine, which ran their files as saved, a run without
  a commit, a commit the repository lacks, and until the commit's file is read, they are the files as saved when the
  service first placed the failure (`PiwiContext.failureAnchors`, by execution). A failure whose line changed since its
  run is an information, `Edited since run #120: …`, with `data.edited` and **Run this test** (`piwi.runTests`) first among
  its quick fixes (every failure has it), `state: 'edited'` in `TestFailure` and `piwi/failures`, and `✎ edited since
  run #120 · …` above the line; a failure whose test's `test(…)` call left its spec (it was in the spec the run saw, and
  is not in the spec as it stands) publishes nothing. The failures are placed again on the timer that analyzes an edited document,
  and when a commit's file arrives; `piwi/failuresChanged` carries `piwi/failures` whenever a line or a state changed.
  On a spec, `piwi/fileSummary` gives each test's line its latest result (`status`), the test's id (`testCaseId`, which
  VS Code's gutter hover runs) and the line its
  call ends on (`endLine`, `callEndLine`), which the clients draw in the gutter and as a background over a failing test.
  `piwi/testAt` answers where the `test(…)` call spanning a position's line starts (`testCallAt`: `TEST_CALL`,
  `callEndLine`), as Playwright's location filter takes it (`location`: `tests/checkout.spec.ts:42`, relative to the
  config's folder, in the text as it stands), the catalog test of that title (matched like the summary) and the spec's
  tests (`casesOf`), which **Run the test at the cursor**, **Verify the test at the cursor ×3** and **Run this spec**
  run; a file that is not a spec under a context's folder answers nulls, and a test Piwi does not know a location
  alone.
  `piwi/testItems` answers the tests of the workspace's specs for a client's own test tree (VS Code's Testing view):
  the catalog's specs the workspace holds (`PiwiContext.allCases`, the whole catalog a thousand cases a request, read
  once per refresh; each stored path found as a run's is, `resolveReportedFile`, under the context whose folder holds
  it), unless `catalog` is false, and the specs `uris` names (`casesOf`), each test as the spec stands (`testCalls` in
  `src/analysis.ts`: each `test(…)` call with the titled `test.describe(…)` blocks around it) with the catalog's case of
  its title in those blocks (`caseOfCall`), its location, its latest result and its failure as `piwi/fileSummary` gives
  them: both read them from `specTests` in `src/server.ts`.
  A failing test's line also carries `failure`: the line of the test its error's stack goes through (the instance sends
  the frames and the message in `branch-failures`), above which the reason, **Run this test** (`piwi.runTests` with the
  test's id), **Screenshot** and **Trace** are ordinary summary lines; the hover on any line of that stack shows the message and the call chain.
  A flaky test's line also carries the Flake Lab lines (`flakeLabLines`, from `GET /api/projects/:id/flake-lab`): its
  flaky rate and top suspect, then `piwi flake` commands run through `piwi.runCommand`, with `--server-url` only when
  the command, run from the config's folder, would find another instance (`withServerUrl`), and, while the desktop app
  runs beside a team instance, the reproduction as a desktop job (`piwi.desktopJob`, kind `flake-lab`).
- Runs are pushed, and the poll is the fallback (`src/run-stream.ts`, `src/run-watch.ts`). One server-sent events
  stream per instance and key (`GET /api/stream`, `InstanceStream`), shared by the contexts that read it, says when a
  run of their project starts or ends; it is opened again after 1 s, doubling to a minute, every five minutes after a
  404 (an instance without the route), after a 401 or 403 only on the next refresh, the periodic one or the one new
  credentials bring. Half a second after a run ends (runs that end together are read once), the context reads its
  latest run again; while its stream is connected, the poll reads it every five minutes, otherwise every minute, every
  15 seconds while a run is in progress, and every 15 seconds while a run is `live`, connected or not (`stream` and
  `updatedAt` in `piwi/runStatus`). A read that finds the same runs and failures places no failure again: it moves
  `updatedAt` alone. A run in progress on the context's branch, or the editor's own wherever it
  runs, is `live` in `piwi/runStatus`, counted through its own stream (`GET /api/test-runs/:id/stream`), with at most
  one notification every 300 ms, which places no failure again (`progressed` in `RunWatchOptions`); it goes back to
  null in the notification that brings the failures read once it ended. The tests its stream begins and ends (`test-begin`, named by its title and suite path in its spec through the
  catalog, none when the catalog cannot tell them apart: `catalogCaseOf`, and
  `test-completed`, by its id) are `PiwiContext.liveTests` until then: `running`, then their result (a pass after a
  failed attempt is flaky; a test on several projects shows the first of running, failed, flaky, passed, skipped),
  which `piwi/fileSummary` gives their line as `status` and `piwi/runStatus` as `liveTests`, so the clients draw the
  files again. Once a run of the editor's own ended and its context read the latest run, `piwi/runEnded` says once what
  it changed (`runVerdict` in `src/run-watch.ts`, from the failures read before and after), with the ref of the command
  that started it while the service keeps it (`RefWatch.carried`): its counts, the tests
  failing before that it passed (`fixed`), failed again (`stillFailing`: failing before in another run, or not new on
  the instance's word) or failed new (`newFailures`). `piwi/refreshRun` reads the runs alone, not the indexes
  `piwi/refresh` reads.
- The editor's own run: `piwi/runArgs` and `piwi/runSelection` give each command a ref (`ed-` and 8 hex characters),
  in its environment as `PIWI_ORIGIN_REF` beside `PIWI_ORIGIN=editor` and in `RunCommand.ref`; the Flake Lab lines
  and the fix plan's verification carry `PIWI_ORIGIN=editor` alone. `piwi/runArgs` runs tests by id, with the
  instance's arguments, or by location (`RunTestsArgs.locations`: a spec under the context's folder and the line of
  its `test(…)` call, `isTestLocation` and `specLocation`, which needs no instance: a test just recorded), and with
  `repeat` each test that many times without retries and without the breakpoints (`repeatArgs`:
  `--repeat-each=3 --retries=0`, for **Verify ×3**). A repeated command's run has the `test-completed` results of its
  stream counted, once per execution (`RunWatch.tally`), beside the run's counts, which hold one result per attempt,
  project and repetition (an older instance kept one per attempt and project), and its `piwi/runEnded` carries
  `repeat` (`repeatVerdict`: `Passed 3 of 3`, `Failed 1 of 3`, `Failed at least 1 of 3` when the stream missed some); when its run reached no instance, its `piwi/commandEnded`
  brings a `piwi/notice` from the exit code (`exitVerdict`). The service looks for the run carrying it
  (`latest-run?origin=editor&ref=` for two minutes: every 2 s while the instance's stream is down, every 20 s while it
  is connected, since its `run-started` names the run, and once when the stream connects; or a `run-started` whose
  metadata names it) and keeps it in `PiwiContext.ownRuns` for its lifetime: its failures read `your run #N` and are
  `source: 'own'` in
  `piwi/failures`. A client says when the command ended (`piwi/commandEnded`, with its exit code): the service reads
  the run once more and, when no run carries the ref 5 s later, sends `piwi/notice`; the instance is not asked for the
  ref again. A later run carrying it, a rerun of the command (the Run tool window's Rerun, VS Code's **Tasks: Rerun
  Last Task**), is the editor's own once the instance's stream announces it, whatever was found before;
  the service keeps the refs of the 50 latest commands. A command sent to a terminal whose environment holds another
  ref (`piwi/commandStarted` with `terminalRef`) is not looked for by its own: its run carries the terminal's ref.
- Breakpoints: `piwi/runArgs` and `piwi/runSelection` take the editor's enabled line breakpoints (`breakpoints`,
  0-based lines). Those in files under the context's folder go in the command's environment as `PIWI_PAUSE_AT`
  (`tests/login.spec.ts:42;tests/pages/checkout.page.ts:9`, relative to that folder, 1-based, separated by semicolons:
  `pauseAtValue` in `src/analysis.ts`), and `--headed`
  is appended to the arguments and the command unless it carries `--headed`, `--ui` or `--debug` (`headedCommand`);
  the client adds its Send to editor address as `PIWI_EDITOR_SEND`. The reporter's capture fixtures pause the run
  before a call Playwright's debugger stops at on those lines (a navigation, an action, a read, an assertion), with
  Piwi's pause bar, and post a locator picked there to that address with its file and line. Each refresh reads the version of `@piwitests/reporter` the context's folder
  installs (`reporterVersion` in `src/workspace.ts`: its `node_modules`, else a folder's above it up to the
  repository root), which `piwi/runStatus` carries as `reporterVersion`; with breakpoints and a reporter older than
  `PAUSE_REPORTER_VERSION` (0.48.0), `RunCommand.notice` says so, which the client shows once as a warning while the
  run starts anyway. A missing reporter says nothing. `piwi/applyPick` answers the edit that puts a picked locator in
  place of the locator chain its line holds now (`pickEditOnLine`: the chain `replaceLocatorOnLine` replaces), in the
  file at `uri`, else at `file` relative to a Playwright config's folder, open or saved; null when the line holds
  none, and the client inserts the locator at the cursor.
- Coverage (`src/coverage.ts`): the lines, functions and files each test ran, which the reporter records per test,
  each file version by its git blob id. An application file's coverage (`GET /api/projects/:id/coverage?file=&branch=`,
  the checked-out branch, which the instance completes with the default branch's) is read when the file is first
  opened or asked about, kept per file (`PiwiContext.coverage`, at most 200) and asked again with its `ETag` on a
  refresh and after a run of the context ended (its latest run or the runs laid over it changed, or `piwi/runEnded`),
  with the code index, which says which files coverage reaches. A file the code index says no coverage reaches
  (`mayHaveCoverage`: none listed, or reached through routes only) is not asked for, nor is any file once the instance
  answered the route with a 404 (`coverageRoute`, until the next refresh); either shows nothing. The marks come from the
  version whose blob id is the file's as it stands, open or saved (`textBlobIds`: as git stores it, CRLF as LF, with or
  without a byte order mark), else the version the file as saved is, for a document edited since, else the version the
  most tests recorded whose text is known (`BlobTexts`: a text seen with that blob id, else `git cat-file`), placed
  through `diffLines` and `placeLine`: a line a hunk added is `changed` (changed since the coverage run), a line it
  removed has no mark; with none of them, `other-version` and no mark. `piwi/coverage` answers the marks of a file as it
  stands (`executed` with how many tests ran each, `notRun` from the executable lines a run recorded for that version,
  `changed`, the counts and a `label`), within `LOOKUP_WAIT_MS`; `piwi/coverageChanged` pushes them, against the answer
  the client holds, when an edit, a read or a late answer changes them, only for a document it asked about. On an
  application file, `piwi/fileSummary` adds the coverage's tests to the file's `Reached by N tests` line, with
  `41 of 63 lines run` when the executable lines are known, and gives each function that ran a line at its first line;
  on a server file their `piwi.runTests` carries `coverage: 'server'`, which `piwi/runArgs` turns into
  `PIWI_COVERAGE_SERVER=lines`, so the run records the lines again; on a browser file, `coverage: 'browser'`, turned
  into `PIWI_COVERAGE_BROWSER=functions`. The hover of a line names the tests that ran it, or
  says that none runs it or that it changed since the coverage run.
  A file without coverage marks may have uncovered changes (`CoverageResult.uncovered`, `uncoveredOf` in
  `src/server.ts`), by the rule the pull request's change coverage reads (`uncoveredFile` in `src/coverage.ts`): Piwi
  can observe it (a page by the file-routing convention while the locator index knows the pages tests visit, a server
  route while the code index maps routes to tests, or executable lines a run's coverage recorded) and no test reaches
  it (code reach and routes, the coverage's tests, a test acting on its page); never without a code index or with one
  cut short. Its lines changed since the default branch are marked (`changedSince`: the lines the diff from the file at
  the merge base of `HEAD` with `origin/<default>`, else `<default>`, adds, blank ones left out:
  `PiwiContext.atChangeBase`, `mergeBase` in `src/workspace.ts`, read once per `HEAD`, each file once per base), with
  `label` saying so, the file's top line in `piwi/fileSummary` (`Uncovered changes: …`, no command) and the hover of a
  marked line (`UNCOVERED_EXPLAINED`). A move of `HEAD` computes them again.
- `src/analysis.ts` is the pure half: locators per line, stability findings, replacements, breaks of an unsaved
  change and their call-site edits, and where completion offers the suite's locator chains (`locatorCompletionSite`):
  after `page.`, `this.page.` or another page expression `pageCandidates` offers on the cursor's line (`adminPage.`,
  `this.root.`, `app.page.`), the chain alone; right after `expect(`, the chain on the default page expression there.
  The file is scanned only when the text before the cursor ends with a member chain and `.` (a method name partly
  typed after it included), or with `expect(`; `(` is a trigger character, and completion after any other `(` is
  empty. Keep new logic here, or in `@piwitests/core` when the CLI or the dashboard needs it too; never re-implement a
  core function.
- `src/context.ts` is one Playwright config of the workspace: its connection, project, branch and cached indexes.
- `src/piwi-client.ts` is the only file that talks to an instance; it opens the event streams `src/run-stream.ts` reads.
  Its requests go through `src/http.ts`: with a proxy in the service's environment (`HTTPS_PROXY`, `HTTP_PROXY`,
  `NO_PROXY`, which both clients set from the editor's proxy settings), an instance off this machine is reached
  through it (`undici`'s `EnvHttpProxyAgent`, which Node 20 and 22 lack); this machine's addresses directly.
- `src/desktop-jobs.ts` passes a failure of the team instance to the desktop app as a job (`@piwitests/core/desktop-job`,
  with the token of the app's discovery file), polls its verdict and shares a bisect's first bad commit on the instance
  with the editor's key. A `flake-lab` job carries the test's reproduce plan, read from the instance with recording on
  (`source=desktop`, this machine's name); the app runs it with `piwi flake --plan <file> --json` against itself, and
  sharing posts the arms' counts, with the plan's conditions, to the experiment the instance recorded. It is offered on
  a flaky test's line and on a failure whose test has an untested suspect (`hasUntestedSuspect`). The job names commits,
  tests and lab conditions, never code; the app runs it only after a click in its window.
- `src/recorder/` records a test from the editor. `piwi/record` reads the `use` options Playwright resolves for the
  file's config (`project-options.ts`: the project's own Playwright CLI, `playwright test --list` with
  `piwi-use-reporter.cjs` and a filter no spec matches, cached per canonical config path until the modification time
  or size of the config, of the `.env*` files of its folder and of each folder above it up to the repository's, or of a
  local module the config imports changes, five minutes at most: `configFingerprint`), picks the project (a config
  with several asks, through `projects`), the start page and the page expression, and forks the launcher in the
  config's folder (`sessions.ts`). Both run with the project's Node (`node.ts`): under an editor's Electron, the first
  `node` on the service's `PATH` when it is Node 20 or later, without `ELECTRON_RUN_AS_NODE`; else the service's own
  runtime. The launcher (`launcher.ts`) resolves the project's Playwright at run time (never
  bundled; `playwright.ts`: in the project's own `node_modules`, the test runner's package first, as for the CLI),
  opens the browser with the project's options (`context-options.ts`: `headless: false` unless
  `PIWI_RECORDER_HEADLESS=1`, Chromium's translation feature disabled, an explicit allowlist of context options, a
  missing `storageState` file left out and said so), exposes the binding before loading `record-ide.js` into every
  page, answers the recorder over it
  (`host-state.ts`: the storage areas and messages of the IDE bundle's `chrome`, every event through core's
  `parseCaptureEvent`; only the main frame of the page it opened first records, every other frame and page, such as a
  popup or a cross-origin iframe, is answered as outside a recording, and a tab or a popup the application opens is
  said once, as a `notice` the session shows as an update's message), and reports over its IPC channel (`ipc.ts`).
  The events render all the steps with `renderSpec` and the whole block goes in `piwi/recordingChanged`, in order: at
  once, or, within the update interval of the latest update (`UPDATE_INTERVAL_MS`, longer after a slow rendering),
  together once it is over; a pause, from the editor or the recorder's bar (`piwi-recording-paused`, both ways through
  the launcher), records nothing until resume and says `paused` in an update, resume sends the latest again; Stop in
  the editor or in the
  browser, closing the browser or closing the file ends the session with a last update, sent at once, and closes the
  browser. `page-candidates.ts` reads the file's text alone (a scanner in the style of `callEndLine`, no TypeScript):
  the page expressions at a caret (`piwi/pageCandidates`, also the default of `piwi/renderSteps` given a `line`; a
  fixture named like a page that no page call of the test runs on, `todoPage`, is offered after `page` as one that
  `may be a page object`), the context there (`test`, `function`, `class` or `file`, which `piwi/record` checks
  against `into`), the names declared before it (a page object already declared is not instantiated again), and where
  the block goes and how it is indented: the caret's line when blank, else a new line after it, or after the statement
  whose brackets the caret is in (a multi-line `expect(`), and a refusal inside a bracket the file never closes.
  `imports.ts` reads, in one pass of the same scanner, the names a file's import statements and top-level `require`
  declarations bind and where each ends (`importBindings`), and the modules its `test` and `expect` come from
  (`testImportOf`, `expectModuleOf`: `expect` comes from the module `test` comes from when that is `@playwright/test`
  or the file or a spec beside it imports `expect` from it, else from `@playwright/test`; a session decides it once,
  when it starts). An update and `piwi/renderSteps` carry the edit that adds the lines the file's text lacks
  (`importEdit`): after its last import statement, as `require` declarations after the last one in a file that has
  those and no import statement (`requireForm`), else at its top, placed in the text the service holds, which the
  client makes with the block's write. `piwi/renderSteps` indents the code for the caret's line (`indentBlock`).
  A test can hand its page to a recording (`recorder/handoff.ts`): the service listens on a local socket (a Unix socket
  in a new owner-only folder of the temporary directory, a named pipe on Windows), opened once initialized
  (`RecordChannel.open`), which every test run it builds names in its environment twice, as `PIWI_RUN_CHANNEL` and
  `PIWI_RECORD_CHANNEL` (`withRecording` in `src/server.ts`, which also adds `--headed` when a spec the run names holds
  a `page.pause()` call, `PAGE_PAUSE`). A connection's first line tells a hand-off (`attach`) from a worker's run
  connection (`run-attach`, below), which `onRun` hands to the run sessions. A test paused there with Piwi's bar (a breakpoint, or `page.pause()` in a headed run) that asks to
  record attaches with the channel's token, its file (as the run's folder spells it, `commandFolder`: the service
  names it to the editor as its workspace does, a folder opened through a link), line and project's `testIdAttribute`
  and `baseURL`
  (`@piwitests/core/ide-recorder`, one line of JSON a message); the client hears it as `piwi/recordRequested`, and
  starts it with `piwi/record` naming the `handoff` (`RecordParams.handoff`), which takes it out of the waiting ones;
  one not taken in 30 s (`HANDOFF_WAIT_MS`), one the client declines (`piwi/declineRecord`: the file is being
  recorded into, or cannot be opened), or whose `piwi/record` is refused, hears why at once. A run whose spec holds a
  `page.pause()` outside a comment (`withoutComments`) runs headed with `RunCommand.pauses`, for which the client
  names its Send to editor pairing as for breakpoints. The session (`attach` in
  `sessions.ts`) writes the block on a new line above the paused statement (`placementBefore` in
  `page-candidates.ts`: the line it starts on, a chain broken over lines or a statement broken after an operator, as
  an assignment after its `=`, included), renders it with `continuePage`
  (no opening `goto`, viewport size, nor first navigation, which only says where the recording began) on the page
  expression in scope there, with the config's Piwi options when read within 10 s, and drives the test's page through
  `handoffLauncher`: the test loads the bundle the service names into its page, relays every call of the recorder's
  binding, which the service's `RecorderHost` answers, and hears the pause and the stop as messages for the recorder.
- The runs the service builds are steered from the editor (`src/run-sessions.ts`, `RunSessions`): each worker of a run
  keeps a connection to the record channel's socket for its whole life (`run-attach`, `@piwitests/core/run-channel`,
  with the channel's token, compared in constant time), filed by the ref of the command (`PIWI_ORIGIN_REF`) under a
  session: its workers by Playwright's worker index, the test each one runs, where it stands stopped (`running`,
  `stopped`, `between`) and whether a Pause reached it (`pausing`). `piwi/runSessionChanged` carries a session when a
  worker connects, starts or ends a test, stops, goes on or leaves, or a Pause reaches it, at once but for the
  connection and the tests' start and end, which go at most every 300 ms (`SESSION_PACE_MS`), and only when it
  differs from the last one sent; the run ends with its command (`piwi/commandEnded`) or 5 s after its last worker
  left with none connecting (`SESSION_LINGER_MS`), in a last notification with `ended`, and a later worker of the ref
  starts a new session. `piwi/runControl` answers every control with what was asked or why not (`The test is
  running.`, `2 workers are stopped: choose one.`, a test's `cannotPause`): `pause` goes to the workers that run or are
  between tests (each stops at its next call, or the next test's first), `step`, `resume`, `finish` and `run-to` to the
  one stopped, naming its stop, which a worker past it ignores. `piwi/setRunBreakpoints` replaces the run's breakpoints
  in each worker and in each one that connects later (the 50 latest runs' are kept), and `piwi/pausedPage` asks a
  stopped worker for a JPEG of its page, null after 10 s (`PAUSED_PAGE_WAIT_MS`), when it leaves or is not stopped. A
  worker names a place relative to the run's working directory (`run-attach`'s `cwd`, the config's folder as the file
  system spells it); the session gives the client the file's URI under the folder as the workspace spells it, and takes
  the client's lines (URIs, 0-based) relative to either, refusing a file outside the run's folder, as `PIWI_PAUSE_AT`
  leaves it out. A client that shows and answers stops says so in its initialization options
  (`InitializationOptions.runControl`, as both clients do); without it, a stop no pause bar shows (a headless run's) is resumed as soon as
  it is heard, with a `piwi/notice` once per run. A worker's `notice` (a control its reporter does not take) is a
  `piwi/notice` too. The service stopping closes every worker's connection, whose stop then goes on.

`npm run editor:build` writes five files to `dist/`, which both clients ship side by side (VS Code in its `dist/`, the
JetBrains plugin in its `server/`); the service finds the others next to its own bundle, or in `PIWI_EDITOR_DIST`
(the `distDir` option of `startServer` in tests):

| File                         | What                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `piwi-language-server.cjs`   | The language server (`src/main.ts`), which logs a rejected promise nothing waits on and keeps serving.             |
| `piwi-recorder-launcher.cjs` | The launcher a recording session forks (`src/recorder/launcher.ts`).                                               |
| `piwi-use-reporter.cjs`      | The Playwright reporter that prints a config's resolved options (`src/recorder/use-reporter.ts`).                  |
| `record-ide.js`              | The recorder's IDE bundle: the browser extension's recorder, built a second time for a browser the launcher opens. |
| `record-ide-messages.json`   | The extension's catalogs for the IDE bundle, by language.                                                          |

The last two come from `buildIdeBundle`, which `build.mjs` imports from `apps/extension/scripts/build.mjs`: the build
needs the extension's sources, and a change to the recorder there changes what the editor clients ship.

## Rules

- **The protocol is a contract.** A client of an older version talks to this server, and a published client's
  commands (`piwi.openInDashboard`, `piwi.runTests`, `piwi.openTrace`, `piwi.openScreenshot`) are named in `SummaryLine.command`. A change to `protocol.ts`
  lands with both clients in the same change, and a renamed request or command is a breaking change.
- **A command is built here, never taken from the instance** (`src/commands.ts`): a test run is `npx playwright test`
  with the instance's arguments (`materialization.args`, else the words of its `npx playwright test` command line,
  split as every shell splits plain words and double quotes) or the locations a client names, each checked (a test
  filter, or an option of `PLAYWRIGHT_OPTIONS`: none that loads or writes a file) and quoted (`shellWord`); a fix
  plan's verification is its
  `npx playwright test` commands built again; a Flake Lab line is `npx @piwitests/reporter flake [verify] <id>`.
  An argument that is anything else refuses the whole command, and the clients run only what the service built.
- **A command runs in the config's folder as the file system spells it** (`commandFolder`, `canonicalPath`): every
  `cwd` the service hands a client (`piwi/runArgs`, `piwi/runSelection`, the trace, `piwi.runCommand` lines), never the
  folder as the editor spelled it, which on Windows may carry a lower-case drive letter.
- **Nothing blocks typing.** The project's indexes, failures, function catalog and vocabulary are fetched on the
  refresh timer, on `piwi/refresh` and after `piwi/setCredentials` (the failures also when a run ends, on the poll and
  on `piwi/refreshRun`), and requests answer from them. Refreshes never overlap: one asked for while another runs
  follows it (`refreshAll`). What an index gives every request (each file's call sites, a locator's stability) is
  computed once per index (`callSitesOf`, `stabilityOf` in `src/analysis.ts`). What belongs to one
  file (a spec's cases, a file's stored alternatives) or one failure (its healing, fix plan, linked issues, evidence) is
  fetched once, when first needed, and kept: only the diagnostics or the quick fix that need it wait for it, a quick fix
  or a hover for 1.5 s at most (`within`, `LOOKUP_WAIT_MS`), the fetch going on for the next ask; one that failed
  without the instance refusing it (no answer, a 5xx, a 408 or a 429) is asked again next time (`once` in
  `src/context.ts`). A canceled quick fix or hover is not answered further. A stored file (a trace, a screenshot) is
  written to `EVIDENCE_ROOT` as it arrives, never held in memory (`PiwiClient.download`): `piwi-editor` in this user's
  cache folder, created owner-only and never written to when another user owns it or it is a link (`privateFolder`).
  The files not used for a week are deleted when the service starts (`pruneEvidence`), and a file another window
  deleted meanwhile is downloaded again. A
  failure's files at its run's commit are read once too, as many as the failures go through, and its diagnostics wait
  for nothing: the files as saved stand in until they are read. The translation values of `HEAD` are read once per
  `HEAD`, those of the working tree once per refresh, each once for every document that asks meanwhile. An edit costs
  the coverage no request: its marks are placed again on the text from what is kept.
- **A change is pushed against what the client holds**: `piwi/statusChanged`, `piwi/runStatusChanged` and
  `piwi/failuresChanged` are sent when the answer differs from the last one sent or answered to `piwi/status`,
  `piwi/runStatus` or `piwi/failures`, and `piwi/coverageChanged` when a document's marks differ from the last ones
  sent or answered to `piwi/coverage` for it, so a client keeps the pushed answers and never reads one again on a push.
- **What the instance says did not change is not read again**: the locator and code indexes are asked with the `ETag`
  they came with (`If-None-Match`), and a 304 keeps the same object, so what is computed once per index stays. The
  contexts of one service share these answers (`ResponseCache`, created in `startServer`), the same request on its way
  included: a repository with eight Playwright configs reading one project holds and downloads its index once, not eight
  times. The plain reads share the same map for 2 s (`SHARED_MS`, `PiwiClient.get`): the request on its way and its
  answer, by instance, key and path, so the project's latest run, flaky tests, Flake Lab, quarantine, selections,
  timeout opportunities, function catalog and vocabulary are read once per refresh and once per poll for all the configs
  reading one project, each context getting its own copy of the answer (`structuredClone`), as when it parses its own:
  nothing keyed by a failure's identity crosses contexts. A plain answer the instance gives an `ETag` (the project's
  latest run, `branch-failures`) is kept past that time and asked again with it: a 304 gives each context a copy of the
  answer kept, which may be newer than the one it holds (another context read it), and `refreshRun` compares the two
  (`JSON.stringify`), so a poll that finds nothing new downloads nothing, and the instance answers it without computing
  the failures. Each wave of reads the server starts reads afresh (`forgetShared`: a refresh, a poll, `piwi/refreshRun`,
  a move of `HEAD`), its contexts sharing within it, an answer with an `ETag` asked with it. A read that failed is
  shared by the callers that joined it alone; a run as it moves (`runDetails`, `latestRunByRef`, a desktop job) keeps no
  answer, and the read after a run ended takes none (`refreshRun(true)`), an answer with an `ETag` asked with it all the
  same. The map keeps 16 indexes and 64 plain answers at most, those past their time without an `ETag` dropped first
  (`trim`). A file's coverage is asked the same way, kept by the context that reads the file rather than in the shared
  answers, and its marks are computed once per coverage and text.
- **A failure shows once, from the config its spec belongs to**: the configs of a repository that read one project each
  list all its failures, and each would find their files from the repository's root; a context places a failure only
  when its config folder holds the failure's spec, or when no config folder does (`placedElsewhere`). So a failure's
  files at its run's commit are read, and its diagnostics sent, once, not once per config.
- **The failures come first on a refresh** (`PiwiContext.refresh`): the project and its locator index (the ladder
  needs the default branch), then the latest run, whose failures and status are published at once (`onRun`); only then
  the other indexes, side by side, each keeping what it held when its read fails. Their slow reads are one request
  each: the selections resolved together (`selections?resolve=true`), the vocabulary from the catalog's search values
  (`test-cases/facets`); an instance without them is read the old way (each selection's `resolve`, the first thousand
  tests).
- **The connection order is fixed** (`resolveContextConnection`): the desktop app while it runs when the editor
  chose it (`desktop` in `piwi/setCredentials`, kept on the user's machine: the app is theirs, so their choice comes
  first); then the named instance (`namedInstance`): the environment, the workspace `.env`, the editor's own settings
  (what Connect saved: explicit, so it comes before an app that only runs); then the desktop app's discovery file.
  The desktop app sits beside a shared instance, never replaces it: `piwi/status` keeps the named instance
  (`instance`) and says whether the app runs (`desktopUrl`), so Connect offers both. With the app chosen, the project
  is `desktopProject`, else the one the app links to the folder holding the Playwright config (`projects` in
  `~/.piwi/desktop.json`), else `PIWI_PROJECT_NAME`; reached because nothing else names an instance, it is
  `PIWI_PROJECT_NAME`, the editor's, else the linked one. The service watches that file, `piwi/statusChanged` tells
  the client when the app starts or quits, and `piwi/desktop` tells Connect what the app offers. It watches `HEAD` and
  `logs/HEAD` of each repository the contexts are in the same way (`fs.watchFile`, every 2 s; `headFiles` in
  `src/workspace.ts` finds them where git keeps them, for a worktree or a submodule too): a checkout or a commit drops
  what `HEAD` gave the repository's contexts (`PiwiContext.headMoved`: the files as `HEAD` holds them and its
  translation values; the files at a run's commit stay), reads their latest run again, published when it changed, and
  analyzes the open documents again, against the new `HEAD`; the refresh timer and the poll are not moved. A context that
  changes instance forgets everything read from the other one. The reporter keeps its own order. The API key never leaves the process except in `X-API-Key`, and in the MCP server definition `piwi/mcp` hands the
  client for its agent while the credentials' `mcpAuthorization` is `key` (the default); with `sign-in` an instance's
  definition carries no header and the agent signs in through the instance's OAuth (`authorization` says which), while
  the desktop app's keeps its token.
- Nothing from the workspace is sent to the instance but file paths it already stores.

## Workflow

```bash
npm run editor:build        # the five files the clients ship (the stdio and launcher tests use them)
npm run editor:typecheck
npm run editor:lint         # :fix to fix
npm run editor:format       # :check to verify only
npm run editor:test         # an in-process JSON-RPC client against a fixture repository and a stub instance
```

`tests/launcher.test.ts` runs the built launcher (`dist/`) with this repository's Playwright and Chromium, headless,
and plays a person's input through a second client attached over the DevTools protocol: run `npm run editor:build`
first (and `npx playwright install chromium` once). It skips, saying why, when either is missing.

The scope for commits here and in the editor clients is `ide`.
