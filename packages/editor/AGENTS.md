# Editor service: agent guide

Rules for working inside `packages/editor/` (`@piwitests/editor`, the Piwi language server). The VS Code extension and
the JetBrains plugin both ship this service and start it over stdio, so every editor answer comes from here. Read
[`../../AGENTS.md`](../../AGENTS.md) first for repo-wide conventions, then the section of
[`ARCHITECTURE.md`](ARCHITECTURE.md) that covers the area you change.

## Rules

### Logic and protocol

- **All editor logic lives in this service; the clients only render its answers.** Both editors then give the same
  answers. Put new pure logic in `src/analysis.ts`, or in `@piwitests/core` when the CLI or the dashboard needs it too.
- **Never re-implement a core function.** Import it from `@piwitests/core`.
- **The protocol is a contract: a change to `src/protocol.ts` lands with both clients in the same change.** A client of
  an older version talks to this server, and a published client's commands (`piwi.openInDashboard`, `piwi.runTests`,
  `piwi.openTrace`, `piwi.openScreenshot`) are named in `SummaryLine.command`, so a renamed request or command is a
  breaking change. (ARCHITECTURE.md, "Requests and notifications")
- **A change is pushed only when it differs from what the client holds.** `piwi/statusChanged`, `piwi/runStatusChanged`,
  `piwi/failuresChanged` and `piwi/coverageChanged` compare with the last answer sent or answered, so a client never
  reads an answer again on a push. Checked by `tests/lsp.test.ts` ("a change pushed to the client"). (ARCHITECTURE.md,
  "Pushed changes")
- **Completion scans the file only after a member chain and `.`, or after `expect(`.** `(` is a trigger character, and
  completion after any other `(` is empty (`locatorCompletionSite`). (ARCHITECTURE.md, "Analysis and completion")

### Commands

- **Commands are built by the service, never taken from the instance.** `src/commands.ts` checks each argument (a test
  filter, or an option of `PLAYWRIGHT_OPTIONS`, none of which loads or writes a file) and quotes it (`shellWord`); any
  other argument refuses the whole command, and the clients run only what the service built. Checked by
  `tests/commands.test.ts`. (ARCHITECTURE.md, "How a command is built")
- **A command runs in the config's folder as the file system spells it** (`commandFolder`, `canonicalPath`). Every `cwd`
  handed to a client uses it, never the folder as the editor spelled it (on Windows, possibly with a lower-case drive
  letter). Checked by `tests/lsp.test.ts` ("the folder a command runs in").

### Reads and caching

- **Nothing blocks typing.** Requests answer from what the refresh timer, `piwi/refresh` and `piwi/setCredentials`
  fetched. Data for one file or one failure is fetched once, when first needed, and a quick fix or a hover waits for it
  1.5 s at most (`within`, `LOOKUP_WAIT_MS`). (ARCHITECTURE.md, "Background reads")
- **Refreshes never overlap.** A refresh asked for while another runs follows it (`refreshAll`).
- **What an index gives every request is computed once per index** (`callSitesOf`, `stabilityOf` in `src/analysis.ts`).
- **A canceled quick fix or hover is not answered further.**
- **The failures come first on a refresh** (`PiwiContext.refresh`). The project and its locator index, then the latest
  run, published at once (`onRun`), and only then the other indexes, each keeping what it held when its read fails.
  (ARCHITECTURE.md, "Refresh order")
- **What the instance says did not change is not read again.** Indexes and answers with an `ETag` are asked with
  `If-None-Match`. The contexts of one service share answers (`ResponseCache`, `SHARED_MS`), each getting its own copy
  (`structuredClone`), so nothing keyed by a failure's identity crosses contexts. Checked by `tests/lsp.test.ts` ("a
  latest run the instance says did not change"). (ARCHITECTURE.md, "Response cache")
