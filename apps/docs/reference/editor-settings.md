---
title: Editor settings
description: "Every setting of the Piwi extension for VS Code and of the Piwi plugin for the JetBrains IDEs, by group: connection, runs, what the editor shows, agents and advanced, with whose choice each is and where it is kept."
lang: en-US
---

# Editor settings

Both editors group their options as this page does: VS Code in its settings editor (search `piwi.`), and
**Settings → Tools → Piwi** in a JetBrains IDE, whose help button and **Documentation** links open this page. A row that
names one editor is that editor's alone; the JetBrains page has no Advanced group, and opens with the connection in use
and a group for the desktop app.

Each option is one of three kinds:

- **The team's**: one value for everyone on the project. VS Code reads it from the user or the workspace settings,
  which a repository may commit (`.vscode/settings.json`); a JetBrains IDE keeps it in `.idea/piwi.xml`, which the team
  can share.
- **Yours, which a project may set**: your choice, which a workspace's settings can set for that project. A JetBrains IDE
  keeps it for you in the project's `.idea/workspace.xml`.
- **Yours**: the same in every project. VS Code reads it from the user settings alone, so a repository cannot change it;
  a JetBrains IDE keeps it in the IDE's own settings (`options/piwi.xml`).

In Rider, a project's `.idea` files sit under `.idea/.idea.<Name>/.idea/`, as the settings page says.

## Connection

| Setting | What it chooses | Default | Kind |
|---|---|---|---|
| `piwi.serverUrl` | The Piwi instance. `PIWI_DASHBOARD_URL` in the environment or the workspace `.env` comes first, then this, then the desktop app while it runs: [Editor connection](/features/editor-connection) | none | The team's |
| `piwi.project` | The project's name or id on the instance | none | The team's |
| JetBrains: **Read this project from the desktop app while it runs** | Whether the desktop app comes first while it runs; VS Code chooses it with **Piwi: Connect…** | off | Yours, which a project may set |
| JetBrains: **Desktop app project** | The project's name in the desktop app; empty uses the one linked there to this folder | none | Yours, which a project may set |

The API key is kept in the editor's secret storage (VS Code) or the IDE's password safe, for its instance alone, and
the choice of the desktop app on this machine only.

## Runs

| Setting | What it chooses | Default | Kind |
|---|---|---|---|
| `piwi.runNotifications` | When a run ends, whether a notification says what it changed: always, only when something fails, or never | Say what it changed when something fails | Yours |
| `piwi.runNotificationsScope` | The runs it says it for: the runs started here, or also the branch's CI runs | The runs started here and the branch's CI runs | Yours |
| `piwi.statusBarAlert` | When the status bar item turns red: for a new failure a run started here caused, for any failing test, or never | For a new failure a run started here caused | Yours |
| `piwi.breakpoints` | Which runs pause at the editor's breakpoints, Debug with Piwi, every run or none: [Editor breakpoints](/features/editor-breakpoints) | Debug with Piwi | Yours |
| `piwi.runHeaded` | Whether every run Piwi starts runs headed, its browser window shown | off | Yours |
| `piwi.runHoldFailures` | [Hold failures](/features/watch-a-run) from each run's start: Auto, On or Off | Auto | Yours |
| `piwi.testExplorer` | VS Code: whether the Testing view lists Piwi's tests, with their results; off leaves the view to another extension's tree, such as Microsoft's Playwright Test | on | Yours, which a project may set |
| JetBrains: **Run the tests in the IDE's Playwright runner** | Whether a run starts in the IDE's Playwright runner (a test tree, Debug, Rerun Failed Tests) or in the Run tool window's console. The runner comes with the IDE's JavaScript plugin, as in WebStorm, IntelliJ IDEA Ultimate and Rider; where it lacks one, the option is off and says why | off | Yours |

## In the editor

| Setting | What it chooses | Default | Kind |
|---|---|---|---|
| `piwi.codeLens` | The lines Piwi writes above the code: every line, a failure's and an uncovered change's alone, or none. A test's gutter mark stays | Every line | Yours |
| `piwi.gutterIcons` | VS Code: each test's latest result in the gutter; off, its line keeps the hover. A JetBrains IDE switches it under **Settings → Editor → General → Gutter Icons → Piwi test results** | on | Yours |
| `piwi.coverageMarks` | The coverage marks at the left of the lines: [Editor coverage](/features/editor-coverage) | on | Yours |
| `piwi.failureSeverity` | How a failure shows at its line: an error, a warning, information (a weak warning in a JetBrains IDE), or nothing in the problems | An error | Yours, which a project may set |
| `piwi.locatorWarnings` | Whether a locator the [locator stability rules](/reference/locator-stability) find brittle is warned at, with its stable alternative as a quick fix | on | Yours |
| `piwi.failingTestTint` | Whether a failing test and the line it failed at are tinted; the gutter still marks them, unless `piwi.gutterIcons` is off | on | Yours |
| `piwi.ciPositions` | Whether a CI run of the branch shows where it stands, at the end of each line: [Editor CI runs](/features/editor-ci-runs) | on | Yours |

## Agents (MCP)

| Setting | What it chooses | Default | Kind |
|---|---|---|---|
| `piwi.mcpAuthorization` | How the agent signs in to Piwi's MCP server: with the editor's API key, or a sign-in in the browser | The editor's API key | Yours |
| `piwi.serveRunsToAgents` | Whether the test runs started here are served to the agents of this machine, as an MCP server on `127.0.0.1` | on | Yours, which a project may set |

## Advanced

| Setting | What it chooses | Default | Kind |
|---|---|---|---|
| `piwi.hiddenMessages` | VS Code: the kinds of messages **Don't Show Again** hid: `agent-let-go` (a stop an agent held goes on once the agent went idle), `window-shared` (a run is shared live, as the window's runs are), `unattended-resumed` (a test stopped where nobody attends the run goes on), `reporter-missing` (a run did not reach the instance, from a config without the Piwi reporter) and `picker-inserted` (what Piwi Picker inserted at the cursor). Remove a kind to see its message again | none | Yours |
| `piwi.trace.server` | VS Code: whether the traffic with the editor service is traced in the Piwi output channel | Off | Yours |

## Related

- [Editor extensions](/features/editors): what the extensions show, and how they connect.
- [JetBrains plugin](/features/jetbrains): what the plugin needs and draws differently.
- [Editor commands](/reference/editor-commands): every command of both editors.
