---
title: Editor extensions
description: "Piwi in VS Code and the JetBrains IDEs: tests recorded at the cursor, the latest CI failures at their failing lines with your local runs laid over them and the heal as a quick fix, the tests behind each locator and file, brittle locators, and the locators an unsaved change breaks."
lang: en-US
---

# Editor extensions

The Piwi extension for VS Code (and Cursor, VSCodium) and the Piwi plugin for the JetBrains IDEs with the LSP API
(WebStorm, IntelliJ IDEA Ultimate, Rider, from 2024.1) bring what the dashboard knows about your suite to the line you
are editing. Both run the same editor service; [JetBrains IDEs](#jetbrains-ides) lists what the plugin draws
differently.

## Install and connect

Install **Piwi** from the extensions view (`piwitests.piwi`) or, in a JetBrains IDE, from the
**[JetBrains Marketplace ↗](https://plugins.jetbrains.com/plugin/34674-piwi)** (**Settings → Plugins**). It
starts on a workspace that holds a Playwright config, and reads the connection the reporter already uses: the
`PIWI_*` variables in the environment or the workspace `.env`, or the [desktop app](/features/desktop). Otherwise,
run **Piwi: Connect** (**Settings → Tools → Piwi** in a JetBrains IDE) and sign in with the browser:
[Editor connection](./editor-connection) has the steps.

Nothing from your workspace is sent to the instance: the project's
[locator index](/guide/concepts#locator-index), [code reach](/features/code-reach) and latest run are compared with
your files locally.

## CI failures in the Problems panel

The failures of the latest complete [CI run](/reference/test-metadata#run-origin) on the checked-out branch, else the
default branch, are errors in the Problems panel, at the line that failed: the call in the error's stack when that file
is in your workspace (often a page object), else the `test(…)` line, with the failure's headline. Your local runs
since are laid over it, and the editor reads it again as soon as a run ends: [Runs from the editor](./editor-runs)
covers running tests, the failures view, the status bar, and what a run changes. Each failure follows your edits until a run covers its
test again: [Failures follow your edits](./editor-runs#failures-follow-your-edits).

On a failure, the quick fixes are:

- **Heal: use …** — when [locator healing](/features/locator-healing) has a recommendation for the failing locator,
  the same edit an [auto-heal pull request](/features/auto-heal) would make, applied in place.
- **Run this test** — runs the failing test from the editor; first once you rewrote the line it failed at.
- **Open the trace** — opens it with `npx playwright show-trace`.
- **Reproduce in the desktop app**, **Find the breaking commit in the desktop app**, and **Run Flake Lab on its
  untested suspects in the desktop app** for a test with an untested [flake suspect](./flake-lab) — on a team
  instance's failure while the [desktop app](/features/desktop#jobs-from-your-editor) runs; **Share on …** records
  the result.
- **Apply the fix plan, then run its verification** — when the failure's [cluster](/features/failure-clusters) has a
  [fix plan](/features/fix-plans) whose patch applies to your files: VS Code previews the edit, then runs the plan's
  verify command in a terminal.
- **Copy context for agent** — the failure, its healing and fix plan, for a coding agent.
- **Open the failure in the dashboard** — the execution page, with its [evidence](/features/evidence).

Hover for the error message, its call chain, the failure screenshot, and the tickets linked to the failure's
cluster or test. Without one, **File an issue** opens the cluster in the dashboard.

## The tests behind each line

Lines above the code (CodeLens):

| File | What it shows | Click |
|---|---|---|
| A spec | the tests Piwi knows in it; beside each `test(…)`, its latest result in the gutter, a failing test's body tinted, and on hover how often it passed, its [flaky](/features/flaky-tests) score and root cause, its quarantine, and its selections | opens the test in the dashboard |
| A page object or spec | above each locator line, the tests using it, their actions, and how many fail or are flaky | runs those tests |
| An application file | the tests that reach it, from [code reach](/features/code-reach) | runs those tests |
| A page file (Nuxt `pages/**`) | the tests acting on that page, its locators and how many are brittle | runs those tests |

In a failing test, the line it failed at (in the spec, the line that calls the page object) is tinted darker, with the
reason, **Screenshot** and **Trace** above it.

Above a flaky test: its flaky rate and [top suspect](./flake-lab#from-the-editor-and-the-failure-pages), then
**Reproduce this flake** and, once reproduced, **Verify the flake fix**, which run `piwi flake` against the instance
the editor reads, and, beside a team instance, **Reproduce this flake in the desktop app**.

## Timeouts

A test whose `test.slow()` is no longer needed, or whose timeout is far above its p95, gets a note on its line and a
quick fix: remove the `test.slow()`, or set `test.setTimeout` to the
suggested value.

## Completion

- After `page.` (or `this.page.`) in a spec or a page object: the locator chains your suite already uses on the pages
  this file's tests visit, most used first and brittle ones last.
- At the start of a statement: the [functions](/features/test-functions) of your catalog whose URL pattern matches
  those pages, as a call with a placeholder per parameter.
- In a `piwi:` annotation: the types (`piwi:owner`, `piwi:priority`, `piwi:feature`, `piwi:link`), then the owners your
  `CODEOWNERS` names, the priorities, or the project's features; in `tag: ['@…']`, the tags your tests already use.

## Brittle locators

A locator the [stability rules](/reference/locator-stability) rate brittle is a warning on its line; one worth a
look is a hint. When the capture fixtures stored a stable alternative for that call site on its last passing run, the
quick fix replaces the chain with it.

## The locators a change breaks

In an application file, the unsaved buffer is compared with `HEAD` as you type, the same way
[`piwi preflight`](/features/preflight) compares a diff. A changed line whose string a locator finds its element by is
a warning, with the chains it breaks and their tests on hover, and one quick fix that rewrites every call site.

## Piwi's MCP server for the agent

In VS Code 1.101 and later, the extension provides Piwi's [MCP server](/features/mcp) to the editor's agent with the
connection it already has. In an editor without that API, **Piwi: Copy the MCP server configuration** puts an `mcp.json` entry on the
clipboard. It holds your API key: paste it into your user settings, not into the repository.

## Commands

| Command | What it does |
|---|---|
| Piwi: Connect, Disconnect | See [Editor connection](./editor-connection) |
| Piwi: Refresh | Fetch the indexes and the latest run again |
| Piwi: Refresh the latest run | Read the latest run and its failures again, as a click on the status bar does |
| Piwi: Run the tests that reach this file | Run them in a terminal, with the arguments `piwi run` would use |
| Piwi: Open in dashboard | Open this file's test, or the latest run |
| Piwi: Run selection… | Run one of the project's saved [selections](/features/test-selection) |
| Piwi: Open the latest run | Open the run the status bar shows |
| Piwi: Compare with… | Choose the run the failures are read against: [Compare with another run](./editor-runs#compare-with-another-run) |
| Piwi: Pair with Piwi Picker | Copy the address [Piwi Picker sends to](./editor-recording#send-from-piwi-picker) |
| Piwi: Record here, Record a new test file | Record in a browser opened through your project's own Playwright, at the cursor or into a new spec: [Record tests from the editor](./editor-recording) |
| Piwi: Stop recording, Pause recording, Resume recording | Control the recording in progress |

## JetBrains IDEs

The [plugin](https://plugins.jetbrains.com/plugin/34674-piwi) starts the editor service with the project's Node.js
interpreter, 20 or later (**Settings → Languages & Frameworks → Node.js**, which the status bar opens when it is
missing or older), once it finds a Playwright config within four folders of
the project's (in Rider, the solution's) or of its Git root; it looks again when one is added or removed, and on
**Tools → Piwi → Refresh**. The IDE's LSP client shows warnings, quick fixes and hover in open files; the rest is
native:

- **The Piwi tool window** names the connection and holds the latest run's failures as a tree, since the IDE
  highlights open files only: [the failures view](./editor-runs#the-failures-view).
- **Code Vision** shows the lines above files, locators and failing lines; each test's result is in the gutter.
- **The status bar** shows the latest run, or the run in progress, and reads it again on a click
  ([the status bar](./editor-runs#the-status-bar)); the actions are under **Tools → Piwi**, and **Run the tests that
  reach this file** is also in the editor's context menu.
- **MCP**: **Copy the MCP server configuration** puts an `mcpServers` entry on the clipboard for **Settings → Tools → AI
  Assistant → Model Context Protocol**. It runs `mcp-remote` with the key in its environment.
- **[Open in IDE](./ide-integration)**: a path clicked in the dashboard of the connected instance, or in the desktop app,
  opens at its line.
- **[Recording](./editor-recording)**: **Tools → Piwi → Record Here**, Alt+Enter or Alt+Insert, and **File → New →
  Record a New Test File…**; the controls are in a banner above the editor.

IntelliJ IDEA Community Edition and Android Studio do not have the LSP API the plugin needs.
