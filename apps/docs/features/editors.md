---
title: Editor extensions
description: "Piwi in VS Code and the JetBrains IDEs: tests recorded at the cursor, the latest CI failures at their failing lines with your local runs laid over them and the heal as a quick fix, the tests behind each locator, file and line, brittle locators, and the locators an unsaved change breaks."
lang: en-US
---

# Editor extensions

<Needs editor />

The Piwi extension for VS Code (and Cursor, VSCodium) and the Piwi plugin for the JetBrains IDEs with the LSP API
(WebStorm, IntelliJ IDEA Ultimate, Rider, from 2024.1) bring what the dashboard knows about your suite to the line you
are editing. Both run the same editor service; the [JetBrains plugin](./jetbrains) page lists what the plugin needs
and draws differently.

<figure>
  <img src="/screenshots/vscode-heal.png" alt="VS Code: a CI failure at its line, the heal offered as a quick fix">
  <figcaption>The latest run's failure at its line, and the heal as a quick fix.</figcaption>
</figure>

## Install and connect

**You need a Piwi instance:** the [desktop app](/features/desktop), `npx @piwitests/server` or the Docker image.
Recording, running a test by its line, and pausing and stepping through it need none. Piwi reads Playwright Test
suites in JavaScript and TypeScript.

Install **Piwi** from the
**[Visual Studio Marketplace ↗](https://marketplace.visualstudio.com/items?itemName=PiwiTests.piwi)** (`piwitests.piwi`
in the extensions view) or the **[JetBrains Marketplace ↗](https://plugins.jetbrains.com/plugin/34674-piwi)**
(**Settings → Plugins**). It starts on a trusted workspace holding a Playwright config, and reads the connection
the reporter already uses: the `PIWI_*` variables in the environment or the workspace `.env`, or the
[desktop app](/features/desktop). Otherwise, run **Piwi: Connect…** (**Settings → Tools → Piwi** in a JetBrains IDE)
and sign in with the browser: [Editor connection](./editor-connection) has the steps.
In VS Code, the extension also opens a path clicked in the dashboard:
[Open in editor](./ide-integration#vs-code-the-piwi-extension).

Self-hosted, zero telemetry. No file of your workspace is sent to the instance: the project's
[locator index](/guide/concepts#locator-index), [code reach](/features/code-reach) and latest run are compared with
your files locally.

## CI failures in the Problems panel

The failures of the latest complete [CI run](/reference/test-metadata#run-origin) on the checked-out branch, else the
default branch, are in the Problems panel at the line that failed, with your local runs laid over them, and each
failing line follows your edits until a run covers its test again. The heal, the trace, a rerun and the fix plan are
quick fixes on the failure, and the failures view lists them as a tree: [Failures in the editor](./editor-failures).

## The tests behind each line

Lines above the code (CodeLens):

| File | What it shows | Click |
|---|---|---|
| A spec | the tests Piwi knows in it; beside each `test(…)`, its latest result in the gutter, a failing test's body tinted, and on hover that result's run, the pass rate, [flaky](/features/flaky-tests) score and root cause, quarantine and selections | runs those tests |
| A page object or spec | above each locator line (in a spec, unless its only test is the one around it), the tests using it, their actions, and how many fail or flake | runs those tests |
| An application file | the tests that reach it, from [code reach](/features/code-reach); with [coverage](./editor-coverage), each function's too | runs those tests |
| A page file (Nuxt `pages/**`) | the tests acting on that page, its locators and how many are brittle | runs those tests |

Above a flaky test: Flake Lab's **flaky N%** and [top suspect](./flake-lab#from-the-editor-and-the-failure-pages), then
**Reproduce this flake** and, once reproduced, **Verify the flake fix**, which run `piwi flake`; beside a team instance,
**Reproduce this flake in the desktop app**.

## Timeouts

A test whose `test.slow()` is no longer needed, or whose timeout is far above its p95, gets a note and a quick fix:
remove `test.slow()`, or set `test.setTimeout` to the suggested value.

## Completion

- After a page and a `.` in a spec or a page object: the locator chains your suite already uses on the pages this
  file's tests visit, most used first and brittle ones last. The page is `page`, `this.page`, or any page the code at
  the cursor can use, the same ones [a recording](/features/editor-recording#start-a-recording) offers: another page
  fixture of the test (`adminPage.`), a page object's page field (`this.root.`), a page the test opens
  (`newPage()`, a popup).
- Right after `expect(`: the same chains on the page in use there, such as
  `page.getByRole('button', { name: 'Pay' })`, so an assertion's locator is written in one step.
- At the start of a statement: the [functions](/features/test-functions) of your catalog whose URL pattern matches
  those pages, as a call with a placeholder per parameter.
- In a `piwi:` annotation: the types (`piwi:owner`, `piwi:priority`, `piwi:feature`, `piwi:link`), then the owners,
  priorities or features they take; in `tag: ['@…']`, the tags your tests already use.

## Brittle locators

A locator the [stability rules](/reference/locator-stability) rate brittle is a warning on its line; one worth a
look is a hint. When the capture fixtures stored a stable alternative for that call site on its last passing run, the
quick fix replaces the chain with it.

## The locators a change breaks

In an application file, the unsaved buffer is compared with `HEAD` as you type, as
[`piwi preflight`](/features/preflight) compares a diff. A changed line whose string a locator finds its element by is
a warning, with the chains it breaks on hover, and one quick fix that rewrites every call site.

## Piwi's MCP server for the agent

In VS Code 1.101 and later, the extension provides Piwi's [MCP server](/features/mcp) to the editor's agent with the
connection it already has. Elsewhere, **Piwi: Copy the MCP server configuration** puts an entry on the clipboard: VS Code's
`mcp.json` or Cursor's `mcpServers`, as you choose; the AI Assistant's in a JetBrains IDE, an `mcpServers` entry
running `mcp-remote`. It holds your API key: keep it out of the repository.

The key carries your whole role, write tools included. For a token of the agent's own, set `piwi.mcpAuthorization`
to `sign-in` (**Settings → Tools → Piwi → Agents (MCP)** in a JetBrains IDE): the server comes without a key, and the
agent [signs in](/features/mcp#authentication) in your browser when it first connects. You revoke that token with
your API keys. The desktop app keeps its own token. For the runs the editor starts:
[Run control for agents](./agent-run-control).

## Colors and hidden messages

VS Code's theme colors, set in `workbench.colorCustomizations`: `piwi.failingTestBackground` and
`piwi.failingLineBackground` tint a failing test and the line it failed at, `piwi.failingTestOverviewRuler` and
`piwi.failingLineOverviewRuler` mark them in the scrollbar; `piwi.flakyForeground` colors the word flaky after a flaky
test's line in the Testing view; `piwi.recordingBlockBackground` and `piwi.recordingBlockOverviewRuler` mark the block
a recording writes; `piwi.executionPointBackground` and `piwi.executionPointOverviewRuler` the line a test is stopped
at, `piwi.failurePointBackground` and `piwi.failurePointOverviewRuler` the line it holds a failure at. The coverage
marks have [their own](./editor-coverage#the-marks). A JetBrains IDE has the failing test, its line, the lines being
recorded and the stopped line under **Settings → Editor → Color Scheme → Piwi**.

**Don't Show Again** on a message of the editor service adds its kind to VS Code's `piwi.hiddenMessages`:
`agent-let-go` (a stop an agent held goes on once the agent went idle), `window-shared` (a run is shared live, as the
window's runs are), `unattended-resumed` (a test stopped where nobody attends the run goes on) and `reporter-missing`
(a run did not reach the instance, from a config without the Piwi reporter). Remove a kind to see its message again.

VS Code's Piwi settings come in five groups, Connection, Runs, In the editor, Agents (MCP) and Advanced, as JetBrains'
settings page does. **In the editor** chooses the lines Piwi writes above the code (`piwi.codeLens`: every one, a
failure's and an uncovered change's alone, or none; a test's gutter mark stays), and turns off the brittle locators'
warnings (`piwi.locatorWarnings`), the failing test's tint (`piwi.failingTestTint`) and the CI positions
(`piwi.ciPositions`). Your own choices (how runs start and notify, breakpoints, the status bar's alert, the agent's sign-in) hold in
every workspace: a repository's `.vscode/settings.json` sets only the instance and the project, the failure severity,
serving runs to agents and Piwi's tests in the Testing view.

## Commands

Each extension's commands, under **Piwi:** in VS Code's command palette and **Tools → Piwi** in a JetBrains IDE, are
listed with what they do on [Editor commands](/reference/editor-commands). Three have the same shortcut in both
editors (where some keymaps and plugins already use these chords): `Ctrl+Shift+Alt+K` runs the test at the cursor,
`Ctrl+Shift+Alt+F` re-runs the failing tests, and `Ctrl+Shift+Alt+R` records at the cursor, then stops the recording;
`Cmd` for `Ctrl` on macOS. **Preferences: Open Keyboard Shortcuts** changes them in VS Code (search `piwi`),
**Settings → Keymap** in a JetBrains IDE (search `Piwi`).

## JetBrains IDEs

The plugin runs with the project's Node.js interpreter, 20 or later, and shows the failures in the Piwi tool window,
the lines above the code with Code Vision, and its actions under **Tools → Piwi**: [JetBrains plugin](./jetbrains).

## Related

- [Failures in the editor](./editor-failures): the CI failures, their quick fixes and the failures view.
- [Runs from the editor](./editor-runs): run tests, and follow them in [the status bar](./editor-status-bar).
- [Record tests from the editor](./editor-recording): steps written at the cursor as you take them.
- [Write, run and fix a test](./write-run-fix): the loop across tools.
