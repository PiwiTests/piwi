# Editor service architecture

How the editor service in `packages/editor/` works: the protocol and what each request answers, the runs and failures,
run control, coverage, the recorder, the build, and the reads and the connection behind the rules. The rules are in
[`AGENTS.md`](AGENTS.md). This file is reference material: open the section for the area you change.

## Contents

- [Overview](#overview)
  - [Terms](#terms)
  - [Source files](#source-files)
- [Protocol](#protocol)
  - [Clients and versions](#clients-and-versions)
  - [Requests and notifications](#requests-and-notifications)
  - [What the clients render](#what-the-clients-render)
  - [The failures answer](#the-failures-answer)
  - [Instance status](#instance-status)
- [Runs and failures](#runs-and-failures)
  - [Latest run and baseline](#latest-run-and-baseline)
  - [Failure diagnostics and runs laid over](#failure-diagnostics-and-runs-laid-over)
  - [Failures that follow the edits](#failures-that-follow-the-edits)
  - [File summary and the test at a position](#file-summary-and-the-test-at-a-position)
  - [Test items](#test-items)
  - [Failure lines and Flake Lab lines](#failure-lines-and-flake-lab-lines)
  - [Run streams and polling](#run-streams-and-polling)
  - [Runs in progress and the run verdict](#runs-in-progress-and-the-run-verdict)
  - [The editor's own run](#the-editors-own-run)
- [Breakpoints and picked locators](#breakpoints-and-picked-locators)
  - [Breakpoints](#breakpoints)
  - [Picked locators](#picked-locators)
- [Run control](#run-control)
  - [Run sessions](#run-sessions)
  - [Controls, breakpoints and the paused page](#controls-breakpoints-and-the-paused-page)
  - [Stops no pause bar shows](#stops-no-pause-bar-shows)
  - [The hub](#the-hub)
  - [The live view](#the-live-view)
  - [Code from a stop](#code-from-a-stop)
  - [A run that debugs a failure](#a-run-that-debugs-a-failure)
  - [Agents](#agents)
  - [Another host](#another-host)
  - [The discovery file](#the-discovery-file)
- [Coverage](#coverage)
  - [Coverage marks](#coverage-marks)
  - [Uncovered changes](#uncovered-changes)
- [Analysis and completion](#analysis-and-completion)
  - [Diagnostics and quick fixes](#diagnostics-and-quick-fixes)
  - [Completion](#completion)
- [Contexts and the instance client](#contexts-and-the-instance-client)
  - [Contexts](#contexts)
  - [Instance client and proxy](#instance-client-and-proxy)
- [Desktop jobs](#desktop-jobs)
- [Recorder](#recorder)
  - [Project options, Node and the launcher](#project-options-node-and-the-launcher)
  - [Recording updates](#recording-updates)
  - [Page candidates and placement](#page-candidates-and-placement)
  - [Imports](#imports)
  - [Recording from a paused test](#recording-from-a-paused-test)
- [Build output](#build-output)
- [Commands](#commands)
  - [How a command is built](#how-a-command-is-built)
  - [The folder a command runs in](#the-folder-a-command-runs-in)
- [Reads and caching](#reads-and-caching)
  - [Background reads](#background-reads)
  - [Evidence files](#evidence-files)
  - [Pushed changes](#pushed-changes)
  - [Response cache](#response-cache)
  - [Failures placed by one context](#failures-placed-by-one-context)
  - [Refresh order](#refresh-order)
- [Connection](#connection)
  - [Connection order and watching `HEAD`](#connection-order-and-watching-head)
  - [API key and MCP server](#api-key-and-mcp-server)
- [Tests](#tests)

## Overview

The editor service is one language server. `npm run editor:build` bundles it into `dist/piwi-language-server.cjs`, and
every editor client ships that bundle and starts it over stdio: the VS Code extension and the JetBrains plugin. All
editor logic lives here, so the clients stay thin and both editors give the same answers.

The service speaks the Language Server Protocol (LSP) for diagnostics, quick fixes, hover and completion. It adds its
own requests and notifications (`piwi/…`) for what each editor draws natively.

### Terms

- **Instance**: a Piwi server the service reads, either a team's shared one or the one the desktop app runs on this
  machine.
- **Context**: one Playwright config of the workspace (`PiwiContext` in `src/context.ts`), named by its folder (`root`).
  Each context has its own connection, project, branch and cached indexes. Several configs of one repository may read
  one project.
- **Indexes**: what the instance computed for the project. The locator index says which locators the tests call, where,
  and on which pages; the code index says which source files the tests reach; the catalog lists the project's test
  cases. Beside them come lists: flaky tests, Flake Lab, quarantine, selections, timeout opportunities, the function
  catalog and the vocabulary (tags and features).
- **Baseline**: the complete run the workspace is compared with (`run` in `piwi/failures`). The client chooses how it
  is found; the default choice, the **ladder**, takes the latest complete run of the checked-out branch, else of the
  default branch, else of any branch. The `baseline` field of the answers holds the choice and a label of what it found.
- **Runs laid over** the baseline (overlays): the runs of its branch that finished after it, whole or partial.
- **Latest run**: what the service reads for a context: the baseline, the runs laid over it, and the failures as they
  stand after them (`PiwiContext.failures`, read by `refreshRun`).
- **Live run**: a run in progress that a context follows (`live` in `piwi/runStatus`).
- **The editor's own run**: a run started by a command the service built, recognized by the ref that command carries.
- **Run channel**: the record channel's socket as a test run names it (`PIWI_RUN_CHANNEL`). Each worker of the run
  keeps a connection to it.
- **Run session**: a run the service built, as its workers tell it over the run channel, by the ref of its command.
- **Stop**: a worker stopped before a call (at a breakpoint, after Step or Pause, at a line it was run to, at
  `page.pause()`), named by the time it stopped (`RunStop.since`).
- **Pause bar**: Piwi's bar in the page of a stopped test. A headed run shows it, a headless run does not
  (`RunStop.bar`).
- **Hub**: the WebSocket through which Piwi Picker follows and steers the runs the service built.
- **Agent**: a coding agent of this machine (Claude Code, Copilot, Cursor) that follows and steers the same runs
  through the service's MCP server ([Agents](#agents)).
- **Code from a stop**: the code an action at a stop writes above the stopped line (Assert, Assert a region, Mock a
  request), which the client writes.
- **Push**: a notification the service sends unasked, carrying a whole answer: `piwi/failuresChanged` carries what
  `piwi/failures` answers.

### Source files

- `src/main.ts`: the bundle's entry point; it serves over stdio, or over the transport the client names (`--stdio`,
  `--node-ipc`, `--socket=<port>`), and writes the discovery file once the service listens and removes it as it stops.
- `src/server.ts`: the language server: the LSP features, the custom requests, the timers and the pushes.
- `src/protocol.ts`: the custom requests, the notifications and their types; both clients mirror it.
- `src/context.ts`: one Playwright config of the workspace (`PiwiContext`): its connection, project, branch and cached
  indexes.
- `src/workspace.ts`: the configs the workspace holds and the git reads (`committedTextAt`, `mergeBase`, `headFiles`).
- `src/analysis.ts`: the pure half: locators per line, stability findings, failure placement, breakpoints, completion.
- `src/commands.ts`: every command line a client runs.
- `src/failure-tree.ts`: the failures tree both clients draw (`failuresAnswer`).
- `src/coverage.ts`: coverage marks and uncovered changes.
- `src/piwi-client.ts`, `src/http.ts`: the requests to an instance, the shared response cache and the proxy.
- `src/run-stream.ts`, `src/run-watch.ts`: the instance's event streams, the poll, runs in progress and run verdicts.
- `src/desktop-jobs.ts`: the jobs passed to the desktop app.
- `src/run-sessions.ts`: the run sessions, and the controls the client and the hub send their workers.
- `src/run-hub.ts`: the hub's WebSocket, for Piwi Picker.
- `src/stop-actions.ts`, `src/stop-code.ts`, `src/run-lines.ts`: the code from a stop, rendered, and placed where the
  stopped statement stands now.
- `src/discovery.ts`: the discovery file, `~/.piwi/editors/<pid>.json`, written and read.
- `src/debug-run.ts`: a run that debugs a failure (**Debug in my editor**): its test, its one-shot stop and the
  suggested locator outlined there.
- `src/agent-server.ts`, `src/run-agent.ts`: the MCP server for the agents of this machine, and its tools.
- `src/mcp-protocol.ts`: MCP's JSON-RPC pieces, shared with the instance's MCP server.
- `src/run-host.ts`: the run control another host builds on, the desktop app's server.
- `src/recorder/`: recording from the editor: the project's options, the launcher, the sessions, page candidates,
  imports and the record channel, whose socket also takes the workers' run connections.
- `build.mjs`: writes the five files of `dist/`.
- `tests/`: the Vitest suites; `tests/lsp.test.ts` drives the server as a client does, against a stub instance.

## Protocol

### Clients and versions

The protocol of `src/protocol.ts` has two clients, and each bundles its own copy of the service:

- The VS Code extension: `apps/vscode/build.mjs` copies the five files of `dist/` into the extension's `dist/`. The
  extension imports the protocol's types from `@piwitests/editor/protocol`.
- The JetBrains plugin: `apps/jetbrains/build.gradle.kts` packs the same files into the plugin's `server/`.
  `Protocol.kt` mirrors the protocol for lsp4j.

`@piwitests/editor` is private (`"private": true`): it is never published, and nothing else starts the service. A client
therefore always talks to the service of its own commit. The protocol changes in one step, with both clients, and keeps
no compatibility path. The command ids of `PiwiCommand.command` are the exception: users' keybindings and settings name
them, so renaming one is a breaking change for users (`proposals/1.0-stabilization.md` freezes them at 1.0).

What does cross versions is what the service talks to, since each is installed on its own:

- **The instance.** A route or a field an older instance lacks has a fallback. The fields of the runs laid over are
  optional; an instance without `selections?resolve=true` or `test-cases/facets` is read the old way; one that ignores
  `run` or `origin` in `branch-failures` is detected; a 404 on the event stream or on the coverage route turns that
  feature off for a while.
- **The project's `@piwitests/reporter`.** It reads the environment the service puts on a test run: `PIWI_ORIGIN`,
  `PIWI_ORIGIN_REF`, `PIWI_PAUSE_AT`, `PIWI_RUN_CHANNEL`, `PIWI_RECORD_CHANNEL`, `PIWI_COVERAGE_SERVER`,
  `PIWI_COVERAGE_BROWSER`. Breakpoints need a reporter from `PAUSE_REPORTER_VERSION` on, and the service warns about an
  older one. On the run channel (`@piwitests/core/run-channel`), a worker's `run-attach` lists the intents and queries
  its reporter takes (`takes`), and the service refuses any other; a control the reporter does not take comes back as a
  `notice`. It also lists the stops it holds for an editor that shows them (`holds: ['failure']`), which the service
  answers first with `attached` naming those it shows, sent only to a worker that listed them, since an older reporter
  answers a message it does not know with a `notice`.
- **Piwi Picker.** The browser extension reads the hub's messages with `parseHubMessage` of `@piwitests/core/run-hub`,
  field by field, and leaves aside a message it cannot read, so the hub sends only what fits those limits
  ([The hub](#the-hub)).
- **The desktop app.** The service reads its discovery file and passes it jobs (`@piwitests/core/desktop-job`). An app
  too old to take jobs answers 404 (or 400 to a Flake Lab job), which the service reports.

### Requests and notifications

`src/server.ts` wires the protocol. Beside the LSP features (diagnostics, quick fixes, hover and completion), it handles
the custom messages of `src/protocol.ts`:

- **Requests**, from the client:
  - files and tests: `piwi/fileSummary`, `piwi/testsForFile`, `piwi/testAt`, `piwi/testItems`, `piwi/coverage`;
  - runs: `piwi/runArgs`, `piwi/runSelection`, `piwi/selections`, `piwi/runStatus`, `piwi/refreshRun`, `piwi/runId`;
  - run control: `piwi/runControl`, `piwi/pausedPage`, `piwi/pickAt`, `piwi/stopAction`, `piwi/stopRequests`,
    `piwi/locatorAtCaret`, `piwi/hub`, `piwi/stopBind`, `piwi/agents`;
  - failures: `piwi/failures`, `piwi/agentContext`, `piwi/trace`, `piwi/screenshot`, `piwi/applyPick`;
  - connection: `piwi/status`, `piwi/refresh`, `piwi/desktop`, `piwi/mcp`;
  - desktop jobs: `piwi/desktopJob`, `piwi/shareDesktopJob`;
  - recorder: `piwi/record`, `piwi/stopRecording`, `piwi/recordingCommand`, `piwi/pageCandidates`, `piwi/renderSteps`.
- **Notifications from the client**: `piwi/setCredentials`, `piwi/setBaseline`, `piwi/commandStarted`,
  `piwi/commandEnded`, `piwi/declineRecord`, `piwi/setRunBreakpoints`.
- **Notifications from the service**: `piwi/statusChanged`, `piwi/runStatusChanged`, `piwi/failuresChanged`,
  `piwi/coverageChanged`, `piwi/runEnded`, `piwi/notice`, `piwi/desktopJobChanged`, `piwi/recordingChanged`,
  `piwi/recordRequested`, `piwi/runSessionChanged`, `piwi/stopCode`.

The initialization options (`InitializationOptions`) carry the credentials, `runControl` when the client shows and
answers the stops of the runs it starts ([Stops no pause bar shows](#stops-no-pause-bar-shows)), and `stopCode` when it
writes the code from a stop ([Code from a stop](#code-from-a-stop)), as both clients do, and `agents` for the agents'
MCP server ([Agents](#agents)).

A summary line or a quick fix names a client command to run. The summary lines use those of `PiwiCommand.command`
(`piwi.openInDashboard`, `piwi.runTests`, `piwi.openTrace`, `piwi.openScreenshot`, `piwi.runCommand`, `piwi.copyText`,
`piwi.desktopJob`), and a quick fix also uses `piwi.copyAgentContext`. Both clients implement each one.

### What the clients render

- `piwi/fileSummary`: natively, as CodeLens in VS Code and Code Vision in the JetBrains IDEs.
- `piwi/runStatus`: in the status bar.
- `piwi/failures`: as a tree, in both editors. The JetBrains IDEs' LSP client highlights open files only, so in those
  IDEs the tree is the only place the failures of the other files show.

`piwi/runId` reads a run id typed for **A run by id…** (`118`, `#118`): 1 to 2147483647, the range of an instance's run
ids. `piwi/agentContext` answers the block that **Copy context for agent** copies: for a failure the view names, or that
the quick fix (`piwi.copyAgentContext`) names once picked.

### The failures answer

Each item of `piwi/failures` carries:

- its spec relative to the config, its test, its cluster, its owner, its Playwright project, its duration and whether
  it is new;
- the folder of its Playwright config (`root`), which a run of its test takes (`RunTestsArgs.root`), whatever file the
  failure shows in.

When one context alone has something to show (a run, runs laid over none, or failures), the answer also carries that
context's:

- baseline run (`run`) and the runs laid over it (`overlays`);
- baseline choice and its label (`baseline`);
- time of the read (`updatedAt`). A change of `updatedAt` alone sends no `piwi/failuresChanged`.

The answer always holds:

- `tree`: the tree both clients draw (`failuresAnswer` in `src/failure-tree.ts`): the run, the runs laid over it, and
  the failures grouped as the last `piwi/failures` asked (`grouping`). The service keeps that grouping for what it
  pushes.
- `runLabel`: the run as the tree's root names it.
- `failing`: how many tests still fail.
- `rerun`: what **Re-run the failing tests** runs.

A client adds a run's age and its own run in progress.

When several contexts have something to show, the tree holds one `context` node per context, in the contexts' order.
That node shows the context's folder (as `contextLabel` in `src/workspace.ts` names it, also `label` in `piwi/status`),
its project and counts, its `root`, and its run's `url`. Under it is that context's tree, or its run alone when it has
no failure. The key of a node under it is the context node's key and its own, on two lines. In that case:

- `run`, `overlays` and `baseline` are left out, `runLabel` is null, and `updatedAt` is the latest of the reads;
- the `run` node names its context too (`root`), so a client runs a context's failing tests (`rerun` with that `root`),
  chooses its baseline, and shows the editor's own run in progress on the right run.

### Instance status

`piwi/status` says what keeps a context from the instance's data (`problemKind`):

- `not-configured`: no instance is named;
- `no-project`: no project is chosen or found;
- `refused`: a key is missing or refused;
- `unreachable`: the instance did not answer, or answered with an error.

A client thus tells an instance that did not answer apart from a missing connection. While an instance does not answer,
the contexts are read again 15 s later, then after twice as long each time, up to the refresh's pace
(`retryUnreachable`, `UNREACHABLE_RETRY_MS`).

## Runs and failures

### Latest run and baseline

The service reads a context's latest run again:

- whenever a run ends;
- whenever `HEAD` moves, by a checkout or a commit
  ([Connection order and watching `HEAD`](#connection-order-and-watching-head));
- on the poll ([Run streams and polling](#run-streams-and-polling)).

The default baseline is the ladder: the latest complete run of the checked-out branch (the default branch on a detached
`HEAD`); while that branch has none, the default branch's; else the newest run of any branch. `piwi/runStatus` names the
branch read (`branch`, `PiwiContext.runBranch`) and the branch checked out (`checkedOut`).

A client may choose another baseline per context (`piwi/setBaseline { root, choice }`, `PiwiContext.baseline`):

- a branch's latest complete run;
- a run by its id (`branch-failures?run=`; a 400 or a 404 means no run);
- a developer's own runs only (`branch-failures?origin=local` on the checked-out branch): the newest complete local run,
  else the local runs alone, with `run: null`.

A choice is read once: a branch or a run with no data reads nothing else.

The client keeps the choices on its machine. It sends them in `EditorCredentials.baselines`, in the initialization
options and in every `piwi/setCredentials`, so a restarted service has them. Credentials without `baselines` leave the
choices as they are. Credentials with `baselines` replace them all, and a context they do not name goes back to the
ladder.

`piwi/runStatus` carries:

- `baseline`: the choice and its label (`baselineLabel` in `src/context.ts`): `CI run #120 on feature/x`,
  `your local runs only`, `release (no run)`;
- `branches`: the branches a baseline can be chosen from, the default branch first, then those of the locator index.

`piwi/failures` carries the `baseline` of the context it shows.

### Failure diagnostics and runs laid over

The failures of the latest run are published as `ci-failure` diagnostics in every file they point to, merged with the
analysis of the open documents. Their severity is the one `EditorCredentials.failureSeverity` chooses (`error` when
absent; `failureSeverity` in `src/server.ts`), except that:

- a failure of a run on another branch than the checked-out one is a warning at most;
- a failure whose line was edited since its run is an information.

`off` publishes no diagnostic, while `piwi/failures`, `piwi/fileSummary` and the hover still give the failures.

The instance lays over the baseline the runs of its branch finished since, whole or partial
(`branch-failures?overlays=1`): a test re-run from the editor, `piwi run`, the desktop app. It does so per test and
Playwright project, and the newest result wins:

- A failure may come from a later run (`source: 'overlay'`). Its label is `local run #N` when that run did not run in CI
  (as for a failure of a baseline that did not), and `your run #N` when the editor started it.
- A failure a later run passed moves to `resolved`, which publishes no diagnostic. Its test's line says
  `fixed locally in run #N` with `status: 'passed'`, `piwi/failures` lists it as `fixed-locally`, and `piwi/runStatus`
  counts it in `resolved`, beside `failingTests` and `overlays`, which the status bars show.

### Failures that follow the edits

A failure follows the edits made since its run (`placeLine` in `src/analysis.ts`, through the hunks of `diffLines`). Its
lines, as the run reported them, are placed on the files as they stand, saved or not. That covers:

- its diagnostic and `TestFailure.line`;
- the reason, **Screenshot** and **Trace** lines above it;
- the hover's call chain;
- its `piwi/failures` item.

The diff starts from the files as the run saw them:

- For a run that ran in CI: the files of its commit (`committedTextAt` in `src/workspace.ts`,
  `git show <commit>:<path>`). Each is read once per commit and path, and kept while the latest run stays the same
  (`PiwiContext.textAtCommit`).
- Otherwise: the files as saved when the service first placed the failure (`PiwiContext.failureAnchors`, by execution).
  This covers a run on a developer's machine (which ran their files as saved), a run without a commit, a commit the
  repository lacks, and a CI run until its commit's file is read.

A failure whose line changed since its run:

- is an information, `Edited since run #120: …`, with `data.edited`;
- has **Run this test** (`piwi.runTests`) first among its quick fixes (every failure has it);
- has `state: 'edited'` in `TestFailure` and in `piwi/failures`;
- shows `✎ edited since run #120 · …` above the line.

A failure whose test left its spec publishes nothing: its `test(…)` call was in the spec the run saw, and is not in the
spec as it stands.

The failures are placed again on the timer that analyzes an edited document, and when a commit's file arrives.
`piwi/failuresChanged` carries the `piwi/failures` answer whenever a line or a state changed.

### File summary and the test at a position

On a spec, `piwi/fileSummary` gives each test's line:

- its latest result (`status`), which the clients draw in the gutter;
- the test's id (`testCaseId`), which VS Code's gutter hover runs;
- the line its call ends on (`endLine`, found with `callEndLine`), for the background the clients draw over a failing
  test.

`piwi/testAt` answers, for a position of a spec:

- where the `test(…)` call spanning the position's line starts (`testCallAt`, over `testCalls`), as Playwright's
  location filter takes it: `location`, such as `tests/checkout.spec.ts:42`, relative to the config's folder, in the
  text as it stands;
- the catalog's test of that call (`caseOfCallOrTitle`): the case of its title in the same `test.describe(…)` blocks
  (`caseOfCall`), else, when a block around it is titled by a template literal holding `${` or by a variable or an
  expression (`suiteUnread`), the only case of its title in the spec; with two or more of that title, none. A test
  whose blocks all read literally and that has no case of its own (a new test) gets none. The `timeout` diagnostics
  match their test the same way;
- the spec's tests (`casesOf`).

**Run the test at the cursor**, **Verify the test at the cursor ×3** and **Run this spec** run them. A file that is not
a spec under a context's folder answers nulls, and a test Piwi does not know answers a location alone.

### Test items

`piwi/testItems` answers the tests of the workspace's specs, for a client's own test tree (VS Code's Testing view). It
lists:

- unless `catalog` is false, the catalog's specs the workspace holds (`PiwiContext.allCases`: the whole catalog, a
  thousand cases a request and ten requests at most, read once per refresh). Each stored path is found as a run's path
  is (`resolveReportedFile`), under the context whose folder holds it.
- the specs `uris` names (`casesOf`), known to the catalog or not.

Each test is given as the spec stands (`testCalls` in `src/analysis.ts`: each `test(…)` call, one a line, a line
starting with `//` read as blank, with the titled `test.describe(…)` blocks around it, a test on the line opening its
block included). It comes
with the catalog's case of its title in those blocks (`caseOfCall`), its location, its latest result and its failure,
as `piwi/fileSummary` gives them: both read them from `specTests` in `src/server.ts`.

### Failure lines and Flake Lab lines

A failing test's line also carries `failure`: the line of the test that its error's stack goes through. The instance
sends the stack's frames and the message in `branch-failures`. Above that line, the reason, **Run this test**
(`piwi.runTests` with the test's id), **Screenshot** and **Trace** are ordinary summary lines. The hover on any line of
that stack shows the message and the call chain.

A flaky test's line also carries the Flake Lab lines (`flakeLabLines`, from `GET /api/projects/:id/flake-lab`):

- its flaky rate and top suspect;
- the `piwi flake` commands, run through `piwi.runCommand`. A command carries `--server-url` only when, run from the
  config's folder, it would find another instance or none (`withServerUrl`);
- while the desktop app runs beside a team instance, the reproduction as a desktop job (`piwi.desktopJob`, kind
  `flake-lab`).

### Run streams and polling

Runs are pushed, and the poll is the fallback (`src/run-stream.ts`, `src/run-watch.ts`).

One server-sent events stream per instance and key (`GET /api/stream`, `InstanceStream`) says when a run of a context's
project starts or ends. The contexts that read the instance with that key share it. When it drops, it is opened again:

- after 1 s, then twice as long each time, up to a minute;
- every five minutes after a 404 (an instance without the route);
- after a 401 or a 403, only on the next refresh: the periodic one, or the one new credentials bring.

A connection that brings nothing for 45 s is opened again: the instance sends a heartbeat every 15 s.

Half a second after a run ends, the context reads its latest run again; runs that end together are read once. The poll
reads it besides:

- every five minutes while the instance's stream is connected;
- otherwise every minute, or every 15 seconds while the latest run read is still in progress;
- every 15 seconds while a run is `live`, connected or not (that run's own stream may have closed for good).

`stream` and `updatedAt` in `piwi/runStatus` show the state. The next poll counts from the latest read of the run,
whatever made it (`dueAt` in `src/server.ts`). A read that finds the same runs and failures places no failure again: it
moves `updatedAt` alone.

### Runs in progress and the run verdict

A run in progress is `live` in `piwi/runStatus` when it runs on the branch the context reads or on the checked-out
branch, or when it is the editor's own, wherever it runs. It is counted through its own stream
(`GET /api/test-runs/:id/stream`). The client hears of it at most once every 300 ms, and that notification places no
failure again (`progressed` in `RunWatchOptions`). `live` goes back to null in the notification that brings the
failures read once the run ended.

Until then, the tests its stream begins (`test-begin`) and ends (`test-completed`) are kept in
`PiwiContext.liveTests`. An event names its test by its id, else by its title and suite path in its spec, looked up in
the catalog; a title the catalog cannot tell apart names no test (`catalogCaseOf`). A test shows `running`, then its
result:

- a pass after a failed attempt is flaky;
- a test on several Playwright projects shows the first of running, failed, flaky, passed, skipped.

`piwi/fileSummary` gives that result as the test line's `status`, and `piwi/runStatus` gives it in `liveTests`, so the
clients draw the files again.

Once a run of the editor's own ended and its context read the latest run, `piwi/runEnded` says once what the run
changed (`runVerdict` in `src/run-watch.ts`, from the failures read before and after). It carries the ref of the command
that started the run while the service keeps that command (`RefWatch.carried`), the run's counts, and:

- `fixed`: the tests failing before that it passed;
- `stillFailing`: the tests it failed again (failing before in another run, or not new on the instance's word);
- `newFailures`: the tests it failed that were not failing before.

`piwi/refreshRun` reads the runs alone, not the indexes `piwi/refresh` reads.

### The editor's own run

`piwi/runArgs` and `piwi/runSelection` give each command a ref: `ed-` and 8 hexadecimal characters. The ref goes in the
command's environment, as `PIWI_ORIGIN_REF` beside `PIWI_ORIGIN=editor`, and in `RunCommand.ref`. The Flake Lab lines
and the fix plan's verification carry `PIWI_ORIGIN=editor` alone.

`piwi/runArgs` runs tests either way:

- by id, with the instance's arguments;
- by location (`RunTestsArgs.locations`): a spec under the context's folder and the line of its `test(…)` call
  (`isTestLocation`, `specLocation`). This needs no instance, so it runs a test just recorded.
- to debug a failure (`RunTestsArgs.debug`): the test of a spec its title names, headed with one worker, stopping once
  at the failing line ([A run that debugs a failure](#a-run-that-debugs-a-failure)).

With `repeat`, it runs each test that many times without retries (`repeatArgs`: `--repeat-each=3 --retries=0`, for
**Verify ×3**), headless: neither the breakpoints nor the record and run channels are passed. A repeated command's
run counts the `test-completed` results of its stream, once per execution (`RunWatch.tally`), beside the run's own
counts, which hold one result per attempt, project and repetition (an older instance kept one per attempt and
project). Its `piwi/runEnded` carries `repeat` (`repeatVerdict`): `Passed 3 of 3`, `Failed 1 of 3`, or
`Failed at least 1 of 3` when the stream missed some results. When its run reached no instance, its
`piwi/commandEnded` brings a `piwi/notice` from the exit code (`exitVerdict`).

The service looks for the run carrying the ref in two ways:

- it asks the instance (`latest-run?origin=editor&ref=`) for two minutes: every 2 s while the instance's stream is down,
  every 20 s while it is connected (its `run-started` names the run), and once when the stream connects;
- it reads each `run-started` the stream announces, and takes the run whose metadata names the ref.

It keeps the run found in `PiwiContext.ownRuns` for its lifetime: its failures read `your run #N` and are
`source: 'own'` in `piwi/failures`.

A client says when the command ended (`piwi/commandEnded`, with its exit code). The service then reads the run once
more, and when no run carries the ref 5 s later, it sends `piwi/notice`. The instance is not asked for the ref again.
A later run carrying the ref, a rerun of the command (the Run tool window's Rerun, VS Code's **Tasks: Rerun Last
Task**), is the editor's own once the instance's stream announces it, whatever was found before. The service keeps the
refs of the 50 latest commands.

A command sent to a terminal whose environment holds another ref (`piwi/commandStarted` with `terminalRef`) is not
looked for by its own ref: its run carries the terminal's ref.

## Breakpoints and picked locators

### Breakpoints

`piwi/runArgs` and `piwi/runSelection` take the editor's enabled line breakpoints (`breakpoints`, 0-based lines). For
those in files under the context's folder:

- they go in the command's environment as `PIWI_PAUSE_AT`: `tests/login.spec.ts:42;tests/pages/checkout.page.ts:9`,
  relative to that folder, 1-based, separated by semicolons (`pauseAtValue` in `src/analysis.ts`);
- `--headed` is appended to the arguments and to the command, unless it carries `--headed`, `--ui` or `--debug`
  (`headedCommand`).

The client adds its Send to editor address as `PIWI_EDITOR_SEND` to a command that carries `PIWI_PAUSE_AT` or
`PIWI_RUN_CHANNEL`, or whose `RunCommand.pauses` is set. The reporter's capture fixtures pause the run, with Piwi's
pause bar, before a call that Playwright's debugger stops at on those lines (a navigation, an action, a read, an
assertion). A locator picked there is posted to that address with its file and line. Breakpoints changed while the run
goes on reach its workers through `piwi/setRunBreakpoints`
([Controls, breakpoints and the paused page](#controls-breakpoints-and-the-paused-page)).

Each refresh reads the version of `@piwitests/reporter` the context's folder installs (`reporterVersion` in
`src/workspace.ts`): in its `node_modules`, else in that of a folder above it, up to the repository root.
`piwi/runStatus` carries it as `reporterVersion`. With breakpoints and a reporter older than `PAUSE_REPORTER_VERSION`
(0.48.0), `RunCommand.notice` says so; the client shows it once as a warning, and the run starts anyway. A missing
reporter says nothing.

### Picked locators

`piwi/applyPick` answers the edit that puts a picked locator in place of the locator chain its line holds now
(`pickEditOnLine`: the chain `replaceLocatorOnLine` replaces). The file is the one at `uri`, else the one at `file`, a
path relative to a Playwright config's folder (never absolute, never through `..`), open or saved. The edit is null when
the line holds no locator chain, and the client then inserts the locator at the cursor.

## Run control

The runs the service builds are followed and steered from the editor and from Piwi Picker, with no debug session. Each
worker of a run tells the service over the run channel what it runs and where it stopped. The service tells the client
(`piwi/runSessionChanged`) and Piwi Picker (the hub), and passes their controls on to the worker.

### Run sessions

`src/run-sessions.ts` (`RunSessions`) keeps one session per run, by the ref of its command (`PIWI_ORIGIN_REF`).

Each worker of a run keeps a connection to the record channel's socket for its whole life (`run-attach`,
`@piwitests/core/run-channel`), opened with the channel's token, compared in constant time (`sameToken`). The session
files it by Playwright's worker index, with:

- the test it runs;
- its state: `running` a test, `stopped` before one of its calls, or `between` tests;
- where it stands stopped (`RunStop`);
- whether a Pause reached it and it has not stopped yet (`pausing`).

A connection naming the index of a worker connected now is closed: another process the run's environment reached (a
test running Playwright itself) takes no worker's place.

`piwi/runSessionChanged` carries the whole session, and only when it differs from the last one sent:

- at once when a worker stops, goes on or leaves, or a Pause reaches it, in a burst at most every 50 ms
  (`SESSION_BURST_MS`);
- at most every 300 ms (`SESSION_PACE_MS`) when a worker connects, or starts or ends a test.

The run ends with its command (`piwi/commandEnded`, which closes the connections of its workers still closing), or 5 s
after its last worker left with none connecting (`SESSION_LINGER_MS`). Its last notification carries `ended`, and a
later worker of the same ref (a rerun) starts a new session.

Each stop is named by the time it happened (`RunStop.since`, ISO 8601). `stamp` makes each stop's `since` later than
the run's stop before it, so it names that stop alone.

### Controls, breakpoints and the paused page

`piwi/runControl` answers every control with what was asked, or why nothing was (`The test is running.`,
`2 workers are stopped: choose one.`, a test's `cannotPause`):

- `pause` goes to the workers that run a test or are between tests. Each stops at its next call, or at the next test's
  first.
- `step`, `resume`, `finish` and `run-to` go to the one stopped worker, naming its stop, which a worker past it
  ignores. With `since` (the stop the client showed), they go only to the worker stopped there, else the answer is
  `The test went on.`

A worker's stop ends with its `running`, whoever ended it: the pause bar, the editor, or the test ending under it or
closing its page, which the worker sends unanswered. A control naming that stop afterwards is refused the same way.

`piwi/setRunBreakpoints` replaces the run's breakpoints in each of its workers, and in each one that connects later.
The service keeps the breakpoints of the 50 latest runs.

`piwi/pausedPage` asks a stopped worker for a JPEG of its page. The answer is null after 10 s (`PAUSED_PAGE_WAIT_MS`),
when the worker leaves, or when it is not stopped. From a reporter that names it, the image carries the page's viewport
in CSS pixels (`width`, `height`).

`piwi/pickAt { ref, worker?, since, x, y }` (`RunSessions.pickAt`, the hub's `pick-at` too) has the stopped worker pick
the element under a point of its page, in those CSS pixels (a point of the image is `x * width / naturalWidth`,
whatever the device scale factor), and send its locator where a pick goes. It answers `{ ok, message, locator }`, and
is refused without `since`, for a point outside 0 to 10,000 and for a reporter that does not take `pick-at`.

**Places.** A place a client sends (`run-to`, the breakpoints) is a line of the run's code: the client maps a line of a
document edited since the run started back to it. A worker names a place relative to the run's working directory
(`run-attach`'s `cwd`, the config's folder as the file system spells it). The session:

- gives the client the file's URI under the folder as the workspace spells it;
- takes the client's lines (URIs, 0-based) relative to either spelling;
- refuses a file outside the run's folder (`run-to`) or leaves it out (the breakpoints), as `PIWI_PAUSE_AT` leaves it
  out.

### Stops no pause bar shows

A stop in a headless run shows no pause bar (`RunStop.bar` is false), so only a surface outside the test's page can
answer it:

- a client that says so in its initialization options (`InitializationOptions.runControl`, as both clients do);
- a hub connection that subscribed ([The hub](#the-hub)).

`answersStops` in `src/server.ts` tells whether one of them is there. Without one, such a stop is resumed as soon as it
is heard, with a `piwi/notice` once per run. While a subscribed hub connection hears the runs, the stop waits even
when the client lacks `runControl`; when the last one goes, the stop goes on (`RunSessions.surfacesChanged`).

**A held failure.** A worker's stop with the reason `failure` (a test failed while its run connection was open, its page
held once the test ended) names the failing error's first lines (`RunStop.error`, in `piwi/runSessionChanged` and the
hub's `session`), which a reporter that predates it leaves out. Every run the service builds has a run channel and both
clients answer stops, so a plain Run would hold every failure. One no pause bar shows therefore waits only:

- in a run started to be watched (`watched`: the service built it with the editor's breakpoints or for a
  `page.pause()`, both headed);
- while a Runs window follows the runs (`followed` in `src/server.ts`, `RunHub.follows`): a subscribed hub connection
  said `follow` with `on: true`, and has not said `on: false` or closed. Piwi Picker's background, subscribed with no
  Runs window open, and an extension that predates `follow` never count.

Otherwise it goes on at once, with no notice (no client hears of it), and when the last follower stops following
(`RunSessions.surfacesChanged`). A worker holds a failure only for a service that says it shows one: its `run-attach`
lists `holds`, answered with `attached` (`SHOWN_HOLDS`); a service that predates it says nothing, and the worker holds
none.

A worker's `notice` (a control its reporter does not take) is a `piwi/notice` too.

The service stopping closes every worker's connection: a stop no pause bar shows then goes on, and a stop the bar
shows waits there for its answer.

### The hub

Piwi Picker follows and steers the same runs through the hub's WebSocket (`src/run-hub.ts`, `RunHub`, framed by
`@piwitests/core/run-hub`). The service opens it beside the record channel once initialized, on `127.0.0.1` alone, on a
free port: `ws://127.0.0.1:<port>/piwi/hub` (`HUB_PATH`).

**The handshake.**

- Any other path is a 404, and a plain HTTP request a 426.
- A handshake whose `Host` is not `127.0.0.1` or `localhost` at its port, or at one the client forwards to it from the
  browser's machine (`piwi/hub` with `forwarded`, a remote window's; 8 at most, `forwardedPorts`), is refused with a
  403 before any WebSocket opens (`isHubHost`: a page reached under another name, DNS rebinding). So is one whose
  `Origin` is not a browser extension's (`isExtensionOrigin`: `chrome-extension://` and 32 letters `a` to `p`,
  `moz-extension://` and a UUID; never `http(s)`, `null`, `file` or none). `piwi/hub` answers the hub's address and
  the forwarded ports it takes, once it takes them, so a client lists a forwarded address only after.
- Past 16 open connections, or 8 open that did not say hello, a handshake gets a 503.
- A handshake's headers must arrive within 5 s and fit in 8 KiB.

**Hello.** The first message must be `{ type: 'hello', token }` with the hub's token within 5 s (`HUB_HELLO_MS`), else
the connection closes (4001, 4002). The token is random per start, compared in constant time (`sameToken` in
`recorder/handoff.ts`). The hub answers `welcome`: its pid, version, client, the workspace's first 64 folders and
`keepaliveMs`.

**Who holds the token.** The token is in the discovery file ([The discovery file](#the-discovery-file)), which only
this user reads. The editor's Send to editor endpoint lists it to whoever holds the pairing's token, which the runs the
editor starts hold too (`PIWI_EDITOR_SEND`). The hub keeps other users and web pages out; this user's own processes are
not a boundary.

**Commands.** Every later message is a command with an `id`, checked field by field (`parseHubCommand`):

- `subscribe`;
- `follow` (`on`): a person follows the runs there, a Runs window open
  ([Stops no pause bar shows](#stops-no-pause-bar-shows));
- `runControl`: `pause`, and `step`, `resume` and `finish` with the `since` they need, as `piwi/runControl` takes them
  (Run to a line stays in the editor);
- `pausedPage`;
- the intents `pick`, `record`, `assert` and `assert-region` (`RunSessions.intent`), with `since` too;
- `requests` and `mock` (`request`, a kept response's id), with `since` too;
- `view` (`on`), `input` (`events`) and `pick-at` (`x`, `y`), with `since` too ([The live view](#the-live-view)).

The intents, `requests` and `mock` go through the same `StopActions` as the client's `piwi/stopAction`
([Code from a stop](#code-from-a-stop)); the code goes to the client alone.

Each command is answered once (`{ type: 'answer', id, ok, message }`, with `image` too for `pausedPage`, `requests`
for `requests` and `locator` for `pick-at`, the sentence cut at `MAX_HUB_MESSAGE` with the cut marked). A command of
another type, with a field it cannot take, or answering a stop without naming it
(`The command needs the stop it answers.`) is answered `ok: false` with why. A connection has at most 16 commands
waiting. A message that is no command (not JSON, no `id`) closes the connection (4003), as do a binary frame (1003) and
a frame over 64 KiB (`MAX_HUB_FRAME`, 1009). Nothing a command asks evaluates code, reads a file or reaches an
instance.

**Intents.** An intent is asked of the one stopped worker (or the one named), at the stop `since` names. It is refused
at a stop no pause bar shows (`bar: false`) unless the connection watches that stop's live view, which drives it
there (`IntentParams.viewer`, `StopActions.action`'s `viewer`), and for a reporter whose `run-attach` does not list it
in `takes`.
Otherwise it goes to the worker as a `request` naming the stop, and the worker's answer is passed on (10 s at most).
The worker refuses one at a stop that is ending, or whose page it cannot tell; such a stop has no image either.

**Subscribe.** `subscribe` answers, then sends each live run as the client last heard it (`RunSessions.current`: the
view last sent, a run the client heard nothing of yet left out), and from then on every `piwi/runSessionChanged` the
client hears, so both show the same. Each run goes as a `session` with:

- the run's command line, kept by ref for the 50 latest commands the service built, cut at `MAX_HUB_COMMAND` with the
  cut marked;
- its folder's label and its Piwi project;
- each worker's `intents` (`RunSessions.intentsOf`): Assert, Assert a region and Mock a request only while the
  client writes the code from a stop;
- each stop's `intents`, what it takes from that connection now (`RunSessions.stopIntentsOf`): `input` only while it
  watches the stop's live view; Pick, Record, Assert and Assert a region where the bar shows or while it watches.

What the hub sends fits what `parseHubMessage` reads.

**Code.** A subscribed connection also hears, once, what each action that writes code came to, whichever surface
started it (`RunHub.code`, from `StopActions`' `outcome`): `{ type: 'code', ref, worker, since, action, ok, message,
warnings? }`. With `ok`, the message says the code was sent to the client to write (`Piwi sent the check to <client> to
write above checkout.spec.ts:5.`, the client's name as `initialize` gives it): the client, which can still refuse the
write, says itself that it wrote it (`piwi/stopCode`'s `message`). The warnings (16 at most, each cut as a sentence is)
say what to review in the code. With `ok: false`, the message says why an action was refused once it had started (the
cases a `piwi/notice` says, a region the worker refused included). The code itself never goes.

**Keepalive.** Every 20 s (`HUB_KEEPALIVE_MS`, within the 30 s Chrome keeps an MV3 worker alive after a WebSocket
message), each connection that said hello hears `keepalive` and a WebSocket ping. One that did not answer the last
ping is dropped, as is one with 32 MB unread.

**Closing.** A connection the hub closes (`closeWith`) is cut a second later (`CLOSE_GRACE_MS`) when the other side has
not answered the close. A connection being closed holds none of the places counted above.

A subscribed connection is a surface that answers stops, and one that said `follow` holds failures
([Stops no pause bar shows](#stops-no-pause-bar-shows)). Watching a stop's live view and following the runs are apart:
`follow` says a Runs window is open, `view` names one stop.

### The live view

A hub connection watches a stop's live view (`view`, with `since` and `on`; `RunSessions.watch`, the connection being a
`Viewer`). The worker starts the view as the stop's first viewer comes and stops it as the last goes (a viewer whose
connection closes goes, `unwatchAll`); a reporter that does not take `view` is refused. A viewer that comes once the
view is on asks the worker again, which sends the frame it sent last again: a still page paints no other.

- **Frames.** Each `frame` of the stop the worker stands at goes to that stop's viewers alone, none of an older stop:
  a view ends as its stop does. The hub sends a connection ten a second at most for each worker
  (`MAX_VIEW_FPS`), the latest one waiting while its socket holds more than 1 MB unread (`LatestPacer`), and none of a
  stop it no longer watches (`RunSessions.viewing`). It keeps none. Why a view sends no frame (`frame` with
  `refused`: each image of the page is over 384 KB) goes the same way, as a frame does.
- **Input.** `input` plays the connection's events (`@piwitests/core/run-view`: mouse, wheel, key and text, checked
  field by field, Playwright's key names alone) on the page of the stop it watches, 200 events a second at most for
  each connection (`MAX_VIEW_EVENT_RATE`), and is refused to any other.
- **Intents.** At a stop no pause bar shows, Pick, Record, Assert and Assert a region start for a connection that
  watches its view alone, which drives them through it. A connection that starts or stops watching hears the run
  again, with what its stops take now.

The frames carry whatever the page shows: they reach only the paired, authenticated connections that asked for them,
never the client, an instance or a file.

### Code from a stop

`src/stop-actions.ts` (`StopActions`) runs what a client and Piwi Picker start at a stop of a run the service built;
`src/stop-code.ts` is its pure half. The client asks with:

- `piwi/stopAction { ref, worker?, since, action, request? }`: `pick`, `record`, `assert`, `assert-region`, `mock`;
- `piwi/stopRequests { ref, worker?, since }`: the responses the test kept;
- `piwi/locatorAtCaret { ref, worker?, since, uri, line }`: the count of the locator on the caret's line.

Each is refused without `since`; Piwi Picker sends the hub's commands ([The hub](#the-hub)). Each action that writes
code ends the same way: the worker does the page's part through internal calls, the service renders the code, and the
client writes it. `piwi/stopCode` carries the run, the stop's `since`, the file's `uri` and `version`, the block, and
`edits`: the import lines, then the block on a new line above the stopped statement, placed in the file's text as the
service holds it, which the client applies as one edit. It goes only to a client that says it writes it
(`InitializationOptions.stopCode`); without it, Assert, Assert a region and Mock a request are refused (`NO_CODE`) from
both surfaces, and not offered to Piwi Picker (`intentsOf`). `pick` and `record` are the pause bar's own intents, whose
results take their own paths (Send to editor, then `piwi/applyPick`; `piwi/recordRequested`).

**Where the stopped statement stands now** (`src/run-lines.ts`, `RunLines`). The stop names a line of the run's code.
`RunLines` keeps the file as the service held it when the run started:

- when it built the run's command (`started`);
- for a run it did not build, when its first worker connects;
- for a rerun under the ref of a command that ended (a JetBrains IDE's Rerun, Rerun Failed and Debug start the
  configuration again with its `PIWI_ORIGIN_REF`), when its first worker connects too: `RunSessions` says `again`.

It follows every `didChange` since (read before the documents apply it; a whole new text by its line diff,
`diffLines`), the code of an earlier action included. A file no editor held since is taken from disk while its
modification time is older than the run, its text without the byte order mark it may start with, as a document's
(`diskFile`). A file it cannot follow is refused with why: written on disk since, opened since with a text other than
its disk's, held with changes not saved as the run started, more than 2,000 edits since, or a stopped line an edit
removed or rewrote from its start.

**Placement.** Each block goes where `placementBefore` puts a recording's (a chain broken over lines included), on the
page expression `pageCandidates` gives there (`this.page` in a page object), with the config's preferred locators and
the import of `expect` the file lacks (`blockImports`). The first code of a run adds that the stopped test goes on with
the code it started with. `placementBefore` refuses, for Record here too:

- a declaration's line: the block goes inside the body of a test or a function (`BlockPlacement.context`, where the
  line starts);
- the body of an `if`, `else`, `for`, `while` or `do` without braces;
- a call in an arrow function's expression body (`const go = async () => page.click('a')`), at the stop's column
  (`StopRef.character`, else the line's start: `FileModel.inArrowExpression`);
- a line where no statement starts.

Assert and Assert a region are refused at such a place before anything starts in the test's window. A check or a region
refused once it started (the recorder missing, the code not written, a worker's `region` with `refused`: the region it
picked finds several elements, or its snapshot is too long) reaches the client as a `piwi/notice`, and Piwi Picker as a
`code` with `ok: false`; a refusal of a stop that ended, as a `piwi/notice` alone.

**The actions.**

- `assert` starts the check panel in the test's window through the record channel's hand-off in its `check` mode,
  naming the stop it was started at (`RecordChannel`'s `onCheck`, `RecordingSessions.check`): the recorder loaded with
  `check` in its settings, its first `assert` event rendered, then the hand-off stopped; no editor is asked. A check
  whose stop ended, or that cannot be written at the stopped line, is refused at once.
- `assert-region` has the worker pick a region and send its ARIA snapshot (`region`), written as
  `toMatchAriaSnapshot` (`renderSpec`).
- `mock` asks the worker for the response chosen among those `piwi/stopRequests` lists (method, URL, status, type,
  size, time; no header, no body). Each URL has its credentials hidden again part by part, its host and ids kept
  (`hideSecretsInUrl`), whatever the worker's reporter hid. The mock is written with the browser extension's `mockCode`
  (`apps/extension/src/shared/mock-code.ts`, bundled in), on the page expression in scope: credentials hidden by name
  and by shape, by the rule `@piwitests/core/mask` writes down, in a JSON body and a JSON text inside its strings, a
  form or text body and the URL; no header written; the body inline. Its warnings say what was hidden, that a body
  neither JSON nor a form was written as it came, and that one seems to hold an email address or a phone number.

**The count at the caret.** `piwi/locatorAtCaret` reads the line's locator chain (`locatorChainOnLine`, the one
`piwi/applyPick` replaces). The chain must start from a page expression in scope there and be the stopped page's
(`stopPage`: the expression the code at the stop runs on, in the stopped file); another, or a chain in another file, is
refused, the answer naming the chain read (`locator` is null only for a line holding none Piwi reads). The worker counts
it on the stopped page and outlines its matches where the bar shows; a line without one, a refused one, or a null
`uri` takes the outline down.

A failure held at its line ([Stops no pause bar shows](#stops-no-pause-bar-shows)) takes the same actions.

### A run that debugs a failure

**Debug in my editor** on the dashboard's failure page opens the failing line through a client's open link with
`debug=1`; once the person said yes, the client asks `piwi/runArgs` with `RunTestsArgs.debug` (`src/debug-run.ts`,
`DebugRuns`):

- **The command.** The fields are checked one by one (`checkedDebugRun`: a line, a title and a project of plain
  text, an execution id), the spec and the failing line's file must be under the context's folder, and the test is
  the one of the spec as saved whose describe blocks' titles and its own, joined by ` › `, are the title, else the
  only one of its own title (`debugTest`). It runs alone (its location), in its Playwright project, with
  `--workers=1`, and headed with the editor's breakpoints and the failing line in `PIWI_PAUSE_AT`, as a run started to
  be watched (`withBreakpoints`). Anything refused answers null, with a `piwi/notice` saying why.
- **The one-shot stop.** The failing line is a breakpoint of that run alone: `piwi/setRunBreakpoints` for the run
  carries it beside the client's places until a worker stops there (heard through `RunSessions`' `heard`), and then
  the run's breakpoints become the client's own, for its workers and those that connect later. The client never
  holds it, so the editor's breakpoint list is left as it is.
- **The suggested locator.** With `execution`, the instance's locator healing of that execution is asked as the
  command is built (`PiwiContext.healing`), and again at the stop. Its recommended locator is counted on the stopped
  page through `RunSessions.locator`, outlined where the bar shows, and said in a `piwi/notice`. While it stands,
  `piwi/locatorAtCaret` on the stopped line answers it with no count, asking the worker nothing, so the caret's own
  count does not take the outline down; anywhere else the caret's count goes on as at any stop. No instance, no
  healing or no recommendation: the run only stops.

### Agents

`src/agent-server.ts` (`AgentServer`) serves the runs the service built to the agents of this machine as an MCP
server of its own, over MCP's streamable HTTP transport (one POST per request, answered with JSON; a notification
alone with a 202), its JSON-RPC pieces those of the instance's server (`src/mcp-protocol.ts`). It listens only once the
client turns it on, as the service starts (`InitializationOptions.agents.enabled`) or later (`piwi/agents { enabled }`,
answered with its address and token), and closes as the client turns it off or the service stops.

**Who reaches it.**

- `127.0.0.1` alone, at the port the client keeps (`InitializationOptions.agents.port`) when it is free, else a free
  one; the token the client keeps (`agents.token`, 32 to 256 characters of base64url), else a random one. Both clients
  keep them, so an agent's configuration copied once still connects after a restart. When another program holds the
  kept port, the server takes a free one with a new token (`AgentServer.moved`): an agent's copied entry sends the
  old token to that program, which must not open this server with it. The service then sends a `piwi/notice` asking
  to copy the configuration again, and `piwi/agentsChanged` with the new address and token, which the clients keep
  as they keep `piwi/agents`'s answer; it is sent only when they differ from what the client holds. `piwi/agents`
  with `newToken` (the clients' Reset the token) gives the server a new token (`AgentServer.newToken`), the one
  before refused from the next request on.
- A request whose `Host` is not `127.0.0.1` or `localhost` at its port is a 403 (`isHubHost`: DNS rebinding), and so is
  one that carries an `Origin`: a browser sends one with every POST, MCP clients are native. Another path is a 404,
  another method a 405, a body that is not JSON a 415, and a missing or wrong `Authorization: Bearer` a 401, the token
  compared in constant time (`sameToken`).
- A body is 256 KiB at most (`MAX_AGENT_BODY`, a 413), a batch 8 requests (`MAX_AGENT_BATCH`), and 8 requests run at
  once (`MAX_AGENT_REQUESTS`, a 503 with `Retry-After`). A long poll lets go of its slot as soon as nobody waits for
  it: its client closes the connection (the response's `close`), or cancels it (`notifications/cancelled` naming its
  JSON-RPC id), and the wait (`RunAgent.waitFor`) ends on the call's `AbortSignal`.

As for the hub, this user's own processes are not a boundary: the token reaches the agent through the client's
registration of the server (VS Code's provider) or a configuration the developer copies.

**The tools** (`src/run-agent.ts`, `RunAgent`): `run_list`, `run_follow`, `run_control`, `page_snapshot`, `page_act`,
`page_locator` and `code_write`, each with a closed set of arguments read one by one (`Args`, an unknown one refused)
and a JSON schema that names them (`AGENT_TOOLS`, `additionalProperties: false`).

- **Following a run.** `RunSessions` tells the agent what each worker says (`heard`): its connection, each test's
  start and end, each stop and its end, and, once an agent follows the run (`followRun`, sent as `events` to each of
  its workers whose reporter takes it, a later worker too), each call of the test as it ends, with its place, and each
  page's navigations, console errors and warnings, uncaught errors and failed requests. A rerun of a run's command
  (the same ref) numbers its events on from the run's before it, so a cursor of that run reads them. A follow lasts
  while the agent calls a tool on the run, and ends `FOLLOW_IDLE_S` (120 seconds) after its last call, or as agents
  are turned off (`RunAgent.off`): `unfollowRun` sends `events { on: false }`, a later worker hears nothing, and what
  the pages said in the events kept goes (`page: "dropped"` in `run_follow`), the snapshots read too when agents are
  turned off. Each run keeps its last 2,000 events, numbered (`seq`), and the 20 latest ended runs theirs. `run_follow
  { run, after?, wait? }` answers the events after the cursor, 200 at most (`more`), waiting up to `wait` seconds (25
  at most, `MAX_FOLLOW_WAIT_S`) for a stop or the run's end, and at once while the run is stopped or ended.
- **Controlling it.** `run_control { run, worker?, action, stop?, place?, wait? }` is `piwi/runControl` with
  `by: 'agent'` (`pause`, and `step`, `run-to`, `resume`, `finish` naming the stop they answer), then waits up to
  `wait` seconds (30 at most) for the run's next stop or its end. The stop a Pause, a Step or a Run to the agent
  asked for carries `RunStop.by: 'agent'`, which the clients show. `end` is refused: ending a test from a stop is not
  built yet. A `place` is a line of the run's code, relative to the run's folder.
- **Reading the page.** The answer to a stop, `page_snapshot { run, worker?, image?, depth? }` and `page_act` read
  the page's ARIA snapshot in AI mode through the worker (`RunSessions.snapshot`). The service keeps the last snapshot
  read of each worker (32 at most) and answers with its change since (a line diff, `snapshotChange`) when it is
  smaller than the snapshot and read to the same depth, else with the whole snapshot, 100,000 characters at most.
- **Acting on it.** `page_act { run, worker?, stop, target, action, value? }` has the worker play a click, a fill, a key
  press, a check, an uncheck or a select on the element of the ref (`RunSessions.act`, checked by `readAct`), and keeps
  it as the step a person's would be: the element ranked, a secret field's value never kept (`redacted`). The first
  action at a stop is a `piwi/notice` for the person watching. An action the page did not answer in time (the worker's
  10 seconds, answered `late`, or the service's) may still be played: the answer says so, and the request is heard a
  minute more (`hearLate`, `LATE_ANSWER_MS`), the worker answering it again once it was played, which keeps the step
  and adds an `act-played` event to the run's.
- **Locators.** `page_locator { run, worker?, target }` ranks the element as Pick does (`RunSessions.refLocator`): those
  that find it alone first, the suite's own locators first among them (`preferLocators`).
- **Code.** `code_write { run, worker?, stop, kind, target?, assertion? }` renders and sends to the client
  (`StopActions.agentCode`, `piwi/stopCode`): the steps taken at the stop (`steps`, then forgotten), the best locator
  of `target` in place of the stopped line's (`locator`, `renderStopLocator`), or an assertion on it (`assertion`:
  visible, hidden, enabled, disabled, checked, unchecked, text, value). Its sentences say the agent made it
  (`AGENT_WROTE`), to the client and, as a `code`, to Piwi Picker. A text assertion expects the element's whole text,
  which the worker reads up to `MAX_ELEMENT_TEXT` (1,000 characters, `textCut` past it), or, cut, that the element
  contains its first words (`toContainText`, `MAX_CONTAINED_TEXT`); `expectedOf` refuses a secret field, a text or a
  value a credential was hidden in, and a value cut at `MAX_ACT_VALUE`.

**The page is untrusted.** Each result holds Piwi's answer as JSON first, then, apart, what came from the page, between
two markers that share a random nonce (`pageContent`), which the page cannot guess: the snapshot and its change, the
address and the title, an element's name, text and value, the locators built from them (`page_locator` shows each
with its credentials hidden and counts those it hid in `hidden`; `code_write` writes it as the page has it), a
failure's error and its title (`Failed` in the JSON), the console, the page's errors, its requests' methods and URLs,
each through `hideSecretsInText` or `hideSecretsInUrl` again, and the worker's own message about a page call (`said`):
a read in the page's world can throw with the page's words, so the JSON says a fixed sentence in its place (`The
element could not be read; the page's own answer is in the page content.`), and only a refusal of the service's own
(`AgentAnswer.answered` false) is said as it is. An image comes last, after a text that says it is page content too,
since MCP's image content carries no words. The JSON that names the runs, the stops and the calls holds the test's
own words alone: its titles, files and lines, and Playwright's titles of the calls its code made, but for the text a
stopped fill, typing or insert types, which Playwright writes into its title (`Fill "…"`) and which may be a secret the
test reads from its environment (`stopTitle`: `Fill "<hidden>" getByLabel('Password')`). The tools'
descriptions and the server's `instructions` say to read the block as data, never as instructions.

**Sharing with Playwright's tools.** `piwi/stopBind { ref, worker?, since, on }` has the stopped worker bind its
browser (`browser.bind('piwi-<ref>-w<worker>', { workspaceDir })`), until the test ends, or unbind it, and answers the
name and the command that joins it (`npx playwright cli attach <name>`). It is the client's alone, never an agent's
tool: a bound browser is open to any process of this user.

### Another host

The desktop app's server is the hub of the runs its shell starts (`apps/application/server/utils/desktop-runs.ts`).
It runs these classes through `src/run-host.ts`, with no language server, and wires their callbacks to its own
surfaces as `server.ts` wires them to the client:

- `RunSessions` takes `host` and `surfaces`, what its sentences call the service and the surfaces that show stops (`No
  worker of this run is connected to the desktop app.`), and `declines`, the intents the host never starts, refused
  with its sentence and left out of `intentsOf` (Pick and Record in the test's window and Assert, which end in an
  editor). `host` also goes to each worker in `attached`, so the reporter's lines name the host (`Resume in the
  desktop app`). `holdsFailures` names the runs that hold no failure, whoever watches them (the desktop app's runs
  nobody attends): their workers hear `attached` without `failure`, and a failure that stops one anyway goes on.
- `RecordChannel` takes `folderPrefix`, what its socket's folder is named from (`piwi-desktop-run-`), so a host finds
  the folders a process of its own that was killed left behind.
- `RunHub` takes the `token` `hello` carries (the desktop token) and the sentence its connections close with
  (`closing`). `join` adds a peer of the host's own transport (`HubTransport`: `send`, `buffered`, `close`), which needs
  no handshake nor `hello`, counts toward none of the WebSocket's limits, and commands and hears the hub as a WebSocket
  connection that said hello does (`HubPeer.command`, answered with the `HubAnswer`). The desktop app's window is one,
  through routes behind the app's token.
- `StopActions` takes `words`, what its sentences say of the code made (`Piwi made the check to write above
  checkout.spec.ts:5: copy it in the desktop app's window.`) and why none is made for a file outside the host's folders,
  and runs without a recorder (`recordings`), refusing a check then.

### The discovery file

`src/discovery.ts` writes and reads `~/.piwi/editors/<pid>.json` (`@piwitests/core/editor-discovery`;
`PIWI_EDITORS_DIR` names another folder), which tells Piwi Picker, through the clients, where each service's hub is.

Once the run channel and the hub have opened (either one null when it could not listen, and no file when neither
could), `startServer` hands `publish` what the file says:

- the service's pid and machine (`host`, `os.hostname()`);
- its version (written in by `build.mjs`, `0.0.0-dev` unbundled) and its client (`initialize`'s `clientInfo`);
- `startedAt` and the workspace's folders (`roots`);
- the hub's address and token;
- the run channel's socket and token, for a run started in a terminal;
- the recorder bundle's path.

It hands `publish` null as it stops (`shutdown`, `exit`, the function `startServer` returns).

`src/main.ts` writes the file (`writeDiscovery`): in a folder this user owns, 0700, not a link; as a 0600 file, through
a temporary file renamed over it, so a reader never reads half of it. On Windows the profile folder's ACLs keep other
users out, as for `~/.piwi/desktop.json`. It removes the file then, on the process's `exit` (the client gone: the
connection's end or `--clientProcessId`), and on `SIGINT`, `SIGTERM` and `SIGHUP`.

A killed service leaves its file. Readers skip, and delete, the file of a process that is gone (`readLiveEditorsIn`,
`readLiveHubs`), as writing one does first. The VS Code extension's `GET /piwi/live` reads them through the
`./discovery` export; the JetBrains plugin reads the files in `Glue.liveHubs`. A reader:

- reads nothing from a folder that is a link, another user's, or one other users can enter (`privateFolder`, which the
  writer tightens instead);
- reads only the files this user owns, not links, in it;
- deletes only a file that reads as a discovery file of this machine (`host`, in any case) naming the process its file
  name names;
- skips, and leaves, any other file: a person's own numbered files, another machine's (a home folder several machines
  share).

## Coverage

### Coverage marks

Coverage (`src/coverage.ts`) is the lines, functions and files each test ran. The reporter records it per test, each
version of a file by its git blob id.

An application file's coverage comes from `GET /api/projects/:id/coverage?file=&branch=`, for the checked-out branch,
which the instance completes with the default branch's. It is:

- read when the file is first opened or asked about;
- kept per file (`PiwiContext.coverage`, 200 files at most);
- asked again with its `ETag` on a refresh, and after a run of the context ended (its latest run or the runs laid over
  it changed, or `piwi/runEnded`), together with the code index, which says which files coverage reaches.

Two cases are not asked for, and show nothing:

- a file the code index says no coverage reaches (`mayHaveCoverage`: not listed, or reached through routes only);
- any file, once the instance answered the route with a 404 (`coverageRoute`), until the next refresh.

The marks come from the first of these versions of the file:

1. the version whose blob id is the file's as it stands, open or saved (`textBlobIds`: as git stores it, CRLF as LF,
   with or without a byte order mark);
2. for a document edited since, the version the file as saved is;
3. the version the most tests recorded whose text is known (`BlobTexts`: a text seen with that blob id, else
   `git cat-file`).

The marks of the second and third are placed through `diffLines` and `placeLine`: a line a hunk added is `changed`
(changed since the coverage run), and a line it removed has no mark. With none of the three, the state is
`other-version`, and no line is marked.

`piwi/coverage` answers the marks of a file as it stands, within `LOOKUP_WAIT_MS`:

- `executed`, with how many tests ran each line;
- `notRun`, from the executable lines a run recorded for that version;
- `changed`;
- the counts and a `label`.

`piwi/coverageChanged` pushes the marks of a document the client asked about, against the answer the client holds, when
an edit, a read or a late answer changes them.

On an application file, `piwi/fileSummary` adds the coverage's tests to the file's `Reached by N tests` line, with
`41 of 63 lines run` when the executable lines are known, and gives each function that ran a line at its first line.
The `piwi.runTests` of those lines makes the run record the coverage again:

- on a server file, it carries `coverage: 'server'`, which `piwi/runArgs` turns into `PIWI_COVERAGE_SERVER=lines`;
- on a browser file, `coverage: 'browser'`, turned into `PIWI_COVERAGE_BROWSER=functions`.

The hover of a line names the tests that ran it, or says that none runs it, or that it changed since the coverage run.

### Uncovered changes

A file without coverage marks may have uncovered changes (`CoverageResult.uncovered`, `uncoveredOf` in
`src/server.ts`). The rule is the one the pull request's change coverage reads (`uncoveredFile` in `src/coverage.ts`):
Piwi can observe the file, and no test reaches it.

- Piwi observes a page by the file-routing convention while the locator index knows the pages tests visit, a server
  route while the code index maps routes to tests, or a file whose executable lines a run's coverage recorded.
- A test reaches the file through code reach and routes, through the coverage's tests, or by acting on its page.
- Without a code index, or with one cut short, no change is uncovered.

The marked lines are those changed since the default branch (`changedSince`): the lines the diff adds from the file at
the merge base of `HEAD` with `origin/<default>` (else `<default>`), blank ones left out (`PiwiContext.atChangeBase`,
`mergeBase` in `src/workspace.ts`). The base is read once per `HEAD`, each file once per base. The marks show in:

- `label`, which says so;
- the file's top line in `piwi/fileSummary` (`Uncovered changes: …`, no command);
- the hover of a marked line (`UNCOVERED_EXPLAINED`).

A move of `HEAD` computes them again.

## Analysis and completion

`src/analysis.ts` is the pure half of the service: locators per line, stability findings, replacements, the breaks of an
unsaved change and their call-site edits, and where completion offers the suite's locator chains. Test code, below, is a
spec or a file the locator index calls locators from.

### Diagnostics and quick fixes

- `brittle` (a warning) or `watch` (a hint): a locator of test code that the locator index rates brittle or worth a
  look. Quick fix: the stable alternative stored at that call site (`stableReplacement`).
- `timeout` (an information): a test of a spec whose timeout could be tighter (the timeout opportunities). Quick fix:
  set the timeout, or remove `test.slow()`.
- `locator-break` (a warning when the break is likely, else an information): a line of an application file whose
  unsaved change, compared with `HEAD`, breaks locators the suite uses (`breaksOfChange`). Quick fix: update every call
  site.
- `ci-failure`: a failure of the latest run ([Failure diagnostics](#failure-diagnostics-and-runs-laid-over)). Quick
  fixes: heal the locator, **Run this test**, open the trace, the desktop jobs, apply the fix plan (then run its
  verification), file an issue when the failure has no linked ticket, **Copy context for agent**, open the failure in
  the dashboard.

### Completion

In test code, completion offers:

- after `page.`, `this.page.` or another page expression that `pageCandidates` offers on the cursor's line
  (`adminPage.`, `this.root.`, `app.page.`): the suite's locator chains alone (`locatorCompletionSite`);
- right after `expect(`: the chain on the default page expression there;
- at the start of a statement: the project's functions for the pages this file's tests visit;
- in an annotation or a tag: the `piwi:` annotation types, and the known priorities, owners (from CODEOWNERS),
  features and tags.

The file is scanned (`pageCandidates`) only when the text before the cursor ends with a member chain and `.` other than
`page.` and `this.page.` (a method name partly typed after it included), or with `expect(`. `(` is a trigger character,
and completion after any other `(` is empty.

## Contexts and the instance client

### Contexts

`src/context.ts` holds one Playwright config of the workspace (`PiwiContext`): its connection, project, branch and
cached indexes.

The service finds the configs once initialized (`findPlaywrightRoots` in `src/workspace.ts`): every folder holding a
`playwright.config.*` (`.ts`, `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`), up to four levels below each workspace folder,
skipping dependencies, build output and hidden folders. A file belongs to the context with the deepest folder holding
it, else to the first context whose repository holds it.

A context's indexes describe the checked-out branch when the locator index has uses of its own for it, else the default
branch (`PiwiContext.branch`).

### Instance client and proxy

`src/piwi-client.ts` is the only file that talks to an instance; it also opens the event streams `src/run-stream.ts`
reads. Every request carries the connection's key, when it has one, in `X-API-Key`.

Its requests go through `src/http.ts`. When the service's environment names a proxy (`HTTPS_PROXY`, `HTTP_PROXY`,
`NO_PROXY`, upper or lower case, which both clients set from the editor's proxy settings):

- an instance off this machine is reached through it (`undici`'s `EnvHttpProxyAgent`, which Node 20 and 22 lack);
- this machine's addresses (`localhost`, `127.*`, `::1`), where the desktop app and a local instance listen, are
  reached directly.

## Desktop jobs

`src/desktop-jobs.ts` passes work from the team instance to the desktop app as a job (`@piwitests/core/desktop-job`).
It posts the job with the token of the app's discovery file: the app never receives the editor's key. Jobs are offered
only while the app runs and the context reads another instance than the app (`DesktopJobs.available`):

- on a failure, the quick fixes **Reproduce in the desktop app** and **Find the breaking commit in the desktop app** (a
  bisect);
- on a flaky test's line, and on a failure whose test has an untested suspect (`hasUntestedSuspect`), a `flake-lab`
  job.

A `flake-lab` job carries the test's reproduce plan, which the service reads from the instance with recording on
(`source=desktop`, and this machine's name). The app runs it with `piwi flake --plan <file> --json` against itself.

The service polls each job every 3 s and tells the client what changed (`piwi/desktopJobChanged`); a 404, or five failed
reads in a row, make the job `gone`. Asked to (`piwi/shareDesktopJob`), it shares the verdict on the instance with the
editor's key:

- a bisect's first bad commit, on the failure's cluster;
- a Flake Lab run's arms' counts, with the plan's conditions, on the experiment the instance recorded.

The job names commits, tests and lab conditions, never code. The app runs it only after a click in its window.

## Recorder

`src/recorder/` records a test from the editor into a file. `piwi/renderSteps` uses the same rendering (`renderSpec`)
for a flow recorded in Piwi Picker: it renders the flow at the caret, with the project's functions and the locators its
tests already use. Its URLs are written as paths when a project's `baseURL` is on the origin the flow was recorded on,
or when the config's options are not read within 3 s; whole otherwise.

### Project options, Node and the launcher

`piwi/record`:

1. Reads the `use` options Playwright resolves for the file's config (`project-options.ts`). It runs the project's own
   Playwright CLI, `playwright test --list` with `piwi-use-reporter.cjs` and a filter no spec matches, so Playwright
   reads the config and loads no test. The answer is cached per canonical config path, for five minutes at most, until
   the modification time or the size of one of these changes (`configFingerprint`): the config, the `.env*` files of
   its folder and of each folder above it up to the repository's, a local module the config imports.
2. Picks the project (a config with several asks the client, through `projects`), the start page and the page
   expression.
3. Forks the launcher in the config's folder (`sessions.ts`).

The options reader and the launcher both run with the project's Node (`node.ts`): under an editor's Electron, the first
`node` on the service's `PATH` when it is Node 20 or later, run without `ELECTRON_RUN_AS_NODE`; else the service's own
runtime.

The launcher (`launcher.ts`):

- resolves the project's Playwright at run time, never bundled (`playwright.ts`: in the project's own `node_modules`,
  the test runner's package first, as for the CLI);
- opens the browser with the project's options (`context-options.ts`): `headless: false` unless
  `PIWI_RECORDER_HEADLESS=1`, Chromium's translation feature disabled, an explicit allowlist of context options, and a
  missing `storageState` file left out and said so;
- exposes the binding, then loads `record-ide.js` into every page;
- answers the recorder over that binding (`host-state.ts`): the storage areas and messages of the IDE bundle's `chrome`,
  every event checked with core's `parseCaptureEvent`, 5,000 events a recording at most;
- records from the main frame of the page it opened first only. Every other frame and page (a popup, a cross-origin
  iframe) is answered as outside a recording, and a tab or a popup the application opens is said once, as a `notice`
  the session shows as an update's message;
- reports to the service over its IPC channel (`ipc.ts`).

### Recording updates

Each update renders all the steps again with `renderSpec`, and sends the whole block in `piwi/recordingChanged`, in
order. An event the launcher reports renders:

- at once, when the update interval since the latest update is over (`UPDATE_INTERVAL_MS`, 100 ms, longer after a slow
  rendering);
- otherwise, together with the events received meanwhile, once the interval is over.

A pause, from the editor or from the recorder's bar (`piwi-recording-paused`, passed both ways through the launcher),
records nothing until resume, and an update says `paused`. Resume sends the latest update again.

The session ends with a last update, sent at once, and closes the browser, on any of: Stop in the editor or in the
browser, closing the browser, closing the file.

### Page candidates and placement

`page-candidates.ts` reads the file's text alone, with a scanner in the style of `callEndLine` (no TypeScript parser).
It finds:

- the page expressions at a caret (`piwi/pageCandidates`, also the default of `piwi/renderSteps` given a `line`). A
  fixture named like a page that no page call of the test runs on (`todoPage`) is offered after `page`, as one that
  `may be a page object`;
- the context there: `test`, `function`, `class` or `file`, which `piwi/record` checks against `into`;
- the names declared before the caret: a page object already declared is not instantiated again;
- where the block goes and how it is indented: the caret's line when it is blank, else a new line after it, or after
  the statement whose brackets the caret is in (a multi-line `expect(`). A caret inside a bracket the file never closes
  is refused.

### Imports

`imports.ts` reads, in one pass of the same scanner:

- the names a file's import statements and top-level `require` declarations bind, and where each ends
  (`importBindings`);
- the modules its `test` and `expect` come from (`testImportOf`, `expectModuleOf`). `expect` comes from the module
  `test` comes from when that module is `@playwright/test`, or when the file or a spec beside it imports `expect` from
  it; else from `@playwright/test`. A session decides it once, when it starts.

An update and `piwi/renderSteps` carry the edit that adds the import lines the file's text lacks (`importEdit`). The
lines go after the file's last import statement; in a file that has `require` declarations and no import statement, as
`require` declarations after the last one (`requireForm`); else at its top. The edit is placed in the text the service
holds, and the client makes it with the block's write. `piwi/renderSteps` indents the code for the caret's line
(`indentBlock` in `sessions.ts`).

### Recording from a paused test

A test can hand its page to a recording (`recorder/handoff.ts`).

The service listens on a local socket, the record channel: a Unix socket in a new owner-only folder of the temporary
directory, or a named pipe on Windows. It opens once the service is initialized (`RecordChannel.open`). Every test run
the service builds, but a repeated one, names it in its environment twice, as `PIWI_RUN_CHANNEL` and
`PIWI_RECORD_CHANNEL` (`withRecording` in `src/server.ts`). A connection's first line tells a hand-off (`attach`) from a
worker's run connection (`run-attach`), which `onRun` hands to the run sessions ([Run sessions](#run-sessions)). When a
spec the run names holds a `page.pause()` call outside a comment (`PAGE_PAUSE`,
`withoutComments`), `withRecording` also adds `--headed` and sets `RunCommand.pauses`, for which the client names its
Send to editor pairing, as for breakpoints. On a machine that refuses the socket, there is no channel, and none of this
is added.

A hand-off goes as follows:

1. A test paused with Piwi's bar (at a breakpoint, or at `page.pause()` in a headed run) asks to record. It attaches
   with the channel's token, its file, its line, and its project's `testIdAttribute` and `baseURL`
   (`@piwitests/core/ide-recorder`, one line of JSON a message). The test spells its file as the run's folder spells it
   (`commandFolder`); the service names it to the editor as its workspace does (a folder opened through a link).
2. The client hears it as `piwi/recordRequested`, and starts the recording with `piwi/record` naming the `handoff`
   (`RecordParams.handoff`), which takes it out of the waiting ones.
3. A hand-off not taken in 30 s (`HANDOFF_WAIT_MS`), one the client declines (`piwi/declineRecord`: the file is being
   recorded into, or cannot be opened), and one whose `piwi/record` is refused hear why at once. So does one whose file
   no config of the workspace holds.

The session (`attach` in `sessions.ts`):

- writes the block on a new line above the line the paused statement starts on (`placementBefore` in
  `page-candidates.ts`), also when the statement is a chain broken over lines or is broken after an operator (an
  assignment after its `=`);
- renders it with `continuePage` (no opening `goto`, no viewport size, no first navigation, which only says where the
  recording began), on the page expression in scope there, with the config's Piwi options when they are read within
  10 s;
- drives the test's page through `handoffLauncher`: the test loads the bundle the service names into its page, relays
  every call of the recorder's binding, which the service's `RecorderHost` answers, and hears the pause and the stop as
  messages for the recorder.

## Build output

`npm run editor:build` writes five files to `dist/`. Both clients ship them side by side: VS Code in its `dist/`, the
JetBrains plugin in its `server/`. The service finds the other files next to its own bundle, or in `PIWI_EDITOR_DIST`
(the `distDir` option of `startServer` in tests).

| File                         | What                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `piwi-language-server.cjs`   | The language server (`src/main.ts`), which logs a rejected promise nothing waits on and keeps serving.             |
| `piwi-recorder-launcher.cjs` | The launcher a recording session forks (`src/recorder/launcher.ts`).                                               |
| `piwi-use-reporter.cjs`      | The Playwright reporter that prints a config's resolved options (`src/recorder/use-reporter.ts`).                  |
| `record-ide.js`              | The recorder's IDE bundle: the browser extension's recorder, built a second time for a browser the launcher opens. |
| `record-ide-messages.json`   | The extension's catalogs for the IDE bundle, by language.                                                          |

The first three are bundled by esbuild, as CommonJS for Node 20 and later. `build.mjs` writes the service's version
into the bundle (`SERVICE_VERSION` in `src/server.ts`, `0.0.0-dev` unbundled), which the discovery file and the hub's
`welcome` name. The last two come from `buildIdeBundle`,
which `build.mjs` imports from `apps/extension/scripts/build.mjs`: the build needs the extension's sources, and a change
to the recorder there changes what the editor clients ship. The service also bundles the extension's `mockCode`
(`src/stop-code.ts` imports it from `apps/extension/src/shared/mock-code.ts`), so a change to it changes the mocks
written at a stop.

## Commands

### How a command is built

A command is built here, never taken from the instance (`src/commands.ts`):

- A test run is `npx playwright test` with the instance's arguments, or with the locations a client names. The
  instance's arguments are `materialization.args`, else the words of its `npx playwright test` command line, split as
  every shell splits plain words and double quotes.
- A saved selection runs the words of its command line, split the same way.
- A fix plan's verification is its `npx playwright test` commands, built again (one per Playwright project, joined with
  `&&`).
- A Flake Lab line is `npx @piwitests/reporter flake [verify] <id>`.

Each argument is checked, then quoted (`shellWord`: bare when no shell changes it, else double-quoted). It must be a
test filter, or an option of `PLAYWRIGHT_OPTIONS`, none of which names a file Playwright loads or a folder it writes to.
An argument that is anything else, or that a shell would expand, refuses the whole command, and the clients run only
what the service built.

### The folder a command runs in

A command runs in the config's folder as the file system spells it (`commandFolder`, `canonicalPath`). Every `cwd` the
service hands a client uses it (`piwi/runArgs`, `piwi/runSelection`, the trace, the `piwi.runCommand` lines), never the
folder as the editor spelled it, which on Windows may carry a lower-case drive letter. The project's Playwright and the
config it loads then resolve `@playwright/test` to one path.

## Reads and caching

### Background reads

Requests answer from what the service already fetched:

- the project's indexes, failures, function catalog and vocabulary, fetched on the refresh timer (every five minutes),
  on `piwi/refresh` and after `piwi/setCredentials`;
- the failures also when a run ends, on the poll and on `piwi/refreshRun`.

Refreshes never overlap: one asked for while another runs follows it, once for all the asks meanwhile, with the latest
credentials (`refreshAll`). What an index gives every request (each file's call sites, a locator's stability) is
computed once per index (`callSitesOf`, `stabilityOf` in `src/analysis.ts`).

What belongs to one file (a spec's cases, a file's stored alternatives) or to one failure (its healing, fix plan, linked
issues, evidence) is fetched once, when first needed, and kept: a file's for five minutes and until the next refresh, a
failure's healing, fix plan and issues while the latest run stays the same. Only the diagnostics or the quick fix that
need it wait for it, and a quick fix or a hover waits 1.5 s at most (`within`, `LOOKUP_WAIT_MS`); the fetch goes on for
the next ask. A fetch that failed without the instance refusing it (no answer, a 5xx, a 408 or a 429) is asked again
next time (`once` in `src/context.ts`). A canceled quick fix or hover is not answered further.

Other reads:

- A failure's files at its run's commit are read once too, as many as the failures go through. Its diagnostics wait
  for nothing: the files as saved stand in until they are read.
- The translation values of `HEAD` are read once per `HEAD`, those of the working tree once per refresh, each once for
  every document that asks meanwhile.
- An edit costs the coverage no request: its marks are placed again on the text, from what is kept.

### Evidence files

A stored file (a trace, a screenshot) is written to `EVIDENCE_ROOT` as it arrives, never held in memory
(`PiwiClient.download`, through a partial file renamed once complete). `EVIDENCE_ROOT` is `piwi-editor` in this user's
cache folder (`%LOCALAPPDATA%` on Windows, `~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or `~/.cache` elsewhere),
with one folder per instance and stored path. It is created owner-only, and nothing is written to it when another user
owns it or it is a link (`privateFolder`). The files not used for a week are deleted when the service starts
(`pruneEvidence`), and a file another window deleted meanwhile is downloaded again.

### Pushed changes

A change is pushed against what the client holds:

- `piwi/statusChanged`, `piwi/runStatusChanged` and `piwi/failuresChanged` are sent when the answer differs from the
  last one sent, or answered to `piwi/status`, `piwi/runStatus` or `piwi/failures`;
- `piwi/coverageChanged` is sent when a document's marks differ from the last ones sent, or answered to `piwi/coverage`
  for it;
- `piwi/runSessionChanged` is sent when a run's session differs from the last one sent for it, at the pace
  [Run sessions](#run-sessions) gives.

A client can therefore keep the pushed answers without reading them again (the VS Code extension still reads the
status and what depends on it again after `piwi/statusChanged`). An answer counts as held as soon as it
is given, so a client that read the state midway through a refresh still hears where the refresh ends.

### Response cache

What the instance says did not change is not read again:

- The locator and code indexes are asked with the `ETag` they came with (`If-None-Match`). A 304 keeps the same object,
  so what is computed once per index stays.
- The contexts of one service share these answers (`ResponseCache`, created in `startServer`), a request on its way
  included. A repository with eight Playwright configs reading one project holds and downloads its index once, not
  eight times.
- The plain reads share the same map for 2 s (`SHARED_MS`, `PiwiClient.get`): the request on its way and its answer, by
  instance, key and path. So the project's latest run, flaky tests, Flake Lab, quarantine, selections, timeout
  opportunities, function catalog and vocabulary are read once per refresh and once per poll for all the configs
  reading one project. Each context gets its own copy of the answer (`structuredClone`), as when it parses its own:
  nothing keyed by a failure's identity crosses contexts.
- A plain answer the instance gives an `ETag` (the project's latest run, `branch-failures`) is kept past those 2 s, and
  asked again with it. A 304 gives each context a copy of the answer kept, which may be newer than the one the context
  holds (another context read it), and `refreshRun` compares the two (`JSON.stringify`). So a poll that finds nothing
  new downloads nothing, and the instance answers it without computing the failures.

The shared answers give way as follows:

- Each wave of reads the server starts reads afresh (`forgetShared`): a refresh, a poll, `piwi/refreshRun`, a move of
  `HEAD`. Its contexts share within the wave, and an answer with an `ETag` is asked with it.
- A read that failed is shared only by the callers that joined it.
- A run as it moves (`runDetails`, `latestRunByRef`, a desktop job) keeps no answer, and the read after a run ended
  takes none (`refreshRun(true)`); an answer with an `ETag` is asked with it all the same.
- The map keeps 16 indexes and 64 plain answers at most; the plain answers past their time without an `ETag` go first
  (`trim`).

A file's coverage is asked the same way, but kept by the context that reads the file rather than in the shared answers.
Its marks are computed once per coverage and text.

### Failures placed by one context

A failure shows once, from the config its spec belongs to. The configs of a repository that read one project each list
all its failures, and each would find their files from the repository's root. So a context places a failure only when
its config folder holds the failure's spec, or when no other config folder does (`placedElsewhere`). A failure's files
at its run's commit are then read, and its diagnostics sent, once, not once per config.

### Refresh order

A refresh reads the failures first (`PiwiContext.refresh`):

1. the project and its locator index (the ladder needs the default branch);
2. the latest run, whose failures and status are published at once (`onRun`);
3. only then the other indexes, side by side.

When the read of a list fails (flaky tests, Flake Lab, quarantine, selections, timeout opportunities), the list keeps
what it held. The code index becomes null, and the function catalog and the vocabulary empty, until a later read.

The slow reads are one request each: the selections resolved together (`selections?resolve=true`, the first 20 kept),
and the vocabulary from the catalog's search values (`test-cases/facets`). An instance without them is read the old way
(each selection's `resolve`, the first thousand tests).

## Connection

### Connection order and watching `HEAD`

The connection order is fixed (`resolveContextConnection`):

1. The desktop app, while it runs, when the editor chose it (`desktop` in `piwi/setCredentials`). The choice is kept on
   the user's machine: the app is theirs, so their choice comes first.
2. The named instance (`namedInstance`): the environment, then the workspace `.env` (the config's folder before the
   repository root's), then the editor's own settings. What Connect saved is explicit, so it comes before an app that
   only runs.
3. The desktop app's discovery file (`~/.piwi/desktop.json`, or the file `PIWI_DESKTOP_CONFIG` names).

A key goes only with the URL it came with. A URL from the environment or a workspace `.env` takes the key saved in the
editor only when it is the URL that key was saved for, and a workspace `.env` never takes the environment's
`PIWI_API_KEY` (`namedInstance`, and core's `resolvePiwiConnection`).

The desktop app sits beside a shared instance, never replaces it: `piwi/status` keeps the named instance (`instance`)
and says whether the app runs (`desktopUrl`), so Connect offers both. The project read on the app is:

- with the app chosen: `desktopProject`, else the project the app links to the folder holding the Playwright config
  (`projects` in `~/.piwi/desktop.json`), else `PIWI_PROJECT_NAME`;
- with the app reached because nothing else names an instance: `PIWI_PROJECT_NAME`, else the editor's, else the linked
  one.

The service watches the discovery file every 2 s: `piwi/statusChanged` tells the client when the app starts or quits,
and `piwi/desktop` tells Connect what the app offers.

It watches `HEAD` and `logs/HEAD` of each repository the contexts are in the same way (`fs.watchFile`, every 2 s).
`headFiles` in `src/workspace.ts` finds them where git keeps them, for a worktree or a submodule too. A checkout or a
commit:

- drops what `HEAD` gave the repository's contexts (`PiwiContext.headMoved`): the files as `HEAD` holds them, and its
  translation values. The files at a run's commit stay;
- reads their latest run again, published when it changed;
- analyzes the open documents again, against the new `HEAD`.

The refresh timer keeps its pace. A context that changes instance forgets everything read from the other one. The
reporter keeps its own order.

### API key and MCP server

The API key leaves the process only:

- in `X-API-Key`, on the requests to its instance;
- in the MCP server definition that `piwi/mcp` hands the client for its agent, as an `Authorization` header, while the
  credentials' `mcpAuthorization` is `key` (the default).

With `sign-in`, an instance's definition carries no header, and the agent signs in through the instance's OAuth
(`authorization` says which). The desktop app's definition keeps its token either way, since the app has no sign-in. A
connection without a key gets `authorization: 'none'`. `piwi/mcp` gives one definition per instance the contexts read.

## Tests

`npm run editor:test` runs the Vitest suites of `tests/`. `tests/lsp.test.ts` drives the server in-process, as a client
does, against a fixture repository and a stub instance. `tests/run-sessions.test.ts`, `tests/run-hub.test.ts` and
`tests/discovery.test.ts` cover the run sessions, the hub and the discovery file, and `tests/run-host.test.ts` the run
control as another host builds it. `tests/agent-server.test.ts` and `tests/run-agent.test.ts` cover the agents' MCP
server and its tools, and `tests/agent-run.test.ts` an agent on a real Playwright run, through the reporter's build
(`npm run reporter:build`) and Chromium: it skips without them.

These tests use the build in `dist/`, so run `npm run editor:build` first:

- `tests/launcher.test.ts` runs the built launcher with this repository's Playwright and Chromium, headless, and plays a
  person's input through a second client attached over the DevTools protocol.
- The first test of `tests/handoff.test.ts` records from the page of a paused test, through the built recorder bundle.
- The stdio test of `tests/lsp.test.ts` ("the bundle") starts `dist/piwi-language-server.cjs`.
- The tests of `tests/discovery.test.ts` under "the bundled service" start it too, on Unix only, and check that it
  writes its discovery file and removes it.

The first two also need Chromium (`npx playwright install chromium` once), and skip, saying why, when either is missing.
The stdio test and the bundled service's tests skip silently without the bundle.
