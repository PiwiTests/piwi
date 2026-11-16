## Open the settings

Piwi's settings come in the groups of the Editor settings page, which says each one's default and whether a
workspace may set it.

- **Connection**: `piwi.serverUrl` and `piwi.project`, the instance and the project, which **Piwi: Connect…** sets.
- **Runs**: `piwi.runNotifications` and `piwi.runNotificationsScope`, when a run says what it changed and for which
  runs; `piwi.statusBarAlert`, which failures turn the status bar item red; `piwi.breakpoints`, `piwi.runHeaded` and
  `piwi.runHoldFailures`, how the runs Piwi starts pause, show their browser and hold their failures; and
  `piwi.testExplorer`, Piwi's tests in the Testing view.
- **In the editor**: `piwi.codeLens`, the lines Piwi writes above the code; `piwi.gutterIcons` and
  `piwi.coverageMarks`, the marks in the gutter and at the left of the lines; `piwi.failureSeverity`, how a failure
  shows in the Problems panel; `piwi.locatorWarnings`, `piwi.failingTestTint` and `piwi.ciPositions`, the brittle
  locators' warnings, the failing test's tint and where a CI run of the branch stands; `piwi.runningLines`, the line
  each running test of your run is at.
- **Agents (MCP)**: `piwi.mcpAuthorization`, how the agent signs in to Piwi's MCP server, and `piwi.serveRunsToAgents`,
  the runs this window starts served to agents.
- **Advanced**: `piwi.hiddenMessages`, the messages a **Don't Show Again** hid, and `piwi.trace.server`, the traffic
  with the editor service in the log, which **Piwi: Open the log** shows.

Your own choices hold in every workspace, which a repository's `.vscode/settings.json` cannot change. The colors Piwi
draws with, such as `piwi.failingTestBackground`, change in `workbench.colorCustomizations`. **Piwi: Get started**
opens this walkthrough again, and **Piwi: Open the documentation** the editors' pages in the browser.
