# Piwi for VS Code

Your Playwright suite's history where you change the code, from a [Piwi](https://piwitests.dev) instance.

- **CI failures in the Problems panel.** The failures of the latest run on the checked-out branch, at their failing
  line, with one line on why each failed. Your own runs since are laid over it within a second of their end: a test
  you fixed and re-ran leaves the panel, one your run broke joins it, and a notification says what your run changed.
- **The failures view.** The Piwi panel's **Failures** view lists them as a tree under the run, grouped by spec,
  failure cluster or owner, with your runs since; each test runs again, opens its trace or its page in one click, and
  **Re-run the failing tests** runs them all. A run started there pauses at your breakpoints in the browser, where a
  locator you pick replaces the one on that line.
- **Heal in place.** On a failing locator, the replacement Piwi recommends is a quick fix: the same edit an auto-heal
  pull request makes. **Open the trace** downloads it and opens Playwright's trace viewer; the failure screenshot is in
  the hover.
- **The tests behind each line.** Beside each test, its latest result in the gutter, a failing test's body tinted, and
  its history on hover; above each locator line, the tests that use it; above an application file, the tests that
  reach it (with code reach on).
- **The lines your tests ran.** With coverage recorded, an application file, C# included, marks the lines tests ran,
  the executable lines none runs and the lines changed since the coverage run; a line above each function names the
  tests that ran it and runs them, and the hover on a line lists them. **Piwi: Toggle the coverage marks** hides them.
- **Brittle locators and breaking changes.** A warning on a brittle locator, with the stable alternative stored at that
  call site; a warning on the line of an unsaved change that renames a string tests find elements by, with a quick fix
  that updates every call site.
- **Record a test.** **Piwi: Record here** opens a browser through your project's own Playwright and writes what you
  do there at the cursor, as you do it: steps inside a test, or a new test between tests. **Piwi: Record a new test
  file** records a whole spec. It needs no instance.
- **The status bar.** The latest run on the branch, with what your local runs fixed since (`2 failing · 1 fixed
  locally`), and the run you started from the editor, live while it runs; a click reads it again. **Piwi: Compare
  with…** compares with another branch, a run by its id, or your local runs only.
- **Piwi's MCP server for the agent**, with the connection the extension already has.

## Connect

The extension reads the connection the reporter uses: `PIWI_DASHBOARD_URL`, `PIWI_API_KEY` and `PIWI_PROJECT_NAME` in
the environment or the workspace `.env`, then the Piwi desktop app. Otherwise run **Piwi: Connect**; the API key goes
to VS Code's secret storage. When the desktop app runs beside a shared instance, **Piwi: Connect** switches between
them, and keeps both.

See [the editors page](https://piwitests.dev/features/editors) for everything it shows.
