---
title: Editor extensions
description: "Piwi in VS Code and the JetBrains IDEs: tests recorded at the cursor, the latest CI failures at their failing lines with your local runs laid over them and the heal as a quick fix, the tests behind each locator, file and line, brittle locators, and the locators an unsaved change breaks."
lang: en-US
---

# Editor extensions

The Piwi extension for VS Code (and Cursor, VSCodium) and the Piwi plugin for the JetBrains IDEs with the LSP API
(WebStorm, IntelliJ IDEA Ultimate, Rider, from 2024.1) bring what the dashboard knows about your suite to the line you
are editing. Both run the same editor service; the [JetBrains plugin](./jetbrains) page lists what the plugin needs
and draws differently.

<figure>
  <img src="/screenshots/vscode-heal.png" alt="VS Code: a CI failure at its line, the heal offered as a quick fix">
  <figcaption>The latest run's failure at its line, and the heal as a quick fix.</figcaption>
</figure>

## Install and connect

Install **Piwi** from the
**[Visual Studio Marketplace ↗](https://marketplace.visualstudio.com/items?itemName=PiwiTests.piwi)** (`piwitests.piwi`
in the extensions view) or the **[JetBrains Marketplace ↗](https://plugins.jetbrains.com/plugin/34674-piwi)**
(**Settings → Plugins**). It starts on a trusted workspace holding a Playwright config, and reads the connection
the reporter already uses: the `PIWI_*` variables in the environment or the workspace `.env`, or the
[desktop app](/features/desktop). Otherwise, run **Piwi: Connect** (**Settings → Tools → Piwi** in a JetBrains IDE)
and sign in with the browser: [Editor connection](./editor-connection) has the steps.
In VS Code, the extension also opens a path clicked in the dashboard, with no root to set:
[Open in IDE](./ide-integration#vs-code-the-piwi-extension).

In VS Code, the first workspace with a Playwright config opens the **Get started with Piwi** walkthrough, once per
machine, unless `workbench.welcomePage.walkthroughs.openOnInstall` is off; **Piwi: Get started** opens it again. Its
steps cover the connection, the failures, a run, a recording, the MCP server and the settings. A JetBrains IDE shows one notification instead: [JetBrains plugin](./jetbrains#install-and-start).

Nothing from your workspace is sent to the instance: the project's
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
| A spec | the tests Piwi knows in it; beside each `test(…)`, its latest result in the gutter, a failing test's body tinted, and on hover its pass rate, [flaky](/features/flaky-tests) score and root cause, quarantine and selections | opens the test in the dashboard |
| A page object or spec | above each locator line, the tests using it, their actions, and how many fail or are flaky | runs those tests |
| An application file | the tests that reach it, from [code reach](/features/code-reach); with [coverage](./editor-coverage), each function's too | runs those tests |
| A page file (Nuxt `pages/**`) | the tests acting on that page, its locators and how many are brittle | runs those tests |

Above a flaky test: its flaky rate and [top suspect](./flake-lab#from-the-editor-and-the-failure-pages), then
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
connection it already has. Elsewhere, **Piwi: Copy the MCP server configuration** puts an entry on the clipboard: for
`mcp.json` in VS Code, for the AI Assistant's MCP settings in a JetBrains IDE (an `mcpServers` entry running
`mcp-remote`). It holds your API key, so paste it into your user settings, not into the repository.

The key carries your whole role, write tools included. For a token of the agent's own, set `piwi.mcpAuthorization`
to `sign-in` (**Settings → Tools → Piwi → AI Assistant** in a JetBrains IDE): the server comes without a key, and the
agent [signs in](/features/mcp#authentication) in your browser when it first connects. You revoke that token with
your API keys. The desktop app keeps its own token.

## Commands

| Command | What it does |
|---|---|
| Piwi: Connect, Disconnect | See [Editor connection](./editor-connection) |
| Piwi: Refresh | Fetch the indexes and the latest run again |
| Piwi: Refresh the latest run | Read the latest run again, as a status bar click does |
| Piwi: Run the test at the cursor | Run the test whose `test(…)` call holds the cursor: [Run tests](./editor-runs#run-tests) |
| Piwi: Verify the test at the cursor ×3 | Run it three times without retries and say how many runs passed |
| Piwi: Run this spec | Run the tests of the spec Piwi knows |
| Piwi: Run the tests that reach this file | Run them in a terminal, as `piwi run` would |
| Piwi: Re-run the failing tests | Run every test still failing: [Re-run the failing tests](./editor-runs#re-run-the-failing-tests) |
| Piwi: Open in dashboard | Open this file's test, or the latest run |
| Piwi: Run selection… | Run a saved [selection](/features/test-selection) |
| Piwi: Open the latest run | Open the run the status bar shows |
| Piwi: Compare with… | Choose the run the failures are read against: [Compare with another run](./editor-failures#compare-with-another-run) |
| Piwi: Pair with Piwi Picker | Copy the address [Piwi Picker sends to](./editor-recording#send-from-piwi-picker) |
| Piwi: Record here, Record a new test file | Record at the cursor, or into a new spec: [Record tests from the editor](./editor-recording) |
| Piwi: Stop recording, Pause recording, Resume recording | Control the recording in progress |
| Piwi: Pause the run, Resume the run, Step to the next call, Run to the cursor, Finish the test without stopping again, Stop the run, Show the paused page | [Pause and step from the editor](./editor-run-control) |
| Piwi: Toggle the coverage marks | Show or hide the [coverage marks](./editor-coverage) |
| Piwi: Open the log | Show the editor service's log; the `piwi.trace.server` setting adds its traffic |
| Piwi: Get started | Open the walkthrough |

Three commands have the same shortcut in VS Code and the JetBrains IDEs, free in their default keymaps on Windows,
Linux and macOS: `Ctrl+Shift+Alt+K` runs the test at the cursor, `Ctrl+Shift+Alt+F` re-runs the failing
tests, and `Ctrl+Shift+Alt+R` records at the cursor, then stops the recording; `Cmd` for `Ctrl` on macOS.
**Preferences: Open Keyboard Shortcuts** changes them in VS Code (search `piwi`), **Settings → Keymap** in a
JetBrains IDE (search `Piwi`).

## JetBrains IDEs

The plugin runs with the project's Node.js interpreter, 20 or later, and shows the failures in the Piwi tool window,
the lines above the code with Code Vision, and its actions under **Tools → Piwi**: [JetBrains plugin](./jetbrains).

## Related

- [Failures in the editor](./editor-failures): the CI failures at their lines, the quick fixes and the failures view.
- [Runs from the editor](./editor-runs): run tests, and follow the run in the status bar.
- [Record tests from the editor](./editor-recording): steps written at the cursor as you take them in a browser.
- [Editor connection](./editor-connection): the instance the editor reads, and its key.
