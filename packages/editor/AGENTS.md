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
  This covers every request, field and command id (`PiwiCommand.command`) of `src/protocol.ts`, which VS Code imports
  and the JetBrains plugin mirrors in `Protocol.kt`. ([ARCHITECTURE.md](ARCHITECTURE.md#clients-and-versions))
- **The instance, the project's reporter and the desktop app may be older than the service: keep reading them.** Each
  is installed on its own, so a route or a field an older one lacks has a fallback, and the variables a test run passes
  the reporter (`PIWI_ORIGIN`, `PIWI_ORIGIN_REF`, `PIWI_PAUSE_AT`, `PIWI_RECORD_CHANNEL`, `PIWI_COVERAGE_SERVER`,
  `PIWI_COVERAGE_BROWSER`) keep their names and formats. ([ARCHITECTURE.md](ARCHITECTURE.md#clients-and-versions))
- **A change is pushed only when it differs from what the client holds.** `piwi/statusChanged`, `piwi/runStatusChanged`,
  `piwi/failuresChanged` and `piwi/coverageChanged` compare with the last answer sent or answered, so a client never
  reads an answer again on a push. Checked by `tests/lsp.test.ts` ("a change pushed to the client").
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
  `BRANCH`, `BLOB` in `src/workspace.ts`). Checked by `tests/lsp.test.ts` ("a file is read at a commit by its object
  name only") and `tests/workspace.test.ts` ("where a branch left the default branch").

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
- **An instance receives file paths and branch names from the workspace, never a file's content.** A request names a
  spec, a test file or an application file by its path, and the checked-out branch.
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
  directory (a named pipe on Windows), and a paused test attaches only with the channel's token
  (`src/recorder/handoff.ts`). Checked by `tests/handoff.test.ts`.
  ([ARCHITECTURE.md](ARCHITECTURE.md#recording-from-a-paused-test))
- **A recorder change in `apps/extension` changes what the editor clients ship.** `build.mjs` imports `buildIdeBundle`
  from `apps/extension/scripts/build.mjs` to write `record-ide.js` and its messages, so the build needs the extension's
  sources. ([ARCHITECTURE.md](ARCHITECTURE.md#build-output))

## Workflow

From `packages/editor/` (or with `-w packages/editor` from the repository root):

```bash
npm run editor:build        # the five files the clients ship, which some tests use
npm run editor:typecheck
npm run editor:lint         # :fix to fix
npm run editor:format       # :check to verify only
npm run editor:test         # the Vitest suites of tests/
```

- `tests/launcher.test.ts`, the first test of `tests/handoff.test.ts` and the stdio test of `tests/lsp.test.ts` need
  `npm run editor:build` first; the first two also need `npx playwright install chromium` once. Each skips when what it
  needs is missing. ([ARCHITECTURE.md](ARCHITECTURE.md#tests))
- The scope for commits here and in the editor clients is `ide`.

## ARCHITECTURE.md sections

- [Overview](ARCHITECTURE.md#overview): the terms used here, and
  [what each source file holds](ARCHITECTURE.md#source-files).
- [Protocol](ARCHITECTURE.md#protocol): before adding or changing a request, a notification, a field or a command id.
- [Runs and failures](ARCHITECTURE.md#runs-and-failures): the latest run and the baseline, failure diagnostics, the file
  summary, test items, run streams, runs in progress and the editor's own run.
- [Breakpoints and picked locators](ARCHITECTURE.md#breakpoints-and-picked-locators): `PIWI_PAUSE_AT`, the reporter
  version check, `piwi/applyPick`.
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
