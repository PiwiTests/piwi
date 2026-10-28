# Editor service: agent guide

Rules for working inside `packages/editor/` (`@piwitests/editor`, the Piwi language server). The VS Code extension and
the JetBrains plugin each bundle this service and start it over stdio, so every answer an editor shows comes from here.
Read [`../../AGENTS.md`](../../AGENTS.md) first for the repository-wide conventions. How the service works is in
[`ARCHITECTURE.md`](ARCHITECTURE.md): its sections are listed at the end of this file.

## Rules

### Logic and protocol

- **All editor logic lives in this service; the clients only render its answers.** Both editors then give the same
  answers. Put new pure logic in `src/analysis.ts`, or in `@piwitests/core` when the CLI or the dashboard needs it too.
- **Never re-implement a core function.** Import it from `@piwitests/core`.
- **A protocol change updates both clients in the same change, with no compatibility path.** Each client bundles the
  service built from its own commit, and `@piwitests/editor` is private, so no client of another version talks to it.
  This covers every request and field of `src/protocol.ts`, which VS Code imports and the JetBrains plugin mirrors in
  `Protocol.kt`. ([ARCHITECTURE.md](ARCHITECTURE.md#clients-and-versions))
- **Renaming a command id (`PiwiCommand.command`) is a breaking change for users**, whatever the clients do: their
  keybindings and settings name the ids, which `proposals/1.0-stabilization.md` freezes at 1.0.
- **The instance, the project's reporter and the desktop app may be older than the service: keep reading them.** Each
  is installed on its own, so a route or a field an older one lacks has a fallback, and the variables a test run passes
  the reporter (`PIWI_ORIGIN`, `PIWI_ORIGIN_REF`, `PIWI_PAUSE_AT`, `PIWI_RUN_CHANNEL`, `PIWI_RECORD_CHANNEL`,
  `PIWI_COVERAGE_SERVER`, `PIWI_COVERAGE_BROWSER`) keep their names and formats. On the run channel, an intent a
  worker's `run-attach` does not list in `takes` is refused. ([ARCHITECTURE.md](ARCHITECTURE.md#clients-and-versions))
- **A change is pushed only when it differs from what the client holds.** `piwi/statusChanged`, `piwi/runStatusChanged`,
  `piwi/failuresChanged` and `piwi/coverageChanged` compare with the last answer sent or answered,
  `piwi/runSessionChanged` with the last session sent, and each carries the whole new answer, so a client can keep it
  without reading it again. Checked by `tests/lsp.test.ts` ("a change pushed to the client").
  ([ARCHITECTURE.md](ARCHITECTURE.md#pushed-changes))
- **Completion scans the file only after a member chain and `.`, or after `expect(`.** `(` is a trigger character, and
  completion after any other `(` is empty (`locatorCompletionSite`). ([ARCHITECTURE.md](ARCHITECTURE.md#completion))

### Commands and git

- **Commands are built by the service, never taken from the instance.** `src/commands.ts` checks each argument (a test
  filter, or an option of `PLAYWRIGHT_OPTIONS`, none of which loads or writes a file) and quotes it (`shellWord`); any
  other argument refuses the whole command, and the clients run only what the service built. Checked by
  `tests/commands.test.ts`. ([ARCHITECTURE.md](ARCHITECTURE.md#how-a-command-is-built))
- **A command runs in the config's folder as the file system spells it** (`commandFolder`, `canonicalPath`). Every `cwd`
  handed to a client uses it, never the folder as the editor spelled it (on Windows, possibly with a lower-case drive
  letter). Checked by `tests/lsp.test.ts` ("the folder a command runs in").
- **A commit, a branch or a blob id reaches git only when it matches its pattern, never as an option** (`COMMIT`,
  `BRANCH`, `BLOB` in `src/workspace.ts`). The commit and branch checks are tested by `tests/lsp.test.ts` ("a file is
  read at a commit by its object name only") and `tests/workspace.test.ts` ("where a branch left the default branch");
  the blob check has no test yet.

### Reads and caching

- **Nothing blocks typing.** Requests answer from what the refresh timer, `piwi/refresh` and `piwi/setCredentials`
  fetched. Data for one file or one failure is fetched once, when first needed, and a quick fix or a hover waits for it
  1.5 s at most (`within`, `LOOKUP_WAIT_MS`). ([ARCHITECTURE.md](ARCHITECTURE.md#background-reads))
- **Refreshes never overlap.** A refresh asked for while another runs follows it (`refreshAll`).
- **What an index gives every request is computed once per index** (`callSitesOf`, `stabilityOf` in `src/analysis.ts`).
- **A canceled quick fix or hover is not answered further** (`token.isCancellationRequested` in `src/server.ts`).
- **The failures come first on a refresh** (`PiwiContext.refresh`). The project and its locator index, then the latest
  run, published at once (`onRun`), and only then the other indexes. Checked by `tests/lsp.test.ts` ("an instance slow
  to answer the indexes"). ([ARCHITECTURE.md](ARCHITECTURE.md#refresh-order))
- **What the instance says did not change is not read again.** Indexes and answers with an `ETag` are asked with
  `If-None-Match`. The contexts of one service share answers (`ResponseCache`, `SHARED_MS`), each getting its own copy
  (`structuredClone`), so nothing keyed by a failure's identity crosses contexts. Checked by `tests/lsp.test.ts` ("a
  latest run the instance says did not change"). ([ARCHITECTURE.md](ARCHITECTURE.md#response-cache))
- **A failure shows once, from the config its spec belongs to** (`placedElsewhere`). A context places a failure only
  when its config folder holds the spec, or when no other config folder does. Checked by `tests/lsp.test.ts` ("the
  configs of one repository reading one project"). ([ARCHITECTURE.md](ARCHITECTURE.md#failures-placed-by-one-context))
- **Stored files go to disk as they arrive, in an owner-only folder.** A trace or a screenshot is written to
  `EVIDENCE_ROOT`, never held in memory (`PiwiClient.download`); the folder is created owner-only and never written to
  when another user owns it or it is a link (`privateFolder`). Checked by `tests/context.test.ts` ("the folder files are
  downloaded to"). ([ARCHITECTURE.md](ARCHITECTURE.md#evidence-files))

### Instance and connection

- **`src/piwi-client.ts` is the only file that talks to an instance.** Its requests go through `src/http.ts`, which
  follows `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (`tests/http.test.ts`).
  ([ARCHITECTURE.md](ARCHITECTURE.md#instance-client-and-proxy))
- **An instance receives paths, branch names and commit metadata from the workspace, never a file's content.** A
  request names a spec, a test file or an application file by its path, the checked-out branch, the machine a Flake
  Lab plan is for (`flakePlan`), and for a shared bisect the commit's SHA, subject, author and date (`recordBisect`).
- **The API key leaves the process only in `X-API-Key` and in the MCP server definition.** `piwi/mcp` includes it only
  while the credentials' `mcpAuthorization` is `key`; with `sign-in`, the agent signs in through the instance's OAuth.
  Checked by `tests/lsp.test.ts` ("Piwi’s MCP server for the agent").
  ([ARCHITECTURE.md](ARCHITECTURE.md#api-key-and-mcp-server))
- **A key goes only to the server URL it came with.** A URL a workspace `.env` names never gets the key saved in the
  editor for another URL, nor the environment's `PIWI_API_KEY` (`namedInstance`, core's `resolvePiwiConnection`).
  Checked by `tests/context.test.ts` (`resolveContextConnection`).
- **The connection order is fixed** (`resolveContextConnection`). The desktop app when the editor chose it, then the
  named instance (`namedInstance`: the environment, the workspace `.env`, the editor's settings), then the desktop app's
  discovery file; the reporter keeps its own order. Checked by `tests/context.test.ts`.
  ([ARCHITECTURE.md](ARCHITECTURE.md#connection-order-and-watching-head))
- **The desktop app sits beside a shared instance, never replaces it.** `piwi/status` keeps the named instance
  (`instance`) and says whether the app runs (`desktopUrl`), so Connect offers both. Checked by `tests/lsp.test.ts`
  ("the desktop app chosen with Connect").
- **A context that changes instance forgets everything read from the other one** (`PiwiContext.forget`).
- **A desktop job names commits, tests and lab conditions, never code.** The app runs it only after a click in its
  window, and never receives the editor's key (`src/desktop-jobs.ts`). ([ARCHITECTURE.md](ARCHITECTURE.md#desktop-jobs))

### Recorder

- **The recorder never bundles Playwright.** The launcher resolves the project's own Playwright at run time
  (`src/recorder/playwright.ts`) and runs with the project's Node (`src/recorder/node.ts`).
  ([ARCHITECTURE.md](ARCHITECTURE.md#project-options-node-and-the-launcher))
- **Only the main frame of the page a recording opened first records.** Every other frame and page (a popup, a
  cross-origin iframe) is answered as outside a recording (`src/recorder/host-state.ts`).
- **The record channel is private to this user.** Its Unix socket lives in a new owner-only folder of the temporary
  directory (a named pipe on Windows), and a paused test attaches, or a worker opens its run connection (`run-attach`),
  only with the channel's token, compared in constant time (`sameToken` in `src/recorder/handoff.ts`). Checked by
  `tests/handoff.test.ts` and `tests/run-sessions.test.ts` ("… refuses a wrong token").
  ([ARCHITECTURE.md](ARCHITECTURE.md#recording-from-a-paused-test))
- **A recorder change in `apps/extension` changes what the editor clients ship.** `build.mjs` imports `buildIdeBundle`
  from `apps/extension/scripts/build.mjs` to write `record-ide.js` and its messages, so the build needs the extension's
  sources. So does a change to the extension's `mockCode` (`src/shared/mock-code.ts`), which `src/stop-code.ts` bundles
  for Mock a request. ([ARCHITECTURE.md](ARCHITECTURE.md#build-output))

### Run control

- **A control that answers a stop names it (`since`), and reaches no worker past it.** `piwi/runControl` answers
  `The test went on.` for a `since` no worker stands at, and the hub refuses `step`, `resume`, `finish`, an intent,
  `requests` and `mock` without one, as `piwi/stopAction`, `piwi/stopRequests` and `piwi/locatorAtCaret` are. Checked
  by `tests/run-sessions.test.ts` ("names each stop apart, …").
  ([ARCHITECTURE.md](ARCHITECTURE.md#controls-breakpoints-and-the-paused-page))
- **A line a client sends for a run is a line of the run's code** (`run-to`, `piwi/setRunBreakpoints`). The client maps
  a document edited since the run started back to it, and the service refuses or leaves out a file outside the run's
  folder, as `PIWI_PAUSE_AT` does. ([ARCHITECTURE.md](ARCHITECTURE.md#controls-breakpoints-and-the-paused-page))
- **A stop no pause bar shows goes on unless a surface answers stops.** The surfaces are a client that sent
  `InitializationOptions.runControl` and a subscribed hub connection (`answersStops` in `src/server.ts`). Checked by
  `tests/run-sessions.test.ts` ("… a client that does not answer stops") and `tests/run-hub.test.ts` ("a stop nobody
  else can answer …"). ([ARCHITECTURE.md](ARCHITECTURE.md#stops-no-pause-bar-shows))
- **One connection per worker of a run.** A run connection naming the index of a worker connected now is closed, so
  another process the run's environment reached takes no worker's place. Checked by `tests/run-sessions.test.ts`
  ("refuses a second process …"). ([ARCHITECTURE.md](ARCHITECTURE.md#run-sessions))
- **The hub listens on `127.0.0.1` alone, and opens a WebSocket only for a browser extension that names it as this
  machine.** A `Host` other than `127.0.0.1` or `localhost` at its port or at one the client forwards (`piwi/hub`,
  `isHubHost`), or an `Origin` that is not an extension's (`isExtensionOrigin`), gets a 403 first, and commands are read
  only after `hello` with the hub's token (`sameToken`) within `HUB_HELLO_MS`. Checked by `tests/run-hub.test.ts` ("the
  handshake", "takes a loopback Host at a port the client forwards …"). ([ARCHITECTURE.md](ARCHITECTURE.md#the-hub))
- **A hub command is one of a closed set, checked field by field (`parseHubCommand`), and nothing it asks evaluates
  code, reads a file or reaches an instance.** Checked by `tests/run-hub.test.ts` ("the commands").
  ([ARCHITECTURE.md](ARCHITECTURE.md#the-hub))
- **The hub keeps out other users and web pages, not this user's own processes.** Its token is in the discovery file
  and in the clients' `GET …/live`, which any holder of the pairing's token reads, the runs the editor starts included
  (`PIWI_EDITOR_SEND`). ([ARCHITECTURE.md](ARCHITECTURE.md#the-hub))
- **What the hub sends must read with `parseHubMessage`, which Piwi Picker uses.** The hub cuts the command line, the
  project and client names and the folders to its limits (`MAX_HUB_COMMAND`, `MAX_HUB_ROOTS`, …). Checked by
  `tests/run-hub.test.ts` ("what the hub sends"). ([ARCHITECTURE.md](ARCHITECTURE.md#the-hub))
- **A live view's frames go only to the hub connections that watch that stop, and never outlive it.** No frame goes to
  the client, an instance or a file, none of a stop that ended, and the hub keeps none: a viewer that comes to a view on
  has the worker send its latest frame again (`RunSessions.watch`, `RunHub.frame`). Checked by `tests/run-view.test.ts`.
  ([ARCHITECTURE.md](ARCHITECTURE.md#the-live-view))
- **At a stop no pause bar shows, input and the actions in the test's window come only from a connection watching its
  view.** `stopIntentsOf` offers them so, and `intent` and `input` refuse anyone else; following the runs (`follow`)
  grants neither. Checked by `tests/run-view.test.ts` ("takes Pick and Record … from a viewer of its view alone",
  "plays a viewer’s input …"). ([ARCHITECTURE.md](ARCHITECTURE.md#the-live-view))
- **A failure no pause bar shows is held only where a person can answer it.** In a run the service built to be watched,
  or while a hub connection said `follow` with `on: true` (`followed` in `src/server.ts`), never in a run its host says
  holds none (`holdsFailures`), and only for a worker whose `run-attach` lists `holds`, answered with `attached`
  (`SHOWN_HOLDS`). Checked by `tests/run-sessions.test.ts` ("holds a failure no bar shows only …", "holds no failure in
  a run its host says …", "tells a worker that holds a failure …") and `tests/stop-actions.test.ts`.
  ([ARCHITECTURE.md](ARCHITECTURE.md#stops-no-pause-bar-shows))
- **The code from a stop goes to the client that writes it, placed where the stopped statement stands now, or is
  refused.** `RunLines` follows the file from the run's start (a rerun's own start) through every `didChange`, and
  `placementBefore` refuses a declaration's line, a body without braces (an arrow's expression body included) and a line
  where no statement starts. Checked by `tests/stop-actions.test.ts`, `tests/run-lines.test.ts` and
  `tests/page-candidates.test.ts`. ([ARCHITECTURE.md](ARCHITECTURE.md#code-from-a-stop))
- **The hub tells what a code came to, never the code, and says it was sent to the client, not written.** The client,
  which can still refuse the write, says itself that it wrote it (`piwi/stopCode`'s `message`). Checked by
  `tests/stop-actions.test.ts` ("tells each follower once what each code came to, …").
  ([ARCHITECTURE.md](ARCHITECTURE.md#the-hub))
- **No credential of a stopped test's requests leaves the service unhidden.** Each URL goes through `hideSecretsInUrl`
  again, whatever the worker's reporter hid, and a mock through `mockCode`, by the rule `@piwitests/core/mask` writes
  down. Checked by `tests/stop-actions.test.ts` ("lists the responses a test kept with the credentials …").
  ([ARCHITECTURE.md](ARCHITECTURE.md#code-from-a-stop))
- **The run control runs without the language server too: the desktop app's server hosts it.** `src/run-host.ts`
  exports `RecordChannel`, `RunSessions`, `RunHub`, `StopActions` and `RunLines`, which import nothing of the LSP;
  `apps/application/server/utils/desktop-runs.ts` wires them, so a change to their options runs its tests too
  (`apps/application/tests/unit/desktop-runs*.test.ts`). Checked here by `tests/run-host.test.ts`.
  ([ARCHITECTURE.md](ARCHITECTURE.md#another-host))
- **The agents' MCP server listens on `127.0.0.1` alone, only once the client turns it on (`agents.enabled`,
  `piwi/agents`), and answers only its own `Host`, a request with no `Origin`, and its bearer token compared in
  constant time.** Anything else is refused before a tool runs (`src/agent-server.ts`), and a body, a batch and the
  requests at once are bounded, a long poll letting go of its slot once its client leaves or cancels it. Checked by
  `tests/agent-server.test.ts`. ([ARCHITECTURE.md](ARCHITECTURE.md#agents))
- **An agent's tools are a closed set, each taking a closed set of arguments, and act only at a stop of a run of this
  window; nothing evaluates code, and code is written only by the client (`piwi/stopCode`).** `src/run-agent.ts`
  checks each argument (`Args`); a long poll waits `MAX_FOLLOW_WAIT_S` at most. Checked by `tests/run-agent.test.ts`.
  ([ARCHITECTURE.md](ARCHITECTURE.md#agents))
- **What comes from the page reaches an agent apart from Piwi's answer, between the markers of a page-content block,
  its credentials hidden again.** The snapshot, its address and title, an element's words, the locators built from
  them, the console, the errors, the requests (their methods too) and every message a worker sends about a page call
  (`said`: Piwi's own sentence stands in its place); never in the JSON that names the runs. Checked by
  `tests/run-agent.test.ts` ("… the page’s text apart …", "says a worker’s own words …").
  ([ARCHITECTURE.md](ARCHITECTURE.md#agents))
- **What an agent does shows where a person watches.** A stop it asked for carries `RunStop.by: 'agent'`, its first
  action at a stop is a `piwi/notice`, and its code's sentences say the agent made it (`AGENT_WROTE` in
  `src/stop-actions.ts`), to the client and to Piwi Picker. Checked by `tests/run-agent.test.ts`.
- **`src/mcp-protocol.ts` is the instance's MCP server's too** (`apps/application/server/utils/mcp/protocol.ts`
  re-exports it): a change there changes what the instance answers. ([ARCHITECTURE.md](ARCHITECTURE.md#agents))
- **The discovery file is this user's alone, and a reader deletes only a dead service's file of this machine.**
  `writeDiscovery` renames a 0600 file into a 0700 folder this user owns, never a link; a reader skips a folder that is
  a link, another user's or open to others, reads only files this user owns, and deletes only a file naming this
  machine (`host`) and a process that is gone. Checked by `tests/discovery.test.ts`.
- **A run started in a terminal never waits for nobody, and its Stop stays the terminal's.** Its session (a
  `terminal-` ref the service never built, `RunSession.terminal`) holds a failure only while a Runs window follows the
  runs, and the clients offer no Stop for it. Checked by `tests/run-sessions.test.ts` ("takes a run started in a
  terminal …"). ([ARCHITECTURE.md](ARCHITECTURE.md#run-sessions))
  ([ARCHITECTURE.md](ARCHITECTURE.md#the-discovery-file))
- **Every way the service stops removes its discovery file**: `shutdown`, `exit` and the function `startServer`
  returns, and in `src/main.ts` the process's `exit`, `SIGINT`, `SIGTERM` and `SIGHUP`. Checked by
  `tests/discovery.test.ts` ("the bundled service") and `tests/run-hub.test.ts` ("goes as the service stops").
  ([ARCHITECTURE.md](ARCHITECTURE.md#the-discovery-file))

## Workflow

From `packages/editor/` (or with `-w packages/editor` from the repository root):

```bash
npm run editor:build        # the five files the clients ship, which some tests use
npm run editor:typecheck
npm run editor:lint         # :fix to fix
npm run editor:format       # :check to verify only
npm run editor:test         # the Vitest suites of tests/
```

- `tests/launcher.test.ts`, the first test of `tests/handoff.test.ts`, the stdio test of `tests/lsp.test.ts` and the
  bundled service's tests of `tests/discovery.test.ts` need `npm run editor:build` first; the first two also need
  `npx playwright install chromium` once. Each skips when what it needs is missing.
  ([ARCHITECTURE.md](ARCHITECTURE.md#tests))
- The scope for commits here and in the editor clients is `ide`.

## ARCHITECTURE.md sections

- [Overview](ARCHITECTURE.md#overview): the terms used here, and
  [what each source file holds](ARCHITECTURE.md#source-files).
- [Protocol](ARCHITECTURE.md#protocol): before adding or changing a request, a notification, a field or a command id.
- [Runs and failures](ARCHITECTURE.md#runs-and-failures): the latest run and the baseline, failure diagnostics, the file
  summary, test items, run streams, runs in progress and the editor's own run.
- [Breakpoints and picked locators](ARCHITECTURE.md#breakpoints-and-picked-locators): `PIWI_PAUSE_AT`, the reporter
  version check, `piwi/applyPick`.
- [Run control](ARCHITECTURE.md#run-control): the run sessions, `piwi/runControl` and the paused page, the stops no
  pause bar shows, the hub Piwi Picker connects to, a stopped page's live view, the code from a stop, the agents' MCP
  server and its tools, the desktop app's server as another host, and the discovery file.
- [Coverage](ARCHITECTURE.md#coverage): coverage marks and uncovered changes.
- [Analysis and completion](ARCHITECTURE.md#analysis-and-completion): the diagnostics and their quick fixes, and where
  completion offers locator chains.
- [Contexts and the instance client](ARCHITECTURE.md#contexts-and-the-instance-client) and
  [Desktop jobs](ARCHITECTURE.md#desktop-jobs): before changing how the service reads an instance or the desktop app.
- [Recorder](ARCHITECTURE.md#recorder): recording from the editor and from a paused test.
- [Build output](ARCHITECTURE.md#build-output): the five files of `dist/` and where each client ships them.
- [Commands](ARCHITECTURE.md#commands), [Reads and caching](ARCHITECTURE.md#reads-and-caching) and
  [Connection](ARCHITECTURE.md#connection): the detail behind the rules above.
- [Tests](ARCHITECTURE.md#tests): what the suites drive, and which ones need the build.
