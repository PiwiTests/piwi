## Open the settings

- `piwi.failureSeverity`: how a CI failure shows in the Problems panel: an error, a warning, information, or nothing.
- `piwi.statusBarAlert`: which failures turn the status bar item red: a new failure a run started here caused, any failing
  test, or never.
- `piwi.runNotifications`: when a run started from the editor says what it changed: always, when something fails, or never.
- `piwi.codeLens`: the lines Piwi writes above the code: every one, a failure's and an uncovered change's alone, or
  none.
- `piwi.locatorWarnings`, `piwi.failingTestTint` and `piwi.ciPositions`: the brittle locators' warnings, the failing
  test's tint and the marks where a CI run of the branch stands.
- `piwi.hiddenMessages`: the messages a **Don't Show Again** hid; remove one to see it again.
- `piwi.breakpoints`: whether the runs Piwi starts pause at your breakpoints, in the browser.
- `piwi.serverUrl` and `piwi.project`: the instance and the project, which **Piwi: Connect…** sets.
- `piwi.trace.server`: writes the traffic with the editor service to the log, which **Piwi: Open the log** shows.

Your own choices hold in every workspace, which a repository's `.vscode/settings.json` cannot change; the instance and
the project, failure severity, serving runs to agents and the Testing view may be set per workspace. The colors Piwi draws with, such as `piwi.failingTestBackground`, change in `workbench.colorCustomizations`.

**Piwi: Get started** opens this walkthrough again, and **Piwi: Open the documentation** the editors' pages in the
browser.
