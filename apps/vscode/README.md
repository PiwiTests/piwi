# Piwi for VS Code

Your Playwright suite's history at the line you are editing, from a [Piwi](https://piwitests.dev) instance. Piwi keeps
every run CI throws away, groups the failures by root cause and finds the locator you should have used; this extension
brings that into VS Code, Cursor and VSCodium.

![The failing line of a page object, with the CI failure as a diagnostic and the heal as a quick fix](https://piwitests.dev/screenshots/vscode-heal.png)

## What it shows

- **The latest CI failures, at their lines.** Each failure of the latest run on your branch is an error in the
  Problems panel, at the line that failed, with one line on why. A run you make locally lays over it within a
  second of its end: a test you fixed leaves the panel, one your run broke joins it.
- **The heal as a quick fix.** On a broken locator, the replacement Piwi recommends from the last passing run is a
  quick fix: the same edit an auto-heal pull request would make. **Open the trace** opens Playwright's trace viewer;
  the error, its call chain and the failure screenshot are in the hover.
- **The Failures view.** The run's failures as a tree in the Piwi panel, grouped by spec, cluster or owner, with your
  runs since; each test re-runs, opens its trace or its page in one click, and **Re-run the failing tests** runs them
  all. A run started there pauses at your breakpoints in the browser, where a locator you pick replaces the one on
  that line.
- **The tests behind each line.** Each test's latest result in the gutter, a failing test's body tinted, its history
  on hover; above each locator line, the tests that use it; above an application file, the tests that reach it.
- **Coverage marks.** With coverage recorded, the lines your tests ran, in TypeScript, JavaScript and C# alike, the
  tests behind each function, and the lines changed since the coverage run. **Piwi: Toggle the coverage marks** hides
  them.
- **Brittle locators and breaking changes.** A warning on a locator that will not survive a restyle, with the stable
  alternative stored for that call site, and on an unsaved change that renames a string your tests find elements by,
  with a quick fix that updates every call site.
- **Tests recorded at the cursor.** **Piwi: Record here** opens a browser through your project's own Playwright and
  writes what you do there into the test as you do it; **Piwi: Record a new test file** records a whole spec. No
  instance needed.
- **The status bar.** The latest run on the branch, what your local runs fixed since (`2 failing · 1 fixed locally`),
  and the run you started from the editor, live while it runs. **Piwi: Compare with…** reads the failures against
  another branch, a run by its id, or your local runs only.
- **Piwi's MCP server** for the editor's agent, with the connection the extension already has.

![The Failures view: the latest run's failures as a tree, with a local run laid over them, and the spec's tests marked in the gutter](https://piwitests.dev/screenshots/vscode-failures.png)

![The hover on a failing line: the error, its call log and the chain of calls that reached it](https://piwitests.dev/screenshots/vscode-hover.png)

## Connect

The extension starts on a trusted workspace that holds a Playwright config and reads the connection the reporter
uses: `PIWI_DASHBOARD_URL`, `PIWI_API_KEY` and `PIWI_PROJECT_NAME` in the environment or the workspace `.env`, then
the Piwi desktop app. Otherwise run **Piwi: Connect** and sign in with the browser; the API key goes to VS Code's
secret storage. When the desktop app runs beside a shared instance, **Piwi: Connect** switches between them, and
keeps both.

Nothing from your workspace is sent to the instance: the project's locator index, code reach and latest run are
compared with your files locally.

[Editor extensions](https://piwitests.dev/features/editors) documents everything it shows; the same extension exists
[for the JetBrains IDEs](https://plugins.jetbrains.com/plugin/34674-piwi).
