---
title: Editor commands
description: "Every command of the Piwi extension for VS Code and of the Piwi plugin for the JetBrains IDEs: connection, runs, the failures, recording, run control, code at a stop, sharing live and agents, with what each does."
lang: en-US
---

# Editor commands

Every command the two editors offer, by what it acts on. VS Code lists them in the command palette under **Piwi:**;
a JetBrains IDE lists them under **Tools → Piwi** and in **Find Action**, says caret for cursor and project for window,
and shows a toggle's state with a check mark. A row that names one editor is that editor's alone. Both editors give
`Ctrl+Shift+Alt+K` to Run the test at the cursor, `Ctrl+Shift+Alt+F` to Re-run the failing tests and
`Ctrl+Shift+Alt+R` to Record here… and Stop recording (`Cmd` on macOS); a run's controls take the debugger's keys
([The controls](/features/editor-run-control#the-controls)).

## Connection

| Command | What it does |
|---|---|
| **Piwi: Connect…**, **Piwi: Disconnect** | Choose the desktop app or an instance and its project, or forget them: [Editor connection](/features/editor-connection) |
| **Piwi: Open settings** | Piwi's settings: the instance and the project |
| **Piwi: Read the instance and the configs again** | Fetch the indexes and the latest run again and read the Playwright configs; in a JetBrains IDE, search the project for configs again and start a stopped editor service |
| **Piwi: Restart the editor service** | Stop the editor service and start it again |
| **Piwi: Open the log** | The editor service's log: its starts and ends, its errors and the requests that failed |
| **Piwi: Open the Piwi menu** | VS Code: the status bar item's menu, which a JetBrains IDE opens with a click on its item: [The editor's status bar](/features/editor-status-bar) |
| **Piwi: Node.js settings…** | JetBrains: choose the Node.js the editor service starts with |
| **Piwi: Get started** | VS Code: open the walkthrough |
| **Piwi: Open the documentation** | Open this site in the browser: [Editor extensions](/features/editors) from VS Code, [JetBrains plugin](/features/jetbrains) from a JetBrains IDE |

## Runs

| Command | What it does |
|---|---|
| **Piwi: Run the test at the cursor** | Run the test whose `test(…)` call holds the cursor: [Run tests](/features/editor-runs#run-tests) |
| **Piwi: Verify the test at the cursor ×3** | Run it three times without retries and say how many runs passed |
| **Piwi: Run this spec** | Run every test of the spec as it stands |
| **Piwi: Run the tests that reach this file** | Run the tests that reach the active file through [code reach](/features/code-reach) |
| **Piwi: Run a saved selection…** | Run a saved [selection](/features/test-selection) |
| **Piwi: Show the test's actions…** | VS Code: the actions of the test at the cursor, as its gutter offers them |
| **Piwi: Re-run the failing tests** | Run every test that still fails: [Re-run the failing tests](/features/editor-runs#re-run-the-failing-tests) |
| **Piwi: Turn headed runs on or off** | Run every test Piwi starts in this window headed, or headless: [How a run starts](/features/editor-runs#how-a-run-starts) |
| **Piwi: Hold failures from each run's start…** | Auto, On or Off: whether a failed test of each run waits at its line for an answer |
| **Piwi: Run options…** | VS Code: choose between the two above |

## The failures and the dashboard

| Command | What it does |
|---|---|
| **Piwi: Refresh the latest run** | Read the latest run and its failures again, and none of the indexes |
| **Piwi: Open in dashboard** | Open the selected failure, run or test in the dashboard; from the palette, this file's test, else the latest run |
| **Piwi: Open the latest run** | Open the run the status bar shows |
| **Piwi: Compare with…** | Choose the run the failures are read against: [Compare with another run](/features/editor-status-bar#compare-with-another-run) |
| **Piwi: Group the failures by…** | File, cluster or owner, or a flat list: [The failures view](/features/editor-failures#the-failures-view) |
| **Piwi: Follow the active editor**, **Piwi: Stop following the active editor** | VS Code: select the active file's first failure in the failures view, or stop |
| **Piwi: Open the failures** | JetBrains: open the Piwi tool window's failures |
| **Piwi: Show the run's flaky tests** | Open the failures view on the run's [flaky tests](/features/flaky-tests) |
| **Piwi: Show or hide the coverage marks** | The [coverage marks](/features/editor-coverage) of the lines the tests ran |

A failure's menu in the failures view adds **Run this test**, **Debug this failure**, **Verify the test ×3**, **Go to
the test**, **Open the trace**, **Open the screenshot**, **Copy context for agent**, **Reproduce in the desktop app**,
**Find the breaking commit in the desktop app** and, on a flaky test in VS Code, **Look into this flake…**:
[Failures in the editor](/features/editor-failures).

## Recording

| Command | What it does |
|---|---|
| **Piwi: Record here…** | Record at the cursor, in a browser your project's Playwright opens: [Record tests from the editor](/features/editor-recording) |
| **Piwi: Record a new test file…** | Create a spec and record into it; in a JetBrains IDE, the **New** menu's **Playwright test (recorded)…** too |
| **Piwi: Stop recording**, **Piwi: Pause recording**, **Piwi: Resume recording** | Control the recording in progress |
| **Piwi: Go to the recorded lines** | JetBrains: open the lines the recording in progress writes |
| **Piwi: Pair with Piwi Picker** | Copy the address [Piwi Picker sends to](/features/editor-recording#send-from-piwi-picker) |

## Run control

| Command | What it does |
|---|---|
| **Piwi: Pause the run**, **Piwi: Resume the run**, **Piwi: Step to the next call**, **Piwi: Run to the cursor**, **Piwi: Finish the test**, **Piwi: End the test**, **Piwi: Stop the run** | [Pause and step from the editor](/features/editor-run-control) |
| **Piwi: Go to the stopped line**, **Piwi: Show the paused page** | Open the line a test is stopped at, or an image of its page |
| **Piwi: Turn hold failures on or off for the run** | Whether a failed test the pause bar does not show waits at its line, in this run |
| **Piwi: Watch a worker's test**, **Piwi: Pause and watch a worker's test**, **Piwi: Open the trace so far** | [Watch a local test](/features/watch-running-test) |
| **Piwi: Show the stopped test's browser** | Bring a headed run's browser window to the front |
| **Piwi: Share the stopped test's browser with Playwright tools** | [Share with Playwright tools](/features/editor-run-control#share-with-playwright-tools) |
| **Piwi: Open the page of a run of this window** | The page of a run this window started or follows, on the instance or the desktop app |
| **Piwi: Open the branch's run in progress** | VS Code: open the run of the branch the instance is receiving: [Follow a run](/features/watch-a-run) |

## Code at a stop

| Command | What it does |
|---|---|
| **Piwi: Pick a locator at the stop**, **Piwi: Record at the stop**, **Piwi: Assert at the stop**, **Piwi: Assert a region at the stop**, **Piwi: Mock a request at the stop…** | What the stop's own controls call Pick a locator, Record, Assert, Assert a region and Mock a request: [Code from a pause](/features/editor-stop-code) |
| **Piwi: Write code at the stop…** | VS Code: choose one of them |

## Share live

| Command | What it does |
|---|---|
| **Piwi: Share the run live on the team instance**, **Piwi: Stop sharing the run live** | [Share a local run live](/features/share-live) |
| **Piwi: Share this window's runs live until I stop**, **Piwi: Stop sharing this window's runs live** | Every run of this window, from now on |
| **Piwi: Shared live: open the run page, copy its link or stop sharing…** | VS Code: the menu of the status bar's live item |

## Agents

| Command | What it does |
|---|---|
| **Piwi: Copy the MCP server configuration…** | Piwi's [MCP server](/features/editors#piwi-s-mcp-server-for-the-agent) for an agent |
| **Piwi: Copy the runs' MCP server configuration for agents…**, **Piwi: Copy the runs' MCP server configuration for Claude Code or Cursor**, **Piwi: Reset the runs' MCP server token** | [Run control for agents](/features/agent-run-control); the second is JetBrains' |

The lines above the code and the quick fixes also run commands no menu lists: **Run tests**, **Run a command**,
**Copy text** and **Reproduce, bisect or run Flake Lab in the desktop app**.

## Related

- [Editor extensions](/features/editors): what the extensions show, and how they connect.
- [JetBrains plugin](/features/jetbrains): what the plugin needs and draws differently.
