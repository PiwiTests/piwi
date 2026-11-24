---
title: Run on this computer
description: "The run button in the desktop app's window: a run's, an execution's, a cluster's or a test's Playwright tests run in the project's linked folder in one click, or from the run dialog with their options, beside the project's CI actions."
lang: en-US
---

# Run on this computer

<Needs desktop />

In the [desktop app](./desktop)'s window, the [run button](./ci-rerun#the-run-dialog) of a run, an execution, a
failure cluster and a test runs the page's tests in the project's linked folder, with the folder's own Playwright and
the app's bundled Node. Its dialog's **Where** lists **This computer** in place of your apps
([Run on my machine](./run-on-my-machine), which a browser offers), before the project's [CI actions](./ci-actions).
The run streams into the [Local runs tray](./local-runs-tray), keeps going while you browse, and reports to the app.

## One click

The button says what it runs, and runs it here in one click:

| Page | The button | Its other tests here |
|---|---|---|
| Run | **Re-run 3 failed tests**, else the flaky ones, else every test | The flaky tests and every test, by their files past 200 tests |
| Execution | **Re-run this test** | None: every test of its cluster runs on CI |
| Test | **Run this test**, by its title, 20 times with a trace until it fails | None: Flake Lab runs from the **Flakiness** tab |
| Failure cluster, and its Verify section | **Re-run the 2 affected tests**, as the verify command selects them | None |
| A run's **Tests** tab, tests selected | **Re-run 3 selected tests**, on this computer alone | None |

It names what differs from Playwright's defaults, and the [environment](./environments) of the run its tests come from
(**· headed · ×5 · Staging**): the run is for that environment, with its [run variables](./run-variables). For a
protected environment, the button's run is for none, and the dialog picks it.

While a run of those tests goes on, the button shows how far it is (**Running 2/3…**), then **Passed** or **Failed**
for a few seconds; a click then opens the tray, and never stops anything.

After a send to a CI action, the button reads **Run on this computer or CI** and opens the dialog on that action, until
a run here makes This computer its **Where** again. The button remembers the last one per project.

## The arrow

- **Runs this command**: what the button runs, and the tests it leaves out, those with no file path Playwright takes.
- **Run once** headless, headed, in the inspector or in UI mode, and **Run other tests**: the page's other tests.
- The one-click runs on CI, as in a browser.
- **Options of this button**: **Record trace**, [**Hold failures**](./watch-a-run#hold-failures), **Repeat each** with
  no retries, **Stop at the first failing repetition**, and **Select tests by** `file:line`, title or file. They apply
  to this button's runs until you leave the page; the project's defaults, which every button starts from, are in
  **Project → Settings → Local folder**.
- **Run with options…**, **Copy as command** (the command for your terminal, with the run variables),
  **Project defaults…**, **Local runs**, and the linked folder with **Change linked folder…**.

## The dialog

**Run with options…** opens the run dialog on This computer: **What**, **Where**, the linked folder with **Change**,
the run options with **Repeat each** up to 1,000, the environment, and the exact commands. The options start from the
button's and apply to that run alone. The environment starts on the last one picked for the folder; a protected one
asks you to confirm each run, which keeps to the tests carrying its required tags. **Run** starts the run and closes the dialog.

## When the folder is not ready

With no folder linked, none of the tests in it, or no Playwright installed, the button opens the dialog, which says
what to fix: **Choose folder…**, **Choose the right folder…** or **Re-check after installing**. A folder without the
tests still runs, since a config may put them elsewhere. The arrow lists the same fixes. With no test it can select,
the button opens the arrow, which says why.

## Limits

- **The desktop app only.** A browser has no This computer: its run button asks your own apps instead.
- **A run's tests, one test, a cluster's tests or a selection.** A project's whole suite and a Flake Lab experiment
  run on CI from the run button; Flake Lab also runs here from a test's **Flakiness** tab.

## Related

- [Desktop app](./desktop): linking a project to its folder, reproduce and bisect.
- [Local runs tray](./local-runs-tray): each run, its **Stop** and its output.
- [Desktop app runs](./desktop-runs): each worker, paused, stepped and watched live.
- [Re-run in CI](./ci-rerun): the run button and dialog on CI.
