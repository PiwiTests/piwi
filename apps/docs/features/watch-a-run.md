---
title: Watch a Playwright run
description: "Follow a Playwright run while it goes, in the same words in every Piwi tool: its number and page on the instance, where a test stopped and why, and how far it is in the editors and the Runs window."
lang: en-US
---

# Watch a run

<Needs reporter />

This page follows a run while it goes, in the same words in every tool: its number and page on the instance, how far
it is, where a test stopped and why, and when a failing test is held. To see a test's page:
[Watch a running test](./watch-running-test) in your tools, [Live view of a run](./live-view) on the team instance.

## The run's number and page

A run has one number on the instance it reports to, `#78`, and one page. The reporter learns the number as the run starts: from the global setup that registered it, else as its stream
to the instance opens. It prints the page once, and tells it to the editor or the desktop app that follows the run.
The page is under the instance's public address when the instance sets `PIWI_SITE_URL`, else under the address the
reporter reached it at. A tool links it only on this machine or under an instance it connects to itself: in an editor,
the instance of a Playwright config of the window; in the desktop app, the team instance whose run requests it takes. A
page elsewhere, which the test's own code could name, is not shown, and the run reads as one with no number.

| Where | What it shows |
|---|---|
| The terminal | `[Piwi Dashboard] View live progress: https://piwi.example.com/test-runs/78`, once, as the run starts |
| VS Code | The run-control item: `#78 · 3 of 9`, its tooltip **Open run #78**; the status bar item, while your run goes: **Open run #78 (running)** first in its tooltip; **Piwi: Open the run page** and **Piwi: Open the run in progress** in the Command Palette |
| JetBrains IDEs | The status bar item: `Piwi: run #78 · 3 of 9`, kept beside a stop or a share; **Open run #78** in its menu; **Open run #78 (running)** in place of **Open the latest run** while it goes |
| Piwi Picker's [Runs window](./runs-window) | **Run #78**, **Open** and **Copy link** on the run's card, while it runs and after it ended, with its progress and how it ended |
| The desktop app's [Local runs tray](./desktop-runs) | **Run #78 · Open** under each run of its hub, a run a team instance asked for included, whose page opens in the browser; **Open run #78** on a run the app's own server holds |
| **Debug in my editor** | Once the editor runs the test: "Following run #81 in VS Code · Open" beside the button |

A run that reports to no instance, or with `streaming: false` and no global setup, has no number until its results
are sent.

## How far it is

The reporter's own process tells the editor or the desktop app how many tests the run holds, how many ended and how,
and how the run ended with its first failure. The editors' status bars and the Runs window count it the same way: each
test once, by its last attempt. The desktop tray counts as the run's own process does ([Local runs tray](./local-runs-tray#each-run)).

On the dashboard, Home's **Recent activity**, a project's runs list and the **Projects** page show a running run with
the count bar and how many results are in: `120 of 400 · 2 failed`. Its row moves on by itself as results reach the
instance, at most every 2 seconds, without the page reading the list again. Until the run ends these count each result
as the reporter sends it, a retry again; the run's page counts each test once.

The status bar item's tooltip also says what each worker runs now (`Worker 2 · cart › adds a mug · stopped`). In VS
Code, the Testing view's test run of your run writes in its output each test a worker starts, each stop and why, with
the line it stands at, and each stop answered.

