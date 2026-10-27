---
title: Runs from the editor
description: "Run Playwright tests from VS Code or a JetBrains IDE and follow the run in the status bar: the editor reads its results within a second of its end, lays them over the latest CI run's failures, and says when a run never reached the instance."
lang: en-US
---

# Runs from the editor

The [editor extensions](./editors) run your tests where you edit them, then show what the run changed: its progress
in the status bar while it executes, and its results over the latest CI run's [failures](./editor-failures) within a
second of its end.

## Run tests

- The lines above a locator line, an application file or a page file (CodeLens in VS Code, Code Vision in a JetBrains
  IDE) run the tests they name when clicked; those of a server file record its
  [coverage](./editor-coverage#refresh-the-marks-with-a-local-run).
- **Piwi: Run the test at the cursor** (`Ctrl+Shift+Alt+K`, `Cmd+Shift+Alt+K` on macOS) runs the test whose
  `test(…)` call holds the cursor, and **Piwi: Run this spec** the spec's tests Piwi knows; both in the editor's
  context menu of a spec (**Run the Test at the Caret** and **Run This Spec** in a JetBrains IDE). In VS Code, **Run**
  in the hover of a test's line runs that test, and so does [the Testing view](#the-testing-view-vs-code). A test the instance does not know yet, such as one you just
  [recorded](./editor-recording#run-it-or-verify-it-three-times), runs by the line of its `test(…)` call
  (`npx playwright test tests/checkout.spec.ts:42`), with or without an instance. Both save the spec first.
- **Piwi: Verify the test at the cursor ×3** (**Verify the Test at the Caret ×3**) runs that test three times, without
  retries and without the breakpoints (`--repeat-each=3 --retries=0`), and says how many of the runs passed:
  [When your run ends](#when-your-run-ends).
- **Piwi: Run the tests that reach this file** runs every test reaching the active file through
  [code reach](/features/code-reach); also in the editor's context menu.
- **Piwi: Run selection…** runs a saved [selection](/features/test-selection).

The command, `npx playwright test` with the arguments `piwi run` would pass, runs from the Playwright config's
folder: as a task in VS Code, in a terminal of its own (**Tasks: Rerun Last Task** starts it again), in the Run tool
window in a JetBrains IDE (**Rerun** starts it again), or in the IDE's Playwright runner (test tree, Debug, **Rerun
Failed Tests**), a choice of **Settings → Tools → Piwi**. It sets `PIWI_ORIGIN=editor` and its own `PIWI_ORIGIN_REF`
([run origin](/reference/test-metadata#run-origin)), by which the editor finds its run. Breakpoints pause it in the
browser, with Piwi's picker one click away: [Breakpoints in the browser](./editor-breakpoints); the editor pauses,
steps and resumes it too: [Pause and step from the editor](./editor-run-control).

## The Testing view (VS Code)

VS Code's Testing view lists Piwi's tests: the specs your instance knows, as they stand in the editor, under their
folders and `test.describe` blocks, each test with its latest result, and for a failure why and where it failed
(**Peek Error**). The results are published as a test run (`Piwi: run #120 on main`) when the latest run, its baseline
or the runs laid over it change, and a run in progress is a test run of its own, each test shown as it begins and
ends. The view's gutter shows each test's result in place of Piwi's icon; the line keeps Piwi's hover.

<figure>
  <img src="/screenshots/vscode-testing.png" alt="VS Code: the Testing view lists the spec's tests with their latest results, and a failing test's error is peeked at its line in the spec">
  <figcaption>The Testing view with the latest run's results, and why <strong>pays by card</strong> failed, at its line.</figcaption>
</figure>

**Run with Piwi**, the view's run profile, runs the tests you pick as the commands above do, one command per
Playwright config with your breakpoints, and **Verify ×3 with Piwi** runs them three times. A test the run gave Piwi no
result for, such as one the instance does not know yet, passes when the command exited with 0 and is an error
otherwise. The view shows results; it does not discover tests nor debug them: a spec the instance has not seen joins
the tree once you open it. The `piwi.testExplorer` setting turns the view's Piwi tests off.

## Re-run the failing tests

**Piwi: Re-run the failing tests** (`Ctrl+Shift+Alt+F`, `Cmd+Shift+Alt+F` on macOS; **Tools → Piwi → Re-run the
Failing Tests**) runs every test still failing, or edited since its run, one command per Playwright config, or those
of one config from its node in the [failures view](./editor-failures#the-failures-view); when none fails, it says so.

## After a run

The editor listens to the instance's event stream: within a second of a run of the project ending, it reads the
branch's latest run and its failures again, and every five minutes with the stream, every minute without. A checkout
or a commit is noticed within seconds: the editor reads the branch's latest run again, and compares your application
files with the new `HEAD`.

A run started from the editor is its own wherever it runs: the status bar follows it, the gutter shows each test as
running, then its result, and its failures read *your run #124* once it ends. When the command ends and no run on the
instance carries its ref, the editor says so: `The run ended (exit code 1) but did not reach
https://piwi.example.com: is the Piwi reporter in the Playwright config?` The editor learns the command's end and its
exit code from the process it started, in every shell, a rerun included.

## When your run ends

Once a run you started from the editor ends and the editor has read it, a notification (a balloon in a JetBrains IDE)
says what it changed: `Piwi: run #124 · 1 of 3 CI failures fixed, 2 still failing (login.spec.ts › logs in,
checkout.spec.ts › pays)`, then the tests it failed that were not failing before. It offers **Open the failures**,
**Open in dashboard** and, when something fails, **Re-run failing**. The `piwi.runNotifications` setting (**Settings →
Tools → Piwi** in a JetBrains IDE) shows it always, only when something fails, or never.

A verification (**Verify ×3**) says how many of its runs passed instead, whatever the setting: `Piwi: run #124 ·
Passed 3 of 3`, or `Failed 1 of 3`. Each run is a result of its own on the instance, and the editor counts them from
the results the run streams as it executes; when it missed some, a failing verification says `Failed at least 1 of 3`.
When its run never reached an instance, the exit code says it: `Passed 3 of 3: tests/checkout.spec.ts:42`, or
`Failed at least 1 of 3: tests/checkout.spec.ts:42 (exit code 1)`.

## The status bar

The latest complete run on the branch: how many tests passed, failed and were flaky, or what still fails and what your
local runs fixed (`2 failing · 1 fixed locally`). While a run started from this editor, or another run of the branch,
is in progress, the item counts it instead (`4/9 · 1 failing · your run`) and returns to the latest run when it ends.

With several Playwright configs, the item speaks for the config of the file you are editing, the deepest config folder
that holds it, and follows you from file to file; outside every config folder, it shows the first connected config.
Its tooltip names the config (`The active file's Playwright config, in apps/admin (one of 3)`), then holds the run's
counts, the baseline, your local runs since, the run in progress, and when the run was read (`Updated 12 s ago · live`
while the event stream is connected, `· read every minute` without it).

In VS Code, a click reads the latest run and its failures again (**Piwi: Refresh the latest run**), without the
indexes **Piwi: Refresh** fetches, and the tooltip ends with **Open run #120**, **Open in dashboard**, **Compare
with…** and **Connect**. When the extension is not connected, the item says why, and a click runs **Piwi: Connect**,
or retries an [unreachable instance](./editor-connection#an-unreachable-instance).

In a JetBrains IDE, an icon before the text shows the state of the run the item counts (running, failing, passed) or
of the connection, and the text takes the theme's error color while tests of that run fail, a run in progress
included. A click opens a menu of the **Tools → Piwi** actions that apply, led by what the item calls for: **Read the
Latest Run Again**, **Refresh** for an unreachable instance, **Connect…** while not connected, **Node.js Settings…**
when Node.js is missing or too old, or **Go to the Recorded Lines** while a recording runs, with **Pause Recording**,
**Resume Recording** and **Stop Recording**.

## Related

- [Failures in the editor](./editor-failures): the failures a run leaves, at their lines and in the failures view.
- [Editor extensions](./editors): what the editor shows from your suite.
- [Editor connection](./editor-connection): the instance the editor reads, and its key.
- [Test selection](/features/test-selection): the saved selections **Run selection…** runs.
