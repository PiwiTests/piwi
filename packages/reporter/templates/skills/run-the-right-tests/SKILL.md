---
name: run-the-right-tests
description: Pick and run the right subset of Playwright tests using Piwi's data-driven selections and the tests a change impacts, instead of always running the whole suite. Use when the user asks to "run smoke tests", "run the right tests", "just run what's relevant", "run the tests my change affects", "verify this fix", or wants a fast, targeted test loop rather than the full run.
---

# Run the right tests with Piwi selections

Running the whole suite for every change is slow, and hand-maintained grep patterns go stale. A Piwi **selection** is a named, declarative subset of the suite that Piwi resolves from run history — smoke, critical-and-stable, recently-broken, the best five minutes. This skill picks the selection that fits the task and runs exactly those tests.

## How you reach Piwi

Prefer the **Piwi MCP server** if it is connected (`get_impacted_tests`, `list_selections`, `resolve_selection`,
`preview_selection`, `predict_locator_breaks`). Otherwise use the reporter CLI (`npx @piwitests/reporter select|run|preflight`) with `PIWI_DASHBOARD_URL` / `PIWI_API_KEY` / `PIWI_PROJECT_NAME` set, or the dashboard's **Selections** tab.

## Steps

0. **After a UI change, check the locators it breaks first.** Renaming a label, an `aria-label`, a test id, a
   placeholder or a translation breaks every test that finds the element by it. Run
   ```
   npx @piwitests/reporter preflight --fix
   ```
   It diffs the working tree against `HEAD`, lists the locators the change breaks with their tests, and rewrites the
   ones whose call site holds the string (keeping the quotes). Edit the ones it lists as "edit by hand" yourself, then
   run the tests it names with `npx @piwitests/reporter preflight --run`. Over MCP, `predict_locator_breaks` takes
   your `git diff` and returns the same breaks and edits. A prediction is not a failure: say which breaks you fixed and
   which you left, and why.

1. **After any code change, run the tests it impacts.** Over MCP, call `get_impacted_tests` with your diff
   (`git diff --full-index <base>`, the base being the commit your change starts from, such as `origin/main`). Each
   changed file lists the tests it selects and how: `lines` (the test ran a changed line), `functions` (it ran the
   function around one), `file` (its coverage cannot rule it out), `test-file`, `frames` or `route`. Run the
   `command` it returns, or, from the CLI, `npx @piwitests/reporter run impact --base origin/main`. Read the answer
   before trusting it:
   - `widened` means a changed file maps to no test, so the command runs the whole suite. Say which files did that.
   - A file's `notRun` lines are changed code no test runs: no test can catch a mistake there. Name them, and offer
     to write the test (the `write-the-missing-test` skill).
   - The tests marked `lines` or `test-file` are the first to check for edits a change in behavior needs.

2. **See what selections exist.** Call `list_selections` for the project. Every project has the built-ins `failed` (tests whose latest run failed) and `quarantine-free`, plus any the team saved (often `smoke`). Pick the one that matches the intent:
   - About to make a broad change, or want a quick confidence check → `smoke` (or `preview_selection` with `{ "include": [{ "tags": ["smoke"] }] }`).
   - Iterating on a fix → `failed`, or a `{ "include": [{ "failedInLastRuns": 5 }] }` preview.
   - Time-boxed → resolve any selection with a `budgetMs` (e.g. 300000 for five minutes).

3. **Resolve it to a command.** Call `resolve_selection` with the key (and optional `budgetMs`). You get back the matching tests, an estimate, and a ready-to-run `playwright test` command. Check the count and warnings first — a selection that matches **zero** tests is a red flag (too narrow, or nothing qualifies), and a `quarantined-included` warning means a flaky test is in the set.

4. **Run it.** The most reliable way is the reporter CLI, which resolves and runs in one step and stamps the run so the dashboard names the subset:
   ```
   npx @piwitests/reporter run <key>
   ```
   Or run the materialized command `resolve_selection` returned directly with `playwright test`. Pass extra Playwright args after `--` (e.g. `-- --workers=4`).

5. **After a fix, verify with the same selection.** Re-run the selection that covered the failure and confirm it now passes. In CI, `npx @piwitests/reporter gate --require-selection <key>` fails the build if any test the selection currently matches did not run or did not pass — catching a smoke job that silently shrank.

6. **Report.** State which selection you ran, how many tests it resolved to, and the outcome. If no saved selection fit, suggest one (a `preview_selection` definition the team could save) rather than falling back to the whole suite silently.

## Guardrails

- A selection that resolves to **zero** tests is never "nothing to do" — it means the definition is wrong. Stop and say so.
- Selections choose what to *run*; they never hide a failure. Quarantine is the tool for a test whose verdict should not block a merge — do not use a selection to route around a red test.
- Don't invent a selection key. Use `list_selections` to see the real ones, and `preview_selection` for an ad-hoc subset.
- The full suite stays the baseline. Selections are for the fast loops between full runs, not a permanent replacement.
