---
title: Runs from the editor
description: "Run Playwright tests from VS Code or a JetBrains IDE and follow the run in the status bar: the editor reads its results within a second of its end, lays them over the latest CI run's failures in a tree, and says when a run never reached the instance."
lang: en-US
---

# Runs from the editor

The [editor extensions](./editors) run your tests where you edit them, then show what the run changed: its progress
in the status bar while it executes, and its results over the latest CI run's failures within a second of its end.

<figure>
  <img src="/screenshots/vscode-failures.png" alt="VS Code: the failing tests marked in a spec, and the Failures view below">
  <figcaption>The failing tests in the spec, and the Failures view with the run you made since.</figcaption>
</figure>

## Run tests

- The lines above a locator line, an application file or a page file (CodeLens in VS Code, Code Vision in a JetBrains
  IDE) run the tests they name when clicked; those of a server file record its
  [coverage](./editor-coverage#refresh-the-marks-with-a-local-run).
- **Piwi: Run the tests that reach this file** runs every test reaching the active file through
  [code reach](/features/code-reach); also in the editor's context menu.
- **Piwi: Run selection…** runs a saved [selection](/features/test-selection).

The command, `npx playwright test` with the arguments `piwi run` would pass, runs from the Playwright config's
folder: in a terminal in VS Code, in the Run tool window in a JetBrains IDE (**Rerun** starts it again), or in the
IDE's Playwright runner (test tree, Debug, **Rerun Failed Tests**), a choice of **Settings → Tools → Piwi**. It sets `PIWI_ORIGIN=editor` and its own `PIWI_ORIGIN_REF` ([run origin](/reference/test-metadata#run-origin)),
by which the editor finds its run. Breakpoints pause it in the browser, with Piwi's picker one click away:
[Breakpoints in the browser](./editor-breakpoints).

## Your local runs

A later finished run on the branch, from the editor, `piwi run`, `npx playwright test` or the desktop app, overlays the
latest CI run per test and Playwright project: a test it fixed leaves the Problems panel, its lens saying *fixed
locally in run #124*; a test failing in it is an error labeled *local run #124*, or *your run #124* when this editor
started it.

## After a run

The editor listens to the instance's event stream: within a second of a run of the project ending, it reads the
branch's latest run and its failures again, and every five minutes with the stream, every minute without.

A run started from the editor is its own wherever it runs: the status bar follows it as it runs, and its failures
read *your run #124* once it ends. When the command ends and no run on the instance carries its ref, the editor says
so: `The run ended (exit code 1) but did not reach https://piwi.example.com: is the Piwi reporter in the Playwright
config?` VS Code learns a command ended through shell integration (1.93 and later), and gives each run a terminal
of its own; without it, a folder's runs share one terminal, and a run that never arrived goes unmentioned.

## When your run ends

Once a run you started from the editor ends and the editor has read it, a notification (a balloon in a JetBrains IDE)
says what it changed: `Piwi: run #124 · 1 of 3 CI failures fixed, 2 still failing (login.spec.ts › logs in,
checkout.spec.ts › pays)`, then the tests it failed that were not failing before. It offers **Open the failures**,
**Open in dashboard** and, when something fails, **Re-run failing**. The `piwi.runNotifications` setting (**Settings →
Tools → Piwi** in a JetBrains IDE) shows it always, only when something fails, or never.

While the run executes, the gutter shows each test as running, then its result.

## Failures follow your edits

A run reports the line a test failed at in the files it ran. The editor reads those files as the run saw them and
follows each failing line through your changes, saved or not:

- Add or remove lines above a failing line, and its error moves with it, in the Problems panel, the lines above the
  test and the Piwi tool window.
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

Click a failure (double-click, Enter or **Next Occurrence** in a JetBrains IDE) to open its line. **Run this test**,
**Open the trace** and **Open in dashboard** sit on its row in VS Code; the context menu adds **Open the screenshot**,
**Copy context for agent**, and, on a CI failure while the [desktop app](/features/desktop#jobs-from-your-editor) runs,
**Reproduce in the desktop app** and **Find the breaking commit in the desktop app**. **Heal** stays a quick fix on the
line.

The title bar, or the toolbar, holds Refresh, **Re-run the failing tests**, **Open the run in the dashboard**,
**Compare with…** and the grouping. In VS Code, **Follow the active editor** selects the first failure of the file you
switch to, and the badge counts the failing tests, as the tool window's title does. The tree is read again when a run
ends or an edit moves a failure. The Problems panel keeps its errors.

## Compare with another run

By default, failures are read against the checked-out branch's latest complete run, else the default branch's. **Piwi:
Compare with…** (**Tools → Piwi → Compare With…** in a JetBrains IDE, and the failures view's title bar) chooses another
run to compare with: a branch's latest complete run, a run by its id, or **My local runs only**, your runs from this
machine, the desktop app or an editor, without CI. Your runs since are laid over each. The status bar tooltip and the
failures view name it (`Baseline: CI run #120 on feature/x`), ending with `(no run)` when it found none. The choice is
kept on this machine, per Playwright config.

## Re-run the failing tests

**Piwi: Re-run the failing tests** (**Tools → Piwi → Re-run the Failing Tests**) runs every test still failing, or
edited since its run, one command per Playwright config; when none fails, it says so. **Run this test** also sits above the reason line of
a failing test, beside **Screenshot** and **Trace**.

## The status bar

The latest complete run on the branch: how many tests passed, failed and were flaky, or what still fails and what your
local runs fixed (`2 failing · 1 fixed locally`). While a run started from this editor, or another run of the branch,
is in progress, the item counts it instead (`4/9 · 1 failing · your run`) and returns to the latest run when it ends.

Click it to read the latest run and its failures again (**Piwi: Refresh the latest run**), without the indexes **Piwi:
Refresh** fetches. The tooltip holds the run's counts, the baseline, your local runs since, the run in progress, and
when the run was read (`Updated 12 s ago · live` while the event stream is connected, `· read every minute` without it).
In VS Code it ends with **Open run #120**, **Open in dashboard**, **Compare with…** and **Connect**; in a JetBrains IDE,
**Tools → Piwi → Open the Latest Run in the Dashboard**, also in the Piwi tool window's toolbar, opens the run. When the
extension is not connected, the item says why, and a click runs **Piwi: Connect**, or retries an
[unreachable instance](./editor-connection#an-unreachable-instance).

## Related

- [Editor extensions](./editors): what the editor shows from your suite.
- [Editor connection](./editor-connection): the instance the editor reads, and its key.
- [Test selection](/features/test-selection): the saved selections **Run selection…** runs.
