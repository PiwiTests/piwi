---
title: Failures in the editor
description: "The latest CI run's failures in VS Code and the JetBrains IDEs: at the line that failed, with the heal as a quick fix, your local runs laid over them, followed through your edits, and as a tree in the failures view."
lang: en-US
---

# Failures in the editor

The [editor extensions](./editors) show the failures of the latest CI run at the lines that failed, lay your local runs
over them, and follow each failing line through your edits until a run covers its test again.

<figure>
  <img src="/screenshots/vscode-failures.png" alt="VS Code: the failing tests marked in a spec, and the Failures view below">
  <figcaption>The failing tests in the spec, and the Failures view with the run you made since.</figcaption>
</figure>

## CI failures in the Problems panel

The failures of the latest complete [CI run](/reference/test-metadata#run-origin) on the checked-out branch, else the
default branch, are in the Problems panel, at the line that failed: the call in the error's stack when that file
is in your workspace (often a page object), else the `test(…)` line, with the failure's headline. In the spec, the
line a failing test failed at (the line that calls the page object, when it failed in one) is tinted darker, with the
reason, **Run this test**, **Screenshot** and **Trace** above it.

On a failure, the quick fixes are:

- **Heal: use …** makes the edit an [auto-heal pull request](/features/auto-heal) would, when
  [locator healing](/features/locator-healing) has a recommendation for the failing locator.
- **Run this test** runs the failing test; it comes first once you rewrote the line it failed at.
- **Open the trace** opens it in `npx playwright show-trace`.
- **Reproduce in the desktop app**, **Find the breaking commit in the desktop app** and **Run Flake Lab on its
  untested suspects in the desktop app**, for a test with an untested [flake suspect](./flake-lab), while the
  [desktop app](/features/desktop#jobs-from-your-editor) runs; **Share on …** records the result.
- **Apply the fix plan, then run its verification**, when the failure's [cluster](/features/failure-clusters) has a
  [fix plan](/features/fix-plans) whose patch applies to your files: the edit is previewed, then the plan's verify
  command runs in a terminal.
- **Copy context for agent** copies the failure, its healing and fix plan.
- **Open the failure in the dashboard** opens the execution page, with its [evidence](/features/evidence).

Hover for the error message, its call chain, the failure screenshot, and the tickets linked to its cluster or
test. Without one, **File an issue** opens the cluster in the dashboard.

A failure of a run on the checked-out branch is an error; one from another branch, such as the default branch's while
yours has no run yet, is a warning; one whose line you changed since the run is an information (a weak warning in a
JetBrains IDE). The `piwi.failureSeverity` setting (**Settings → Tools → Piwi → Runs** in a JetBrains IDE) chooses
`warning` or `information` in place of the error, or `off`: nothing in the Problems panel, while the failures view,
the gutter and the lines above the tests still show the failures.

## Your local runs

A later finished run on the branch, from the editor, `piwi run`, `npx playwright test` or the desktop app, overlays the
latest CI run per test and Playwright project: a test it fixed leaves the Problems panel, its lens saying *fixed
locally in run #124*; a test failing in it is an error labeled *local run #124*, or *your run #124* when this editor
started it. The editor reads a run within a second of its end: [After a run](./editor-runs#after-a-run).

## Failures follow your edits

A run reports the line a test failed at in the files it ran. The editor reads those files as the run saw them and
follows each failing line through your changes, saved or not:

- Add or remove lines above a failing line, and its error moves with it, in the Problems panel, the lines above the
  test and the failures view.
- Rewrite the failing line, and the error turns into an information marker, *Edited since run #120: …*: the run said
  nothing about the new line. **Run this test** comes first among its quick fixes, and the reason above the line reads
  *✎ edited since run #120*. The test keeps its failing mark until a run says otherwise.
- Delete the test, and its failure leaves the editor.

The next run that covers the test says what is true: a failure there is an error again, and a pass takes it away.

For a CI run, the files as the run saw them are those of its commit (`git show`); for a local run, a run without a
commit, or a commit your clone lacks, the files as saved when the editor first showed the failure.

## The failures view

The latest run's failures as a tree: the **Failures** view of the **Piwi** panel in VS Code, the Piwi tool window in a
JetBrains IDE. Its first node is the run, `Run #120 · CI · feature/x · 3 failing · 1 fixed locally`, with its age, or
the progress of the run you started (`running 4/9`). Under it:

- **Your runs since** lists the runs laid over it, such as `#124 · your run · 2 min ago · 1 passed, 0 failed`; a click
  opens one in the dashboard.
- The failures, grouped by spec (the default), by [failure cluster](/features/failure-clusters), by owner, or flat:
  **Group by…** in the view's title bar, the toggles of the tool window's toolbar. The choice is kept for the
  workspace, and each group counts its failures.
- A failure shows its title, where it failed (`tests/login.spec.ts:42 · chromium · new`), and an icon for failing,
  edited since the run, or fixed locally, with the headline and its run (`your run #124`, `edited since run #120`).

In a workspace with several Playwright configs, each config with a run, your runs or failures has a node of its own,
named by its folder (`apps/admin`), with its project and counts beside it (`Admin · 2 failing`). Its run and failures
are under it, as above, or its run alone when it fails nothing. Its row in VS Code, and its context menu in both
editors, re-run that config's failing tests (**Re-run the failing tests**) and open its run in the dashboard; the
context menu adds **Compare with…** for that config. With one config, the run is the first node.

Click a failure (double-click, Enter or **Next Occurrence** in a JetBrains IDE) to open its line. **Run this test**,
**Open the trace** and **Open in dashboard** sit on its row in VS Code; the context menu adds **Open the screenshot**,
**Copy context for agent**, and, on a CI failure while the [desktop app](/features/desktop#jobs-from-your-editor) runs,
**Reproduce in the desktop app** and **Find the breaking commit in the desktop app**. **Heal** stays a quick fix on the
line.

The title bar, or the toolbar, holds Refresh, **Re-run the failing tests** (every config's), **Open the run in the
dashboard** (the run the status bar shows), **Compare with…** (for the active file's config) and the grouping. In VS
Code, **Follow the active editor** selects the first failure of the file you switch to, and the badge counts the
failing tests, as the tool window's title does. The tree is read again when a run ends or an edit moves a failure.

## Compare with another run

By default, failures are read against the checked-out branch's latest complete run, else the default branch's. **Piwi:
Compare with…** (**Tools → Piwi → Compare With…** in a JetBrains IDE, and the failures view's title bar) chooses another
run to compare with: a branch's latest complete run, a run by its id, or **My local runs only**, your runs from this
machine, the desktop app or an editor, without CI. Your runs since are laid over each. The status bar tooltip and the
failures view name it (`Baseline: CI run #120 on feature/x`), ending with `(no run)` when it found none. The choice is
kept on this machine, per Playwright config.

## Related

- [Editor extensions](./editors): what else the editor shows from your suite.
- [Runs from the editor](./editor-runs): run the failing tests again, and follow the run in the status bar.
- [Locator healing](/features/locator-healing): where the heal quick fix comes from.
