# Editor service architecture

How the editor service in `packages/editor/` works: the protocol and what each request answers, the runs and failures,
coverage, the recorder, the build, and the reads and the connection behind the rules. The rules are in
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
- **Push**: a notification the service sends unasked, carrying a whole answer: `piwi/failuresChanged` carries what
  `piwi/failures` answers.

### Source files

- `src/main.ts`: the bundle's entry point; it serves over stdio, or over the transport the client names (`--stdio`,
  `--node-ipc`, `--socket=<port>`).
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
- `src/recorder/`: recording from the editor: the project's options, the launcher, the sessions, page candidates,
  imports and the record channel.
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
  `PIWI_ORIGIN_REF`, `PIWI_PAUSE_AT`, `PIWI_RECORD_CHANNEL`, `PIWI_COVERAGE_SERVER`, `PIWI_COVERAGE_BROWSER`.
  Breakpoints need a reporter from `PAUSE_REPORTER_VERSION` on, and the service warns about an older one.
- **The desktop app.** The service reads its discovery file and passes it jobs (`@piwitests/core/desktop-job`). An app
  too old to take jobs answers 404 (or 400 to a Flake Lab job), which the service reports.

### Requests and notifications

`src/server.ts` wires the protocol. Beside the LSP features (diagnostics, quick fixes, hover and completion), it handles
the custom messages of `src/protocol.ts`:

- **Requests**, from the client:
  - files and tests: `piwi/fileSummary`, `piwi/testsForFile`, `piwi/testAt`, `piwi/testItems`, `piwi/coverage`;
  - runs: `piwi/runArgs`, `piwi/runSelection`, `piwi/selections`, `piwi/runStatus`, `piwi/refreshRun`, `piwi/runId`;
  - failures: `piwi/failures`, `piwi/agentContext`, `piwi/trace`, `piwi/screenshot`, `piwi/applyPick`;
  - connection: `piwi/status`, `piwi/refresh`, `piwi/desktop`, `piwi/mcp`;
  - desktop jobs: `piwi/desktopJob`, `piwi/shareDesktopJob`;
  - recorder: `piwi/record`, `piwi/stopRecording`, `piwi/recordingCommand`, `piwi/pageCandidates`, `piwi/renderSteps`.
- **Notifications from the client**: `piwi/setCredentials`, `piwi/setBaseline`, `piwi/commandStarted`,
  `piwi/commandEnded`, `piwi/declineRecord`.
- **Notifications from the service**: `piwi/statusChanged`, `piwi/runStatusChanged`, `piwi/failuresChanged`,
  `piwi/coverageChanged`, `piwi/runEnded`, `piwi/notice`, `piwi/desktopJobChanged`, `piwi/recordingChanged`,
  `piwi/recordRequested`.

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

- where the `test(…)` call spanning the position's line starts (`testCallAt`: `TEST_CALL`, `callEndLine`), as
  Playwright's location filter takes it: `location`, such as `tests/checkout.spec.ts:42`, relative to the config's
  folder, in the text as it stands;
- the catalog's test of that title, matched by its title alone (the summary also matches the titles of the
  `test.describe(…)` blocks around it);
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

Each test is given as the spec stands (`testCalls` in `src/analysis.ts`: each `test(…)` call, with the titled
`test.describe(…)` blocks around it). It comes with the catalog's case of its title in those blocks (`caseOfCall`), its
location, its latest result and its failure, as `piwi/fileSummary` gives them: both read them from `specTests` in
`src/server.ts`.

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

With `repeat`, it runs each test that many times without retries (`repeatArgs`: `--repeat-each=3 --retries=0`, for
**Verify ×3**), headless: neither the breakpoints nor the record channel are passed. A repeated command's run counts
the `test-completed` results of its stream, once per execution (`RunWatch.tally`), beside the run's own counts, which
hold one result per attempt, project and repetition (an older instance kept one per attempt and project). Its
`piwi/runEnded` carries `repeat` (`repeatVerdict`): `Passed 3 of 3`, `Failed 1 of 3`, or `Failed at least 1 of 3`
when the stream missed some results. When its run reached no instance, its `piwi/commandEnded` brings a `piwi/notice`
from the exit code (`exitVerdict`).

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

The client adds its Send to editor address as `PIWI_EDITOR_SEND`. The reporter's capture fixtures pause the run, with
Piwi's pause bar, before a call that Playwright's debugger stops at on those lines (a navigation, an action, a read, an
assertion). A locator picked there is posted to that address with its file and line.

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
the service builds, but a repeated one, names it in its environment as `PIWI_RECORD_CHANNEL` (`withRecording` in
`src/server.ts`). When a spec the run names holds a `page.pause()` call outside a comment (`PAGE_PAUSE`,
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

The first three are bundled by esbuild, as CommonJS for Node 20 and later. The last two come from `buildIdeBundle`,
which `build.mjs` imports from `apps/extension/scripts/build.mjs`: the build needs the extension's sources, and a change
to the recorder there changes what the editor clients ship.

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
  for it.

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
does, against a fixture repository and a stub instance.

Three tests use the build in `dist/`, so run `npm run editor:build` first:

- `tests/launcher.test.ts` runs the built launcher with this repository's Playwright and Chromium, headless, and plays a
  person's input through a second client attached over the DevTools protocol.
- The first test of `tests/handoff.test.ts` records from the page of a paused test, through the built recorder bundle.
- The stdio test of `tests/lsp.test.ts` ("the bundle") starts `dist/piwi-language-server.cjs`.

The first two also need Chromium (`npx playwright install chromium` once), and skip, saying why, when either is missing.
The stdio test skips silently without the bundle.
