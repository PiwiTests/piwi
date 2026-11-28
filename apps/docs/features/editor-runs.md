---
title: Runs from the editor
description: "Run Playwright tests from VS Code or a JetBrains IDE and follow the run in the status bar: the editor reads its results within a second of its end, lays them over the latest CI run's failures, and says when a run never reached the instance."
lang: en-US
---

# Runs from the editor

<Needs editor />

The [editor extensions](./editors) run your tests where you edit them, then show a run's progress in the status bar
and its results over the latest CI run's [failures](./editor-failures).

## Run tests

- The lines above a locator line, an application file or a page file (CodeLens in VS Code, Code Vision in a JetBrains
  IDE) run the tests they name when clicked; those of a server file record its
  [coverage](./editor-coverage#refresh-the-marks-with-a-local-run).
- **Piwi: Run the test at the cursor** (`Ctrl+Shift+Alt+K`, `Cmd+Shift+Alt+K` on macOS, another [key](/reference/editor-commands#keys) in some JetBrains keymaps) runs the test whose `test(…)`
  call holds the cursor, and **Piwi: Run this spec** every test of the spec; both in the editor's **Piwi** submenu
  on a spec and under VS Code's editor title Run button (the caret in a JetBrains IDE), saving the spec first. **Run** in VS Code's test hover runs it, as
  [the Testing view](#the-testing-view-vs-code) does. A test the instance does not know, such as one just
  [recorded](./editor-recording#run-it-or-verify-it-three-times), runs by its `test(…)` call's line,
  with or without an instance.
- **Piwi: Debug the test at the cursor** (**Debug the test at the caret**) runs it as **Debug with Piwi** does:
  headed, at [your breakpoints](./editor-breakpoints), holding each failure at its line.
- **Piwi: Verify the test at the cursor ×3** (**Verify the test at the caret ×3**) runs it three times as a
  [verification](#when-your-run-ends).
- **Piwi: Run the tests that reach this file** runs every test reaching the active file through
  [code reach](/features/code-reach); also in the editor's and file tree's **Piwi** submenu.
- **Piwi: Run a saved selection…** runs a [selection](/features/test-selection).

The command, `npx playwright test` with `piwi run`'s arguments, runs from the Playwright config's folder: as a task
in VS Code, in a terminal of its own (**Tasks: Rerun Last Task** restarts it), in the Run tool window in a JetBrains
IDE, its tests in a test tree beside the output as they run (**Rerun** restarts it), or in the IDE's Playwright runner
(Debug, **Rerun Failed Tests**), a choice of **Settings → Tools → Piwi**, offered once, that keeps every control of a
Piwi run, through the runner's Rerun and Debug too. It sets `PIWI_ORIGIN=editor` and its own `PIWI_ORIGIN_REF`
([run origin](/reference/test-metadata#run-origin)), by which the editor finds its run. Breakpoints and the editor pause it:
[Pause and step from the editor](./editor-run-control).

## How a run starts

Two choices apply to every run: **Run headed** (`--headed`, a verification included) and
[**Hold failures**](./watch-a-run#hold-failures) **Auto**, **On** or **Off** from the run's start. Auto lets Piwi
decide: on with your breakpoints or a `page.pause()`, headed for the latter.
**Piwi: Turn headed runs on or off** and **Piwi: Hold failures from each run's start…** set them (in VS Code,
`piwi.runHeaded` and `piwi.runHoldFailures`, shown in the status bar's tooltip and offered together by **Piwi: Run
options…**). A
[debug run](./debug-in-editor), a Flake Lab line and a fix plan's check leave them out.

## The Testing view (VS Code)

VS Code's Testing view lists the tests `playwright test --list --project=*` gives for each config, under their folders
and `test.describe` blocks, a test of several Playwright projects with a node per project, each with its latest result
and duration, and where and why it failed (**Peek Error**). A spec is listed again when saved, and read from its text
while you edit it. A config Playwright cannot list says why. Tests only your instance knows go in
**Not in this checkout**, which does not run. Results are published as a test run (`Piwi: run #120 on main`); a run in progress shows each test as
it begins and ends. Its gutter shows each result in place of Piwi's icon; the line keeps Piwi's hover. A flaky test
shows as passed, its line ending with _flaky_. An item is named by its test's title alone, as a screen reader reads it,
and the view's filter finds tests by `@piwi:flaky`, `@piwi:quarantined`, a Playwright tag (`@piwi:@smoke`) or an owner
(`@piwi:owner:ada`). With the view off, Piwi's gutter marks a test with no recent result with a dashed ring.

Each test's actions are one list in both editors: **Run with Piwi**, **Debug with Piwi** and **Verify ×3 with Piwi**,
**Record steps in this test…** (a [recording](./editor-recording) after the last line of its body), a failure's trace
and screenshot, **Open in dashboard**, **Copy context for agent**, then the test's Flake Lab commands. **More…** on the [test's card](./editor-test-card) opens them, and in VS Code **Piwi: Show the test's actions…**
from the Testing view's gutter and menus, and the line number's menu with the view off; in a JetBrains IDE, a
right-click on the result icon. The IDE's own run
icon offers **Run with Piwi** and **Verify ×3 with Piwi** too; turning off **Piwi test results** under **Gutter Icons**
hides the result icon and its list.

<figure>
  <img src="/screenshots/vscode-testing.png" alt="VS Code: the Testing view lists the spec's tests with their latest results, and a failing test's error is peeked at its line in the spec">
  <figcaption>The Testing view with the latest run's results, and why <strong>pays by card</strong> failed, at its line.</figcaption>
</figure>

**Run with Piwi**, the view's run profile, runs what you pick by the narrowest filter Playwright takes: a config whole, a
folder or a spec by its path, a describe block or a test by its line (a loop's by its title), a project's node, and a
test Playwright runs only when named (`default: false`), with `--project`. **Debug with Piwi** runs them headed at your breakpoints,
holding each failure, and **Verify ×3 with Piwi** three times. Under Run with Coverage, it also shows their
coverage in the Test Coverage view ([Editor coverage](./editor-coverage)). From a failed test's actions, **Debug with Piwi** runs it as [Debug in my
editor](./debug-in-editor) does, stopping once at the line it failed through. A test the run gave Piwi no result for
passes when the command exited with 0, else is an error. Debug runs Piwi's run control, not a debug session.
`piwi.testExplorer` turns the view's Piwi tests off.

## Re-run the failing tests

**Piwi: Re-run the failing tests** (`Ctrl+Shift+Alt+F`, `Cmd+Shift+Alt+F` on macOS, as [Keys](/reference/editor-commands#keys) lists; **Tools → Piwi → Re-run the
failing tests**) runs every test still failing, or edited since its run, one command per Playwright config, or those
of one config from its node in the [failures view](./editor-failures#the-failures-view); when none fails, it says so.

## After a run

Within a second of a run of the project ending, the editor reads the branch's latest run and its failures again,
told by the instance's event stream; else every five minutes with the stream, every minute without. A checkout
or a commit is noticed within seconds: the editor reads that run again and compares your application
files with the new `HEAD`.

A run started from the editor is its own wherever it runs: the status bar follows it, the gutter shows each test as
running, then its result, and its failures read _your run #124_ once it ends. The editor learns the command's end and
exit code from the process it started, in every shell, a rerun included. When no run on the instance carries its ref,
it says why: its reporter sent nothing (its lines in the output name the server address, the key, or a refusal), or
the config has no Piwi reporter: `The run ended (exit code 1) but did not
reach https://piwi.example.com: is the Piwi reporter in the Playwright config?`

## When your run ends

Once a run you started from the editor, [a terminal](./terminal-runs) (`run #125 in a terminal`) or the IDE's test
runner is read, a notification says what it changed:
`Piwi: run #124 · 1 of 3 CI failures fixed, 2 still failing (login.spec.ts › logs in, checkout.spec.ts › pays)` and new
failures, with **Open the failures**, **Open in dashboard** and **Re-run failing**. The `piwi.runNotifications` setting
(**Settings → Tools → Piwi** in JetBrains) shows it when a test fails, the default, always (a passing run then offers
**Only on failure**), or never; **Settings** opens it in VS Code.

A CI run of your branch says the same once it ends, against the run it replaced:
`Piwi: CI run #130 on feature-x · 2 fixed · 1 new failure (cart.spec.ts › adds)`. The `piwi.runNotificationsScope`
setting, **The runs it says it for** in JetBrains, keeps it to the runs you started.

A [verification](/guide/concepts#verification), **Verify ×3**, runs the test three times without retries or
breakpoints (`--repeat-each=3 --retries=0`), each run a result on the instance, and holds no failure. Its notification
says how many passed, whatever the setting: `Piwi: run #124 · Passed 3 of 3`, or `Failed 1 of 3` with **Open the
failures** and **Open in dashboard**, counted from the results the run streams (`Failed at least 1 of 3` when some
were missed), else [from its exit code](./editor-recording#run-it-or-verify-it-three-times). Like a fix plan's verification and a
Flake Lab line, it is listed, paused and stopped as any run.

## Related

- [The editor's status bar](./editor-status-bar): the latest run, the run in progress, and when the item turns red.
- [Failures in the editor](./editor-failures): the failures a run leaves, at their lines and in the failures view.
- [Editor connection](./editor-connection): the instance the editor reads, and its key.
