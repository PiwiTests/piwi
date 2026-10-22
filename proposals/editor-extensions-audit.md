# The editor extensions: a UX and feature audit

**Status.** Audit, proposed 2026-10-21. Being built: every quick win (Q1 to Q14), M1 to M4 and M12 are built, and
so are the coverage marks of appendix A, 21 and 22. Remaining: M5 to M11 and every L item.
It covers the IDE plug-in as this repository names it: the **editor extensions**, that is the VS Code extension (`apps/vscode`, published as `piwitests.piwi`),
the JetBrains plugin (`apps/jetbrains`, `dev.piwitests.piwi`) and the **editor service** they both run
(`packages/editor`, the language server). The plan in [section 10](#10-a-prioritized-plan) ranks what to build; the
items that are already planned elsewhere point to their proposal rather than restating it.

**Scope.** What a developer gets from the extensions day to day, along five axes the audit was asked for:
usefulness, connectivity, efficiency, integration and performance. The dashboard's **Open in IDE** and the MCP
server are covered where the extensions meet them. The recorder's code generator and the instance's analysis are
out of scope: the extensions render them, they do not decide them.

**Summary.** The extensions are further along than their adoption shows: one service, two thin clients, pushed
changes rather than polling, failures that follow edits, local runs laid over CI, breakpoints that open the picker,
a recorder that needs no instance. The gaps are of two kinds. **Plumbing a developer hits early**: no proxy or
certificate support in the service, a branch switch that takes up to five minutes to show, CI failures published as
errors with no way to tone them down, a dashboard that cannot open a file in VS Code without a hand-typed workspace
root. **Reach a developer expects from a test tool**: no way to run the test at the cursor with Piwi, no keyboard
shortcuts, no onboarding, no release notes on either marketplace. The plan starts with the plumbing, because every
later feature is judged through it.

Every finding carries a file reference. Findings marked **(measured)** come from running the code in this
audit's session (the bundles built, the service started against a fixture and against this monorepo, the unit
suites run); the numbers are in [appendix C](#appendix-c-measurements). The Visual Studio Marketplace listing showed
a single install and the repository holds no issue about the editors at the time of the audit, so the findings come
from reading and running the code, not from user reports.

---

## 0. The ten findings that matter most

1. **The editor service cannot reach an instance through a proxy, nor one with a private certificate.** It calls
   the instance with Node's global `fetch` (`packages/editor/src/piwi-client.ts:328`, `:368`), which reads neither
   VS Code's `http.proxy` nor the IDE's proxy settings, nor the `HTTPS_PROXY` variables (Node's `fetch` ignores
   them unless `NODE_USE_ENV_PROXY` is set, an option Node added in version 24; VS Code's bundled Node is 22).
   **Connect** succeeds, because it runs in the
   extension host (`apps/vscode/src/connect.ts:49`) or through Java's `HttpClient` (`PiwiConnect.kt`), both of which
   honor the editor's proxy; then the status bar reads **Piwi: unreachable**. A self-hosted product meets corporate
   proxies and internal certificate authorities first. ([4.2](#42-proxies-and-certificates))

2. **A branch switch or a commit takes up to five minutes to show.** The checked-out branch is read only when the
   run is read again (`packages/editor/src/context.ts:678`), every five minutes while the event stream is connected
   (`packages/editor/src/server.ts:1321`, `STREAM_POLL_FACTOR`); `HEAD` is read only on the full refresh
   (`context.ts:504`, `REFRESH_MS`). After `git checkout`, the Problems panel keeps the other branch's failures, and
   the warnings on the locators a change breaks compare the file with the previous `HEAD`, so a change just
   committed still reads as unsaved. Nothing watches `.git`; only the desktop app's discovery file is watched
   (`server.ts:1789`). ([4.4](#44-branch-switches-and-commits))

3. **Every CI failure is an error in the Problems panel, with no setting to change it.**
   `packages/editor/src/server.ts:1051` publishes each failing test as `DiagnosticSeverity.Error`, the failures of
   another branch included (the ladder shows the default branch's run while the checked-out branch has none, with
   `on main` in the message). VS Code counts them in the status bar's problem counter, colors the file names in the
   Explorer and the tabs red, and feeds them to every tool that reads errors; a JetBrains IDE does the same in its
   error stripe. On a fresh feature branch the workspace turns red before the developer touched a file.
   ([3.3](#33-reading-a-failure))

4. **Piwi runs failing tests and reached tests, not the test at the cursor.** **Run this test** exists above a
   failing test's reason line (`server.ts:1951`) and in the failures view; a passing test's line opens the dashboard
   and nothing else. There is no command for the test under the caret, no run for the whole spec, no keybinding at
   all (`apps/vscode/package.json` contributes none). A developer who wants Piwi's run (recognized as their own,
   paused at breakpoints, laid over CI) for an ordinary test has to go through the failures view or run it outside
   Piwi. ([3.2](#32-running-tests))

5. **The dashboard opens a file in a JetBrains IDE with nothing to set up, and in VS Code only with a hand-typed
   workspace root.** The JetBrains plugin answers `GET /api/piwi/open` on the IDE's built-in server and confirms
   the open; VS Code gets a `vscode://file/<absolute path>` link that needs the per-browser root and reports nothing
   (`apps/application/app/composables/useOpenInIde.ts`). The VS Code extension already runs a loopback listener for
   Piwi Picker (`apps/vscode/src/send-listener.ts:88`) and registers no URI handler. ([6.1](#61-from-the-dashboard-to-vs-code))

6. **In a monorepo, every Playwright config reads its project on its own.** A context (one Playwright config, as
   the service tracks it) reads `branch-failures`, the flaky tests, Flake Lab, the quarantine, the selections, the
   timeout opportunities, the function catalog and the vocabulary itself (`context.ts:567` to `:608`, `:686`), and
   polls the run on its own timer; only the locator and code indexes are shared (`ResponseCache`,
   `piwi-client.ts`). This repository holds eight configs **(measured)**: eight identical requests per refresh and
   per poll when they read one project. ([5.1](#51-reads-that-every-context-repeats))

7. **A run started from the editor is polled every two seconds while the event stream would announce it.**
   `watch` in `packages/editor/src/run-watch.ts:284` asks `latest-run?origin=editor&ref=` every 2 s for up to two
   minutes (`:32`, `:33`), whatever the stream's state; Playwright's start (the `webServer`, the browsers) makes
   that 10 to 30 requests per run before the stream's `run-started` arrives with the same answer.
   ([5.2](#52-the-own-run-poll))

8. **Remote development is half supported.** The extension runs on the remote side (no `extensionKind`, so the
   service runs where the files are, which is right), but the Send to editor listener binds `127.0.0.1` on the
   remote host (`send-listener.ts:88`): Piwi Picker in the local browser cannot reach the pairing address copied to
   the clipboard, and the desktop app's discovery file is read in the remote home. `vscode.env.asExternalUri` would
   tunnel the port; nothing calls it. ([4.3](#43-remote-development))

9. **No onboarding, no keyboard, no log.** The manifest contributes no walkthrough, no keybinding, no
   `piwi.trace.server` setting and no command that opens the service's log; the JetBrains plugin has the settings
   page and the Tools menu. The first ten minutes, from install to the first failure at its line, are the least
   designed part of the product, and the one a marketplace visitor judges. ([3.1](#31-first-run-and-onboarding))

10. **Neither marketplace gets release notes.** The VSIX ships no `CHANGELOG.md` (`apps/vscode/.vscodeignore`) and
    the Gradle plugin configuration sets no `changeNotes` (`apps/jetbrains/build.gradle.kts:61`), while
    `CHANGELOG.md` carries 89 `ide` entries. Both listings show an empty changelog.
    ([9.2](#92-release-notes-on-the-marketplaces))

---

## 1. Method

- **Read in full**: the three area guides, the protocol (`packages/editor/src/protocol.ts`), the service's wiring
  (`server.ts`, `context.ts`, `run-watch.ts`, `run-stream.ts`, `piwi-client.ts`, `workspace.ts`, `commands.ts`,
  `failure-tree.ts`, `analysis.ts`, `recorder/sessions.ts`, `recorder/launcher.ts`), the VS Code client
  (`apps/vscode/src/*`, `package.json`), the JetBrains client's core (`PiwiProjectService.kt`,
  `PiwiLspServerSupportProvider.kt`, `PiwiFailuresToolWindow.kt`, `PiwiStatusBar.kt`, `PiwiCommands.kt`,
  `PiwiActions.kt`, `PiwiConnect.kt`, `PiwiConfigurable.kt`, `PiwiCodeVisionProvider.kt`, `PiwiTestAnnotator.kt`,
  `PiwiPlaywrightRunner.kt`, `plugin.xml`, `build.gradle.kts`), the seven docs pages under `features/editor*` and
  `ide-integration.md`, the two ADRs ([`suite-in-the-editor.md`](../adr/suite-in-the-editor.md),
  [`editor-local-runs.md`](../adr/editor-local-runs.md)) and the two proposals
  ([`record-from-the-ide.md`](record-from-the-ide.md), [`real-editor-checks.md`](real-editor-checks.md)), the
  dashboard's Open in IDE (`useOpenInIde.ts`, `ide-links.ts`) and the instance routes the service reads.
- **Reviewed by a second reading**: the JetBrains recording, coverage, Open in IDE and Send to editor handlers, and
  the recorder's internals (`page-candidates.ts`, `imports.ts`, `host-state.ts`, `project-options.ts`,
  `context-options.ts`); their findings are in [appendix A](#appendix-a-defects-found-with-locations).
- **Run**: `npm run vscode:build` (which builds the service), a stdio client against the built service on the
  recorder fixture and on this monorepo, the two unit suites, a diff of a 1 MB file as the service diffs an open
  application file, and `esbuild` with a metafile for the bundles' make-up.
- **Not run**: the two editors themselves (the VS Code integration suite downloads VS Code, the JetBrains build
  downloads WebStorm), the Marketplace statistics beyond the public page, and an instance under load.

---

## 2. What the extensions do today

The inventory, so that the rest reads against it. Both clients render the same answers of the service:

| Area | What exists |
|---|---|
| Failures | The latest complete run of the checked-out branch (else the default branch's, else the newest), its failures at their lines in the Problems panel, followed through edits, with the heal, the trace, the screenshot, the execution page, the fix plan, the issue and **Copy context for agent** as quick fixes; a **Failures** view grouped by file, cluster, owner or flat; **Compare with…** (a branch, a run by id, local runs only) |
| Runs | Local runs laid over CI within a second of their end, through the instance's event stream; runs started from the editor recognized as the editor's own and followed live in the status bar and the gutter; a verdict when they end; **Re-run the failing tests**; saved selections; breakpoints that pause the run in the browser with the picker |
| The lines above the code | Each test's result in the gutter, its history on hover; the tests behind each locator line and each application file, ready to run; Flake Lab, quarantine, selections and timeout advice on a test's line; coverage marks, function lenses and hovers (TypeScript, JavaScript, C#) |
| Writing tests | A recorder through the project's own Playwright, at the caret or into a new spec, with the project's page objects, checks from the browser's bar, pause and resume, one undo; locator and function completion; `piwi:` annotation and tag completion; brittle locator warnings with the stored stable alternative; the locators an unsaved change breaks, with the rewrite of every call site |
| Connection | The reporter's `PIWI_*` variables, the workspace `.env`, **Connect** with a browser sign-in and per-instance keys, the desktop app beside a team instance, retries with backoff while an instance does not answer |
| Agents and the browser | Piwi's MCP server registered with VS Code 1.101 and later, a configuration to paste elsewhere; Piwi Picker paired through a loopback endpoint; desktop jobs (reproduce, bisect, Flake Lab) from a failure |

The ADRs list what was planned beyond this and left for later: the priority 3 and 4 items of
[`suite-in-the-editor.md`](../adr/suite-in-the-editor.md#what-the-editors-can-grow-into) (gaps where they are,
handler summary, AI steps, register a function, uncovered changes, bug reports, API shapes), and parts 4 to 7 of
[`record-from-the-ide.md`](record-from-the-ide.md) (the step list, assertions in two clicks, the locator at the
caret highlighted in the browser, a signed-in start, run and verify after Stop, keyboard first, record at a
breakpoint, other ways in). This audit does not restate them; [section 10](#10-a-prioritized-plan) ranks the ones a
developer would feel first against the new findings.

---

## 3. Usefulness: the developer's day

### 3.1 First run and onboarding

- **Install to first failure has no guide.** The extension activates on a workspace with a Playwright config and
  shows **Piwi: connect** in the status bar; the **Failures** view's welcome offers **Connect**. That is all a new
  user sees. VS Code's `contributes.walkthroughs` (Connect, open a spec, run a test, record a test) is the standard
  way to carry the first ten minutes, and the JetBrains plugin has no equivalent of a first-run hint beyond the
  settings page. (`apps/vscode/package.json`, no `walkthroughs`)
- **Without an instance, the extension records and does nothing else.** By design: the index, the failures and the
  coverage come from an instance. The recorder is the one feature that works alone and the one a marketplace
  visitor can try at once; the listing and the welcome do not say so. (`apps/vscode/README.md`, the Failures view's
  welcome)
- **One welcome message describes the other editor.** The `unavailable` welcome of the Failures view says the
  service "starts with the first file of a Playwright workspace opened" (`apps/vscode/package.json:66`); that is the
  JetBrains plugin's behavior (`PiwiLspServerSupportProvider.kt:40`). In VS Code the service starts at activation.
- **The JetBrains plugin starts its service with the first supported file.** The tool window and the status bar say
  so until then (`Glue.kt:251`, `NOT_STARTED`). A limitation of the 2024.1 LSP API the guide documents; it still
  reads as "nothing happens" to a user who opens the project and the tool window first.

### 3.2 Running tests

- **No run for the test at the cursor, no run for the spec.** See finding 4. The service already knows a spec's
  cases and the line each `test(…)` call ends on (`callEndLine`, `piwi/testsForFile`): a `piwi/testAt` request and a
  command in the editor's context menu, with a keybinding, is a small addition, and the gutter hover of every test
  can carry **Run** beside **Open in dashboard**.
- **The end of a run is reliable in a JetBrains IDE and best effort in VS Code.** The plugin listens to the process
  (`PiwiCommands.kt`, `ProcessListener`); the extension sends the command to a terminal with `sendText` and learns
  the end from shell integration (VS Code 1.93 and later, and only in shells that activate it:
  `apps/vscode/src/extension.ts`, `SHELL_INTEGRATION_WAIT_MS`). Without it, "a run that never arrived goes
  unmentioned" ([editor-runs.md](../apps/docs/features/editor-runs.md)). VS Code's Task API (`vscode.tasks`,
  `ShellExecution`, `onDidEndTaskProcess`) reports the end and the exit code on every version and every shell, keeps
  the output in the terminal panel, and gives **Rerun Last Task** for free.
- **The JetBrains plugin can run in the IDE's Playwright runner** (test tree, Debug, Rerun Failed Tests, off by
  default); VS Code has no equivalent, and the ADR deferred the Test Explorer. [6.3](#63-the-playwright-extension-and-the-test-explorer)
  weighs a results-only integration.
- **The previous run's terminal is closed when the next run starts** (`extension.ts`, `runInTerminal`: an idle run
  terminal is disposed). It keeps the panel tidy and loses the previous output the moment a developer re-runs to
  compare. A short history (the last two or three) would serve both.

### 3.3 Reading a failure

- **The failing line is well served**: the reason, **Run this test**, **Screenshot** and **Trace** above it, the
  message, the call chain, the screenshot and the linked issues on hover, the heal and the fix plan as quick fixes.
  This is the strongest part of the product in the editor.
- **Errors everywhere, including for another branch's run.** See finding 3. Three severities would match what a
  developer expects: an error for a failure of a run of the checked-out branch, a warning or an information for a
  failure the ladder shows from another branch (`server.ts:1042`, the `on ${context.runBranch}` suffix is already
  computed), and a setting (`piwi.failureSeverity`: `error`, `warning`, `information`, `off`) handed in the
  credentials so both clients honor it; `off` keeps the Failures view and the gutter.
- **In a workspace with several projects, the Failures view and the status bar speak for one of them.** The items
  come from every context, but the run node, the baseline and the counts are the first context's that has a run
  (`server.ts`, `failuresResult`: `shown`), and the status bar item shows the first connected context
  (`apps/vscode/src/glue.ts`, `statusBarView`). Eight configs in this repository **(measured)** would show one run
  label over failures of several projects. One root node per context, and a status bar that follows the active
  file's context, would read true.
- **The hover on a failing line is rich; the gutter hover on a test is thin.** `Piwi: failing · title`, then
  **Open in dashboard** (`glue.ts`, `testResultHover`). The lens line above has the pass rate, the flaky score, the
  quarantine and the selections; the hover could repeat them, since the lens disappears when CodeLens is off, which
  the extension supports on purpose.

### 3.4 Writing tests

- **The recorder's start asks three things in two or three dialogs** (the start page, the page expression, the
  Playwright project when there are several), with the last answers remembered (`apps/vscode/src/recording.ts`;
  `PiwiRecordingActions.kt`, one dialog for the first two). Reasonable; a developer recording ten times a day would
  want one shortcut that reuses the last answers without asking ("Record here again").
- **After Stop, the recorded test is not run.** [`record-from-the-ide.md`](record-from-the-ide.md#part-4-what-makes-it-worth-switching-to)
  item 5 (**Run** and **Verify ×3** after Stop) is the single most useful unbuilt item of that plan: it closes the
  loop a developer runs by hand today, and the run is recognized as the editor's own.
- **Warnings on the recorded lines stay until the line is edited**, which is right; they are plain diagnostics with
  no quick fix (a brittle locator has alternatives the update carries in `RecordingStep.locators`, and nothing
  offers them). The step list of part 4 item 1 is the planned answer; a quick fix on the warning (choose another
  verified locator) is a smaller first step.
- **Completion covers `page.` and statement starts**, with the suite's chains for the pages the file's tests visit
  and the catalog's functions. It does not trigger inside `expect(` nor after a fixture name other than `page`
  (`server.ts`, `onCompletion`: `(?:this\.)?page\.`); a test with `adminPage` gets nothing, although
  `piwi/pageCandidates` knows that name.

### 3.5 Coverage and reach

- **Marks, lenses and hovers are complete for what the instance records**, and a file without coverage shows
  nothing, which keeps the editor quiet. The **Toggle the coverage marks** command appears once marks were seen;
  that is right.
- **Reach is read only; the uncovered changes mark of the ADR (priority 4) is not built**, and the dashed "changed
  since the coverage run" mark covers part of it. A gutter mark on a changed line of a file no test reaches is the
  editor-side of `piwi preflight` and needs nothing new from the instance.

### 3.6 Keyboard, discoverability, copy

- **No keybindings at all**, in either client (`package.json`, `plugin.xml`). Record here and Stop, Re-run the
  failing tests, Run the test at the cursor, Open the Failures view are the four a developer presses daily.
- **Commands are named consistently** ("Piwi: …", sentence case) and the JetBrains action names follow the
  platform's title case. Good.
- **The status bar is the control center in VS Code** (a trusted tooltip with links) and plain text in a JetBrains
  IDE (`PiwiStatusBar.kt:38`, `TextPresentation`): no icon, no colored failing state, the actions in the Tools menu.
  `MultipleTextValuesPresentation` or an `IconPresentation` with a popup would give the same reach.
- **Localization**: the recorder's panel in the browser is localized (`recorderLanguage`, five catalogs), the
  clients are English only (no `package.nls.json`, no resource bundle). Consistent with the dashboard's languages
  list only if the dashboard is English only; worth one line in the docs either way.

---

## 4. Connectivity

### 4.1 What works

- The **connection order** (the desktop app when chosen, the environment, the `.env` files, Connect, the desktop
  app) is explicit, documented and tested, and **Connect** is a model device authorization with per-instance keys.
- An **unreachable instance** is retried with backoff and told apart from a refused key; the status bar says which.
- **One event stream per instance and key**, shared by every context, with reconnection and a heartbeat; the poll
  stays as a fallback. The JetBrains Connect tries every loopback address.

### 4.2 Proxies and certificates

See finding 1. What to do, in order of cost:

1. **Hand the editor's settings to the service's process.** VS Code: read `http.proxy`, `http.proxyStrictSSL` and
   `http.proxyAuthorization`, and start the service with `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and
   `NODE_EXTRA_CA_CERTS` in `serverOptions.run.options.env` (`extension.ts:264`); JetBrains: the same from
   `HttpConfigurable` in `createCommandLine` (`PiwiLspServerSupportProvider.kt`).
2. **Make the service honor them**: an `EnvHttpProxyAgent` from `undici` set as the global dispatcher when a proxy
   variable is present (Node 20 and 22 have no other way; Node 24's `NODE_USE_ENV_PROXY` is the same thing built
   in). The bundle grows by a few hundred kilobytes.
3. **Say what failed.** `Could not reach https://…: fetch failed` hides the cause; the status tooltip should carry
   the error code (`ECONNREFUSED`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `407`) and, for a certificate error, name the
   variable to set.

### 4.3 Remote development

See finding 8. `vscode.env.asExternalUri` on the pairing URL gives Piwi Picker a local address in Remote SSH, WSL,
Dev Containers and Codespaces; `PIWI_EDITOR_SEND` for a run with breakpoints keeps the remote address, since the
reporter runs there. The docs page on the connection should say where the desktop app is looked for (the home of
the machine the extension runs on) and that `localhost` in `piwi.serverUrl` names the remote host.

### 4.4 Branch switches and commits

See finding 2. Watch `<repoRoot>/.git/HEAD` (a checkout changes it; a commit changes the ref it points to, so
watch `.git/refs/heads/<branch>` and `.git/packed-refs` too, or the cheap `git rev-parse HEAD` on each `HEAD` change)
with `fs.watchFile` as the desktop file is watched (`server.ts:1789`), then read the run again and drop the `HEAD`
texts (`context.ts`, `committedFiles`). The LSP file watcher (`workspace/didChangeWatchedFiles` on `**/.git/HEAD`)
is the alternative, with the client's own watcher; both clients would register it.

### 4.5 The key the agent receives

`piwi/mcp` hands the editor's agent the instance's MCP endpoint with `Authorization: Bearer <the editor's key>`
(`server.ts:2698`). That key carries the signed-in user's role and project access
(`apps/application/server/api/extension/connect/decision.post.ts:12`), including the write tools. The instance is
its own OAuth authorization server for MCP ([mcp.md](../apps/docs/features/mcp.md)), and VS Code's MCP client signs
in through it: handing the definition without headers would give the agent a scoped, revocable token at the cost of
one browser consent. Worth a setting (`piwi.mcpAuthorization`: `key` or `sign-in`), not a default change.

---

## 5. Efficiency: what the instance and the editor pay

### 5.1 Reads that every context repeats

See finding 6. Two changes, in the service:

- **One in-flight answer per instance, project and path** for the project-level reads (`branch-failures`,
  `flaky-tests`, `flake-lab`, `quarantine`, `selections?resolve=true`, `timeout-opportunities`, `test-functions`,
  the facets), in the `answers` map the contexts share (`startServer`, `ResponseCache`), as the indexes are shared
  today; the contexts of one project then read once per refresh and once per poll.
- **A conditional `branch-failures`.** The route recomputes the answer per request
  (`apps/application/server/utils/branch-failures.ts`, 632 lines) and the service compares it with the previous one
  by `JSON.stringify` (`context.ts:717`). An `ETag` on the route and `askKnown` in the client make the poll that
  changes nothing a 304.

### 5.2 The own-run poll

See finding 7. `lookLater` should run only while `isConnected(context)` is false (`run-watch.ts:284`, `:620`), or
at the stream's reconnection pace while it is true; the stream's `run-started` already reaches `started` with the
run's metadata.

### 5.3 Redraw bursts in VS Code

Each `piwi/failuresChanged` and each `piwi/coverageChanged` calls `filesChanged` (`extension.ts:1026`, `:1031`),
which increments `drawing` and asks `piwi/fileSummary` again for every visible file. A refresh that pushes the
coverage of five open files asks the summaries five times. One `setImmediate` debounce around `filesChanged` keeps
the behavior and removes the burst. The JetBrains client already coalesces (`PiwiProjectService.changed`,
`SummaryCache`).

### 5.4 Smaller costs

- **Every hover places every failure again** (`server.ts:2142`, a fresh `placer()` per hover, to find the failures
  whose call chain passes through the line). The last pass (`lastPass`) holds the same placements.
- **Activation waits for the service and three requests** (`extension.ts:1057`, `await lc.start()` then
  `updateStatus()`): the extension's activation time, which VS Code reports in **Running Extensions**, includes
  them. Returning the API first and updating after would make activation read as instant.
- **The VSIX is 2.1 MB, a quarter of it the recorder's message catalogs** **(measured)**:
  `record-ide-messages.json` holds five languages (533 KB, pretty-printed) and is parsed on the first recording
  (`recorder/sessions.ts:570`). Minified, and split per language, it would be a fifth of that.

---

## 6. Integration

### 6.1 From the dashboard to VS Code

See finding 5. Two steps, the first small:

1. **A URI handler** (`vscode.window.registerUriHandler`): `vscode://piwitests.piwi/open?file=<relative>&line=&column=&root=`
   resolves the run's path under the workspace's Playwright config folders as `resolveReportedFile` does for
   failures (`packages/editor/src/workspace.ts`), opens it and focuses the window; the dashboard gains a method
   **VS Code (Piwi extension)** that needs no workspace root (`ide-links.ts`, `useOpenInIde.ts`,
   [ide-integration.md](../apps/docs/features/ide-integration.md)).
2. **An `/piwi/open` route on the loopback listener** the extension already runs for Piwi Picker
   (`send-listener.ts`), with the origin check the JetBrains handler applies (`OpenOrigins.kt`: only a page of a
   connected instance or the desktop app) and a JSON answer, so the dashboard confirms **Opened in VS Code** and
   picks the window that holds the file, as it does with JetBrains IDEs. The dashboard needs the listener's port:
   a fixed range as for the JetBrains IDEs, or a discovery file of the extension's own (`~/.piwi/editor.json`, the
   file part 5 of [record-from-the-ide.md](record-from-the-ide.md) names for another purpose).

### 6.2 Agents

- **VS Code 1.101 and later**: the MCP server definition provider is the right integration, and the once-per-machine
  offer is measured. **Older VS Code, Cursor, VSCodium, JetBrains**: a configuration to paste that holds the key; the
  notice says to keep it out of the repository. Good.
- **A JetBrains IDE cannot register an MCP server programmatically** (the AI Assistant and Junie read their own
  settings), so the copy is the ceiling today; the notice could name the settings page of each.
- **Copy context for agent** gives one block per failure. An agent working in the editor would also want the
  **block for the whole run** (every failure, grouped by cluster, with the fix plans): one command on the Failures
  view's run node, the same text joined.

### 6.3 The Playwright extension and the Test Explorer

Microsoft's Playwright extension and Piwi both mark a test's line: Playwright's gutter icon carries the last local
result from the Test Explorer, Piwi's the latest run Piwi reads. Two icons that may disagree sit on one line. The
ADR ruled out *running* tests from the Test Explorer; a **results-only** `TestController` is a different thing: Piwi
creates the test items from the catalog, publishes the latest run's results as a `TestRun` with `TestMessage`
locations (the failing line, the reason), and offers one run profile that calls `piwi.runTests`. The Testing view,
its gutter, its filters and **Run Test at Cursor** then come from VS Code, and the duplicate icon goes. Medium
effort, VS Code only; the JetBrains side has the IDE's Playwright runner.

### 6.4 Runs in a JetBrains IDE

The IDE's Playwright runner option is a good integration (test tree, Debug, Rerun Failed Tests). It is off by
default and three levels deep in the settings; the first run from Piwi in an IDE that has the runner could offer it
once, as the MCP configuration is offered.

### 6.5 The desktop app and Piwi Picker

Both integrations are complete for what they set out to do: discovery without pairing, jobs with a verdict and a
share, a paired endpoint with a token. The remaining gaps are the remote case ([4.3](#43-remote-development)) and
the recording proposal's part 6 (Piwi Picker streaming a recording live to the editor), which is the one way to
record in the developer's own browser profile.

---

## 7. Performance

All numbers are in [appendix C](#appendix-c-measurements).

- **Startup is cheap** **(measured)**: the built service answers `initialize` in about 115 ms and `piwi/status`
  within 200 ms, at 55 MB of resident memory on the recorder fixture and 63 MB with the eight contexts of this
  monorepo. The config search (`findPlaywrightRoots`, depth 4, `workspace.ts:35`) costs nothing visible.
- **Large files are not a problem** **(measured)**: the document selector syncs every `.json`, `.yaml`, `.yml`,
  `.properties`, `.po` and `.resx` file of the workspace to the service (`glue.ts:35`), lockfiles included, and an
  edit of an open application file diffs it against `HEAD`; a 1 MB `package-lock.json` diffs in 10 to 19 ms and
  yields no anchor. Excluding `*lock*.json` and minified files from the selector is hygiene, not a fix.
- **Bundles** **(measured)**: the extension is 498 KB minified, half of it `vscode-languageclient`; the service
  879 KB, 410 KB of it the language server libraries and 162 KB `@piwitests/core`. Nothing to cut; the catalogs of
  [5.4](#54-smaller-costs) are the only outlier.
- **Redraw cadence is bounded**: the gutter follows a live run at most once a second in both clients, the status bar
  at most every 300 ms from the service; Code Vision waits 3 s at most and the annotator 5 s, both cancellable
  (`PiwiCodeVisionProvider.kt`, `PiwiTestAnnotator.kt`).
- **The JetBrains start runs `node --version` synchronously** with a 10 s timeout on the thread that starts the
  server (`PiwiLspServerSupportProvider.kt:70`): off the event thread, once per start. Fine.
- **Unit suites** **(measured)**: 86 tests in 0.7 s (VS Code), 303 in 12.8 s (service), all green.

---

## 8. Parity between the two clients

| | VS Code | JetBrains |
|---|---|---|
| Service start | At activation (workspace with a config) | With the first supported file opened |
| End of a run | Shell integration, 1.93 and later, best effort | Process listener, always |
| Run in the IDE's runner | No | Playwright runner, option |
| Status bar | Text and icon, error background, tooltip with links | Text only, actions in the Tools menu |
| Failures view | Badge, follow the active editor, inline actions | Occurrence navigation, speed search, header with the connection |
| Open in IDE from the dashboard | URL scheme with a workspace root, no confirmation | Plugin endpoint, confirmed, no setting |
| MCP | Registered (1.101+), else copy | Copy |
| Recording controls | CodeLens above the block, status bar | Banner, gutter mark, status bar |
| Settings | Settings UI (four settings), no "in use" summary | Settings page with the connection in use |
| Trusted project | Disabled in Restricted Mode (VS Code's default for the manifest) | Explicit: waits for trust |
| Proxy for the service | None | None |
| Keybindings | None | None |

The parity is good where it matters (what is shown, the protocol, the connection). The differences that cost a
developer are the end of a run and the status bar's reach, both in [section 10](#10-a-prioritized-plan).

---

## 9. Quality: tests, release, support

### 9.1 Tests

The service carries the behavior (303 tests, a stub instance, the launcher with a real Chromium), the VS Code
client has unit tests of its pure half and an integration suite in a real VS Code on pull requests, the JetBrains
client platform tests on 2024.1 and the Plugin Verifier on the latest IDEs. What no suite checks is what the editors
draw ([`real-editor-checks.md`](real-editor-checks.md), D1 to D3): a nightly Playwright suite over the VS Code
screenshot launcher is within reach and would have caught a copy error such as the welcome text of
[3.1](#31-first-run-and-onboarding).

### 9.2 Release notes on the marketplaces

See finding 10. `scripts/release-notes.mjs` already filters and de-duplicates the entries; writing the `ide` entries
of each release to `apps/vscode/CHANGELOG.md` (shipped in the VSIX) and to `changeNotes` of the Gradle
configuration at publish time (`reusable-publish-vscode.yml`, `reusable-publish-jetbrains.yml`) gives both
listings a changelog, and the JetBrains listing its "What's new".

### 9.3 Support

- **No trace setting.** `vscode-languageclient` reads `piwi.trace.server` when it is declared; it is not
  (`package.json`). A user who reports "nothing shows" has no way to capture the traffic short of editing JSON.
- **No log command.** The service logs to the client's output channel; **Piwi: Open the log** (VS Code) and a link
  in the tool window's header (JetBrains, the IDE's log holds the service's errors) would shorten every support
  thread.
- **No `bugs` field in the manifest**, so the Marketplace listing has no **Report an issue** link, and `qna` is left
  to the Marketplace's own forum rather than the repository's issues.

---

## 10. A prioritized plan

Effort is a rough size: **S** a day or less, **M** days, **L** a week or more. Each item names the axis it serves and
the files it touches.

### Quick wins (S)

| # | Item | Axis | Where |
|---|---|---|---|
| Q1 | Watch `.git/HEAD` and the refs; on a change, read the run again and drop the `HEAD` texts | connectivity | `packages/editor/src/server.ts`, `context.ts`, `workspace.ts` |
| Q2 | Poll the editor's own run only while the stream is disconnected | efficiency | `packages/editor/src/run-watch.ts` |
| Q3 | Share the project-level reads across the contexts of one project | efficiency | `packages/editor/src/context.ts`, `piwi-client.ts` |
| Q4 | Debounce `filesChanged` | efficiency | `apps/vscode/src/extension.ts` |
| Q5 | `piwi.failureSeverity`, and an information for a failure the ladder shows from another branch | usefulness | `packages/editor/src/server.ts`, `protocol.ts`, both clients' settings |
| Q6 | Hand the editor's proxy and certificate settings to the service's environment, and name the error code in the status | connectivity | `apps/vscode/src/extension.ts`, `PiwiLspServerSupportProvider.kt`, `piwi-client.ts` |
| Q7 | **Run the test at the cursor** and **Run this spec**, in the context menu and the gutter hover, with `piwi/testAt` | usefulness | `server.ts`, `protocol.ts`, `extension.ts`, `PiwiActions.kt` |
| Q8 | Default keybindings: record here and stop, re-run failing, run at cursor, open the Failures view | usefulness | `apps/vscode/package.json`, `plugin.xml` |
| Q9 | Release notes to both marketplaces at publish time | integration | `reusable-publish-*.yml`, `build.gradle.kts`, `.vscodeignore` |
| Q10 | `piwi.trace.server`, **Piwi: Open the log**, `bugs` and `qna` in the manifest, the `unavailable` welcome copy, `untrustedWorkspaces` declared | support | `apps/vscode/package.json`, `extension.ts` |
| Q11 | The JetBrains send and open handlers off the built-in server's thread, with the right notices (appendix A, 13 to 17) | usefulness | `PiwiSendHandler.kt`, `PiwiOpenHandler.kt` |
| Q12 | **Record here** only under a Playwright config folder; the spec dialog's messages; a word when a pending recording is cancelled (appendix A, 18 to 20) | usefulness | `RecordHereIntention.kt`, `PiwiRecordingActions.kt` |
| Q13 | CommonJS specs: bind the names `require` destructures and write a `require` line; import `expect` from the fixtures module only when a sibling spec does (appendix A, 23, 24) | usefulness | `packages/editor/src/recorder/imports.ts`, `sessions.ts` |
| Q14 | A `*Page` fixture offered after `page`, a notice when a tab opens during a recording, no block inside an open parenthesis (appendix A, 25, 26, 30) | usefulness | `recorder/page-candidates.ts`, `launcher.ts` |

### Medium (M)

| # | Item | Axis | Where |
|---|---|---|---|
| M1 | A URI handler and an `/piwi/open` route in VS Code; the **VS Code (Piwi extension)** method in the dashboard | integration | `apps/vscode/src/send-listener.ts`, `extension.ts`, `apps/application/app/composables/useOpenInIde.ts`, `ide-links.ts`, docs |
| M2 | Run through the Task API in VS Code: a reliable end and exit code, the output kept, rerun | usefulness | `apps/vscode/src/extension.ts` |
| M3 | Remote development: `asExternalUri` for the pairing address; the docs on where the desktop app is looked for | connectivity | `extension.ts`, `editor-connection.md`, `editor-recording.md` |
| M4 | A proxy agent in the service (`undici` `EnvHttpProxyAgent`) for Node 20 and 22 | connectivity | `packages/editor/src/piwi-client.ts`, `run-stream.ts`, `build.mjs` |
| M5 | A conditional `branch-failures` (an `ETag` on the route, `askKnown` in the client) | efficiency | `apps/application/server/utils/branch-failures.ts`, `piwi-client.ts` |
| M6 | One root node per context in the Failures view; the status bar follows the active file's context | usefulness | `packages/editor/src/failure-tree.ts`, `server.ts`, both clients |
| M7 | A JetBrains status bar with an icon, a failing color and a popup of the actions | usefulness | `PiwiStatusBar.kt` |
| M8 | A walkthrough in VS Code; a first-run notification in a JetBrains IDE | usefulness | `apps/vscode/package.json`, `PiwiStartupActivity` |
| M9 | After Stop: **Run it** and **Verify ×3**, the run recognized as the editor's own ([record-from-the-ide.md](record-from-the-ide.md), part 4, item 5) | usefulness | `recording.ts`, `PiwiRecording.kt`, `server.ts` |
| M10 | A quick fix on a recorded line's warning that offers the other verified locators | usefulness | `server.ts`, `recorder/sessions.ts` |
| M11 | Completion after any page expression `piwi/pageCandidates` knows, and inside `expect(` | usefulness | `server.ts` |
| M12 | The project options cached by the `.env*` files and the config's imports too, expiring after a few minutes, and read with the project's Node; one tokenization per update (appendix A, 27 to 29) | usefulness | `recorder/project-options.ts`, `sessions.ts`, `imports.ts` |

### Larger (L)

| # | Item | Axis | Where |
|---|---|---|---|
| L1 | A results-only Test Explorer integration in VS Code ([6.3](#63-the-playwright-extension-and-the-test-explorer)) | integration | `apps/vscode/src` |
| L2 | The uncovered changes gutter mark (ADR priority 4) | usefulness | `server.ts`, `coverage.ts`, both clients |
| L3 | Record at a breakpoint or at `page.pause()` ([record-from-the-ide.md](record-from-the-ide.md), part 5) | usefulness | the reporter's capture fixtures, the service, both clients |
| L4 | A nightly check in the real VS Code ([real-editor-checks.md](real-editor-checks.md), D3) | quality | `apps/vscode/tests` |
| L5 | A scoped token for the agent: the MCP definition without the key, signed in through the instance's OAuth | connectivity | `server.ts`, `extension.ts`, docs |

The order inside each tier is the order to build. Q1 to Q6 remove the reasons a developer would uninstall in the
first week; Q7 and Q8 are what they would ask for in the second.

---

## Appendix A: Defects found (with locations)

Each line: where, what, why it matters. Those marked **(second reading)** were found by the review of the files the
audit did not read in full, and checked at the cited line.

1. `apps/vscode/package.json:66`. The `unavailable` welcome of the Failures view says the service starts with the
   first file opened; in VS Code it starts at activation. A user reads a wrong instruction at the one moment they
   need a right one.
2. `packages/editor/src/server.ts:1051`. A failure the ladder shows from another branch (the message ends with
   `on <branch>`) is an error like one of the checked-out branch. See finding 3.
3. `packages/editor/src/run-watch.ts:284`. The own-run poll runs while the stream is connected. See finding 7.
4. `packages/editor/src/context.ts:678`, `:504`. The branch and `HEAD` are read on the poll and the refresh only.
   See finding 2.
5. `packages/editor/src/piwi-client.ts:328`. Node's `fetch` without a proxy agent or the editor's certificates. See
   finding 1.
6. `packages/editor/src/server.ts:2142`. A new `placer()` per hover places every failure of every context again.
7. `apps/vscode/src/extension.ts:1026`, `:1031`. `filesChanged` per push, with no debounce.
8. `apps/vscode/src/send-listener.ts:88`. The listener binds the remote host's loopback in remote development, and
   the pairing address copied is that host's.
9. `packages/editor/src/server.ts`, `onCompletion`. Locator completion triggers only after `page.` or `this.page.`,
   not after another page expression of the test (`adminPage.`), although `piwi/pageCandidates` lists it.
10. `apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/PiwiStatusBar.kt:38`. Text-only presentation: no icon,
    no failing color.
11. `apps/jetbrains/build.gradle.kts:61`, `apps/vscode/.vscodeignore`. No change notes, no changelog shipped.
12. `apps/vscode/package.json`. No `keybindings`, no `walkthroughs`, no `bugs`, no `qna`, no `trace.server`
    setting, no `untrustedWorkspaces` declaration.

13. `apps/jetbrains/.../PiwiSendHandler.kt:212` **(second reading)**. A locator or a flow sent from Piwi Picker while
    no editor is selected is answered with a 422 to the browser extension, and the IDE shows nothing; VS Code opens
    an untitled editor and inserts there (`apps/vscode/src/extension.ts`, `insertFromPicker`).
14. `PiwiSendHandler.kt:111` to `:127` **(second reading)**. A pick at a line while the service is not running says
    "<file> is not in this project" (the `applyPick` answer is null for another reason), and a failure of
    `replaceOnLine` (a read-only file, a document that does not load) reads as "holds no locator anymore" and inserts
    the locator at the caret of whichever editor has focus.
15. `PiwiSendHandler.kt:117`, `:189` **(second reading)**. `replaceOnLine` runs on the event thread with a synchronous
    VFS refresh and a document load; a slow disk freezes the IDE for the pick, against the plugin's own rule.
16. `PiwiSendHandler.kt:77` **(second reading)**. The first request after a start reads the password safe on the
    built-in server's I/O thread, which serves every other local request of the IDE.
17. `PiwiOpenHandler.kt:60` to `:108` **(second reading)**. `isHostTrusted` reads every open project's `.env` files
    on that same I/O thread, and the dashboard sends a check request before the open, so one click reads them twice
    there and again in `execute`.
18. `PiwiRecordingActions.kt:331` **(second reading)**. A tab closed while `piwi/record` is pending (up to 90 s, the
    config's options are read through Playwright) stops the session silently: the browser closes with no word.
19. `PiwiRecordingActions.kt:170` **(second reading)**. The new spec dialog disables OK for a name that exists with
    no message (`InputValidator`, not `InputValidatorEx`); VS Code says "This file exists already."
20. `RecordHereIntention.kt:22`, `PiwiRecordingActions.kt:161` **(second reading)**. **Record here** is offered in
    every script file of a project that has a Playwright config, `vite.config.ts` and the application's sources
    included, where a new test would be written.
21. `PiwiCoverageMarks.kt:120` to `:141` **(second reading, plausible)**. Each `piwi/coverageChanged` push disposes
    and re-creates every highlighter of the file on the event thread; a large file with thousands of spans pays it
    on each edit the service answers.
22. `PiwiCoverageMarks.kt:73` to `:103` **(second reading, plausible)**. A renamed or moved open file keeps the marks
    computed for its old path and is not asked again until it is closed and reopened.

23. `packages/editor/src/recorder/imports.ts:24`, `:165` **(second reading)**. A CommonJS spec
    (`const { test, expect } = require('@playwright/test')`, the official JavaScript template) binds no name the
    service sees, so the first check inserts `import { expect } from '@playwright/test';` at the top: the spec no
    longer loads.
24. `packages/editor/src/recorder/sessions.ts:332`, `recorder/page-candidates.ts:1141` **(second reading)**.
    `expect` is imported from the module `test` comes from; a fixtures module that exports `test` without `expect`
    (`export const test = base.extend({…})`) gets an import that does not compile.
25. `recorder/page-candidates.ts:721`, `:1046` **(second reading)**. A fixture whose name ends in `Page` (`todoPage`,
    the usual page-object naming) counts as a page: in a test that takes only such fixtures the default is `todoPage`
    and `page` is not offered; accepting it writes `await todoPage.getByRole(…)`.
26. `recorder/page-candidates.ts:905`, `:944` **(second reading, plausible)**. With the caret at the end of a line
    inside an open parenthesis (a multi-line `expect(`), the block goes on the next line, inside the parentheses,
    and every update rewrites it there.
27. `recorder/project-options.ts:149` to `:174` **(second reading)**. The config's project options are cached by
    the config file's modification time alone: a change to `.env`, to an imported base config or to the environment
    leaves `baseURL`, `storageState` and `testIdAttribute` stale until the config is saved or the service restarts.
28. `recorder/project-options.ts:103`, `recorder/sessions.ts:79` **(second reading, plausible)**. The config is read
    and the browser launched with `process.execPath`: in VS Code that is the editor's Electron binary running as
    Node, not the project's Node; the JetBrains plugin uses the project's interpreter. A config that needs the
    project's Node, or a native module built for it, works in one editor and fails in the other.
29. `recorder/sessions.ts:691` **(second reading)**. Each update tokenizes the file three times (`testImportOf`,
    `importedNames`, `importStatementEnds`) on top of rendering every step again; a long recording into a long spec
    lags further as it goes. Not per keystroke: the service renders at most every 100 ms.
30. `recorder/launcher.ts:77` **(second reading)**. A tab or a popup the application opens is not recorded, by
    design, and the editor says nothing: the step count stays while the developer clicks on in it.

## Appendix B: What the docs promise versus what the code does

| Docs | Code | Note |
|---|---|---|
| [editor-runs.md](../apps/docs/features/editor-runs.md): "VS Code learns a command ended through shell integration (1.93 and later) … a run that never arrived goes unmentioned" | `extension.ts`, `runInTerminal` | Documented limitation; the Task API removes it ([3.2](#32-running-tests)) |
| [editors.md](../apps/docs/features/editors.md): "the extension provides Piwi's MCP server to the editor's agent with the connection it already has" | `server.ts:2698` | True; the connection is the user's full key ([4.5](#45-the-key-the-agent-receives)) |
| [editor-connection.md](../apps/docs/features/editor-connection.md): the connection order and the unreachable retry | `context.ts`, `server.ts` | Matches; proxies and remote development are not mentioned ([4.2](#42-proxies-and-certificates), [4.3](#43-remote-development)) |
| [editor-coverage.md](../apps/docs/features/editor-coverage.md): "Typing asks nothing: the marks are placed on your edits locally" | `server.ts`, `coverageAgain` | Matches |
| [editor-recording.md](../apps/docs/features/editor-recording.md): "A file takes one recording at a time" | `recording.ts`, `PiwiRecordingActions.kt` | Matches |
| The Failures view welcome (`package.json:66`) | `extension.ts`, `activate` | Wrong for VS Code (appendix A, 1) |
| [ide-integration.md](../apps/docs/features/ide-integration.md): "No other method can confirm the file opened" (than the JetBrains plugin) | `useOpenInIde.ts` | True today; M1 changes it |

## Appendix C: Measurements

Taken on 2026-10-21 in this audit's container (Linux, Node 22), on the built bundles of version 0.58.0.

| What | Value |
|---|---|
| `initialize` answered, recorder fixture | 117 ms |
| `piwi/status` answered, recorder fixture (1 context) | 164 ms, 55 MB resident |
| `piwi/status` answered, this monorepo (8 contexts) | 192 ms, 63 MB resident |
| `extension.cjs` (minified) | 498 KB, of which `vscode-languageclient` and its protocol libraries about half |
| `piwi-language-server.cjs` | 879 KB: `vscode-languageserver` and its libraries 410 KB, `@piwitests/core` 162 KB, `server.ts` 86 KB |
| `record-ide.js` / `record-ide-messages.json` | 213 KB / 533 KB |
| VSIX contents (`dist/`) | 2.1 MB |
| `diffLines` on a 1 MB, 30,383-line `package-lock.json` with one inserted line | 10 to 19 ms, 0 anchors |
| `npm run vscode:test` | 86 tests, 0.7 s |
| `npm run editor:test` | 303 tests, 12.8 s (the launcher test runs a real Chromium) |
| Visual Studio Marketplace listing (public page) | version 0.58.0, 1 install, no rating |
| GitHub issues mentioning the editors | none (one open issue in the repository, unrelated) |