- **A failure shows once, from the config its spec belongs to** (`placedElsewhere`). A context places a failure only
  when its config folder holds the spec, or when no config folder does. Checked by `tests/lsp.test.ts` ("the configs of
  one repository reading one project"). (ARCHITECTURE.md, "Failures placed by one context")
- **Stored files go to disk as they arrive, in an owner-only folder.** A trace or a screenshot is written to
  `EVIDENCE_ROOT`, never held in memory (`PiwiClient.download`); the folder is created owner-only and never written to
  when another user owns it or it is a link (`privateFolder`). Checked by `tests/context.test.ts` ("the folder files are
  downloaded to"). (ARCHITECTURE.md, "Evidence files")

### Instance and connection

- **`src/piwi-client.ts` is the only file that talks to an instance.** Its requests go through `src/http.ts`, which
  follows `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (`tests/http.test.ts`). (ARCHITECTURE.md, "Instance client and
  proxy")
- **Nothing from the workspace is sent to the instance but file paths it already stores.**
- **The API key never leaves the process except in `X-API-Key` and in the MCP server definition.** `piwi/mcp` includes
  it only while the credentials' `mcpAuthorization` is `key`; with `sign-in`, the agent signs in through the instance's
  OAuth. Checked by `tests/lsp.test.ts` ("Piwi’s MCP server for the agent"). (ARCHITECTURE.md, "API key and MCP server")
- **The connection order is fixed** (`resolveContextConnection`). The desktop app when the editor chose it, then the
  named instance (`namedInstance`: the environment, the workspace `.env`, the editor's settings), then the desktop app's
  discovery file; the reporter keeps its own order. Checked by `tests/context.test.ts`. (ARCHITECTURE.md, "Connection
  order and watching `HEAD`")
- **The desktop app sits beside a shared instance, never replaces it.** `piwi/status` keeps the named instance
  (`instance`) and says whether the app runs (`desktopUrl`), so Connect offers both.
- **A context that changes instance forgets everything read from the other one.**
- **A desktop job names commits, tests and lab conditions, never code.** The app runs it only after a click in its
  window (`src/desktop-jobs.ts`). (ARCHITECTURE.md, "Desktop jobs")

### Recorder

- **The recorder never bundles Playwright.** The launcher resolves the project's own Playwright at run time
  (`src/recorder/playwright.ts`) and runs with the project's Node (`src/recorder/node.ts`). (ARCHITECTURE.md, "Project
  options, Node and the launcher")
- **Only the main frame of the page a recording opened first records.** Every other frame and page (a popup, a
  cross-origin iframe) is answered as outside a recording (`src/recorder/host-state.ts`).
- **The record channel is private to this user.** Its Unix socket lives in a new owner-only folder of the temporary
  directory (a named pipe on Windows), and a paused test attaches only with the channel's token
  (`src/recorder/handoff.ts`). Checked by `tests/handoff.test.ts`. (ARCHITECTURE.md, "Recording from a paused test")
- **A recorder change in `apps/extension` changes what the editor clients ship.** `build.mjs` imports `buildIdeBundle`
  from `apps/extension/scripts/build.mjs` to write `record-ide.js` and its messages, so the build needs the extension's
  sources. (ARCHITECTURE.md, "Build output")

## Workflow

```bash
npm run editor:build        # the five files the clients ship (the stdio and launcher tests use them)
npm run editor:typecheck
npm run editor:lint         # :fix to fix
npm run editor:format       # :check to verify only
npm run editor:test         # an in-process JSON-RPC client against a fixture repository and a stub instance
```

- `tests/launcher.test.ts` needs `npm run editor:build` first (and `npx playwright install chromium` once); it skips,
  saying why, when either is missing. (ARCHITECTURE.md, "Tests")
- The scope for commits here and in the editor clients is `ide`.

## Source map

- `src/main.ts`: the bundle's entry point; it serves over stdio or the transport the client names.
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

## ARCHITECTURE.md sections

- [Protocol](ARCHITECTURE.md#protocol): before adding or changing a request, a notification or a field.
- [Runs and failures](ARCHITECTURE.md#runs-and-failures): the latest run and the baseline, failure diagnostics, the file
  summary, test items, run streams, runs in progress and the editor's own run.
- [Breakpoints and picked locators](ARCHITECTURE.md#breakpoints-and-picked-locators): `PIWI_PAUSE_AT`, the reporter
  version check, `piwi/applyPick`.
- [Coverage](ARCHITECTURE.md#coverage): coverage marks and uncovered changes.
- [Analysis and completion](ARCHITECTURE.md#analysis-and-completion): what `src/analysis.ts` computes, where completion
  offers locator chains.
- [Contexts and the instance client](ARCHITECTURE.md#contexts-and-the-instance-client) and
  [Desktop jobs](ARCHITECTURE.md#desktop-jobs): before changing how the service reads an instance or the desktop app.
- [Recorder](ARCHITECTURE.md#recorder): recording from the editor and from a paused test.
- [Build output](ARCHITECTURE.md#build-output): the five files of `dist/` and where each client ships them.
- [Commands](ARCHITECTURE.md#commands), [Reads and caching](ARCHITECTURE.md#reads-and-caching) and
  [Connection](ARCHITECTURE.md#connection): the detail behind the rules above.
- [Tests](ARCHITECTURE.md#tests): what the launcher test runs.
