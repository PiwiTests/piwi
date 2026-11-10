---
title: Watch a Playwright run
description: "Follow a Playwright run while it goes, in the same words in every Piwi tool: its number and page on the instance, where a test stopped and why, and how far it is in the editors and the Runs window."
lang: en-US
---

# Watch a run

<Needs reporter />

A run that reports to a Piwi instance has one number there, `#78`, and one page. Every tool that shows the run while it
goes names it by that number, links that page, and says how far the run is and where a test stopped in the same words,
so a run started in VS Code reads the same in the terminal, in Piwi Picker's Runs window and on the dashboard.

## The run's number and page

The reporter learns the run's number as the run starts: from the global setup that registered it, else as its stream
to the instance opens. It prints the page once, and tells it to the editor or the desktop app that follows the run.
The page is under the instance's public address when the instance sets `PIWI_SITE_URL`, else under the address the
reporter reached it at. A tool links it only on this machine or under an instance it connects to itself: in an editor,
the instance of a Playwright config of the window; in the desktop app, the team instance whose run requests it takes. A
page elsewhere, which the test's own code could name, is not shown, and the run reads as one with no number.

| Where | What it shows |
|---|---|
| The terminal | `[Piwi Dashboard] View live progress: https://piwi.example.com/test-runs/78`, once, as the run starts |
| VS Code | The run-control item: `#78 · 3 of 9`, its tooltip **Open run #78**; the status bar item, while your run goes: **Open run #78 (running)** first in its tooltip; **Piwi: Open the run page** and **Piwi: Open the run in progress** in the Command Palette |
| JetBrains IDEs | The status bar item: `Piwi: run #78 · 3 of 9`, kept beside a stop or a share; **Open Run #78** in its menu; **Open Run #78 (Running)** in place of **Open the Latest Run in the Dashboard** while it goes |
| Piwi Picker's [Runs window](./runs-window) | **Run #78**, **Open** and **Copy link** on the run's card, while it runs and after it ended, with its progress and how it ended |
| The desktop app's [Local runs tray](./desktop-runs) | **Run #78 · Open** under each run of its hub, a run a team instance asked for included, whose page opens in the browser; **Open run #78** on a run the app's own server holds |
| **Debug in my editor** | Once the editor runs the test: "Following run #81 in VS Code · Open" beside the button |

A run that reports to no instance, or that runs with `streaming: false` and no global setup, has no number until its
results are sent, and the tools show it without one.

## How far it is

The reporter's own process tells the editor or the desktop app how many tests the run holds, how many ended and how,
and how the run ended with its first failure. The editors' status bars and the Runs window count it the same way: each
test once, by its last attempt. The desktop tray counts the lines of the run's output instead, a retry again.

In VS Code, a run in progress that is not yours, a CI run or a teammate's on your branch or on the branch your results
are compared with, names itself so: the status bar says `CI run #125` or `run #126`, and the Testing view shows it as
`Piwi: CI run #125 on main`, its tests' results as they end, never as your tests running. Your own run stays in the status bar whichever Playwright config the
active file belongs to.

## Where a test stopped

A test of a run on your machine stops at a breakpoint, after a step, at a Pause, at the line it was run to, or at
`page.pause()`. Every tool says why in the same words:

- **Stopped at a breakpoint**
- **Stopped after a step**
- **Paused**
- **Stopped at the line it ran to**
- **Stopped at page.pause()**
- **Stopped**, for a reason a newer reporter names

A stop an agent asked for reads **Paused by the agent** in the editors. A failure held for a look says how the test
failed instead. The run page shows the stop on the test's row ([stops, shared or not](./share-live#stops-shared-or-not)),
the editors above the stopped line, the Runs window on the worker, and the terminal on a line of its own:

```text
[piwi] Stopped at a breakpoint at tests/cart.spec.ts:12 before Click: Resume, Step or Finish in Visual Studio Code.
```

The line names the editor that steers the run, or the desktop app. After you edit the file at a stop, the Runs window
names the stopped line where it stands now, as the editor does.

## The terminal's lines

A run prints one line for its page, and one when it follows an editor
([runs started outside Piwi](./terminal-runs)). A run whose output goes to a file or a pipe follows no editor and
says so, once, when an editor's workspace holds it:

```text
[Piwi Dashboard] Not following this run in Visual Studio Code (pid 41230): its output goes to no terminal. PIWI_EDITOR=on follows it.
```

The other lines of a run's start (its project and Playwright version, its shard, the stream opening on time) are
printed with `PIWI_VERBOSE=true` alone. A stream that opens late, a failure link and a warning are always printed.

## When the run does not reach the instance

When a run the editor started ends without reaching the instance, the editor says which of two things happened: its
reporter ran but sent nothing (its lines in the run's output say why: the server address, the key, or an instance that
refused it), or the Playwright config has no Piwi reporter.

## Related

- [Live view of a run](./live-view): watch a running test's page from its run page
- [Share a run live](./share-live): let a teammate watch a run on your machine
- [Runs window](./runs-window): follow and steer the editor's runs from Piwi Picker
- [Pause and step from the editor](./editor-run-control): the controls at a stop
- [Concepts](/guide/concepts#run-number): the words used here