A run in progress that is not yours, a CI run or a teammate's, shows read-only:
[A CI run of your branch](./watch-running-test#a-ci-run-of-your-branch).

## Where a test stopped

A test of a run on your machine stops at a call and waits to be answered: at a breakpoint, after a step, at a Pause,
at the line it was run to, at `page.pause()`, or at a failure [held](#hold-failures) for a look. Every tool says why in
the same words:

- **Stopped at a breakpoint**, **Stopped after a step**, **Paused**, **Stopped at the line it ran to**, **Stopped at
  page.pause()**, and **Stopped** for a reason a newer reporter names;
- **Held at its failure**, then how the test failed (**Failed at** and its place in the Runs window and the desktop
  app's tray);
- at a stop an agent asked for, **Paused by the agent**, **Stopped after the agent's step** or **Stopped at the line
  the agent ran it to**.

The editors show it above the stopped line, the Runs window and the desktop app's tray on the worker, and the
terminal on a line naming the editor, or the desktop app, that steers the run:

```text
[piwi] Stopped at a breakpoint at tests/cart.spec.ts:12 before Click: Resume, Step or Finish in Visual Studio Code.
```

Edit the file at a stop, and the Runs window names the stopped line where it stands now, as the editor does.

**On the run's page**, the test's row says why, at the stopped call, whose place opens in your editor. A shared run
tells it from its [live view](./live-view); a run nobody shares, as text with `@piwitests/reporter` 0.68.0 or later:
the call's title, its file and line, the test's title and since when, as each stop shows and ends, never an image, the
row saying for how long once it has stood a minute. A stopped test is never marked [**Stuck?**](./stuck-tests).

At a stop of a headed run, every tool offers **Show the browser**, which brings the test's window to the front where
your system allows: **Piwi: Show the stopped test's browser** in VS Code and the stop's hover, **Tools → Piwi →
Show the stopped test's browser** in a JetBrains IDE, and a button in the Runs window and the desktop app's tray. A
headless run has none to show, nor does an older reporter.

### Hold failures

**Hold failures** decides, for one run, whether a failing test waits at its line. Held, the test keeps its page once
its function, hooks and fixtures are done, at the line where the error entered its code, else the failing locator's,
else the call a test timeout cut short. **Resume**, **Step** and **Finish** let it end as it failed; **Pick** and
**Record** fix it there ([Code from a pause](./editor-stop-code#a-failure)). Each failing attempt is held once, an
expected failure never. Piwi's evidence is the page at the failure: the requests, console entries and dialogs of the hold
are not recorded, while Playwright's trace and video go on.

Headed or headless, it is off unless turned on; off, a failure goes on at once, as without Piwi:

- **From the run's start** in a run with the editor's breakpoints or a spec's `page.pause()`, a
  [debug run](./debug-in-editor), a desktop app's reproduction, a run an agent starts (`run_start`, until two minutes
  after its last call), or one whose start options choose it ([editor](./editor-runs#how-a-run-starts),
  [desktop app](./desktop-runs#each-worker)).
- **While it runs**, from any tool that follows it: the editors (**Piwi: Turn hold failures on or off for the run**,
  **Tools → Piwi → Turn hold failures on** or **off**), the switch on each run of the Runs window, the desktop app's
  tray and Piwi Runner, or an agent (`run_follow`). Each tool shows it as the last one set it. Turned off, a held
  failure no pause bar shows goes on.
- **Never** in a run nobody attends: a Flake Lab run, a bisect, a lab job, **Verify ×3**, a fix plan's verification, a
  Flake Lab line, a terminal run whose output goes to a file or a pipe, `--repeat-each` above 1 without
  `--max-failures=1`, and UI mode. Their switch says why.

A run [started in a terminal](./terminal-runs) holds a failure only once you turn it on, and a held failure goes on
once no tool is left to show it.

## Share with Playwright tools

At a stop, **Share with Playwright tools** binds the test's browser for Playwright's own tools: [Pause and step from
the editor](./editor-run-control#share-with-playwright-tools).

## The terminal's lines

What a run prints in its terminal (its page, the editor or the desktop app it follows, its progress):
[Runs started outside Piwi](./terminal-runs#the-terminal-s-lines).

## When the run does not reach the instance

What the editor says of a run it started that sent nothing: [Runs from the editor](./editor-runs#after-a-run).

## Related

- [Watch a running test](./watch-running-test): a test's page, in your tools
- [Live view of a run](./live-view): a test's page, on the team instance
- [Share a run live](./share-live): let a teammate watch a run on your machine
- [Runs window](./runs-window): follow and steer your runs from Piwi Picker
- [Pause and step from the editor](./editor-run-control): the controls at a stop
