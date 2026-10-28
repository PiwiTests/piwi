---
title: Pause and step from the editor
description: "Pause a test run Piwi started from VS Code or a JetBrains IDE, or one you started in a terminal, step it call by call, run it to the cursor, resume, finish or end it, with the paused line marked in the editor, your breakpoints applied as you change them, and a headless test's page shown as an image you pick a locator on."
lang: en-US
---

# Pause and step from the editor

<Needs reporter fixtures />

A test run the [editor extensions](./editors) start can be paused, stepped and resumed from the editor, with Piwi's own
commands: no debug session starts, and the IDE's debugger works as usual beside it; so can
[one you start in a terminal](./terminal-runs). The editor marks the line the test stopped at, as a debugger does, and
the breakpoints you set or remove reach the run while it goes on. The [pause bar](./editor-breakpoints#pause-a-run) in
the page answers the same stops, as does Piwi Picker's [Runs window](./runs-window). At a stop, the editor also writes
code from the page: [Code from a pause](./editor-stop-code).

## The controls

| Control | What it does | VS Code | JetBrains IDEs |
|---|---|---|---|
| **Pause** | Stops a running test before its next call that acts on, reads or checks the page | none | Resume Program's, `F9` |
| **Resume** | Runs the stopped test on to the next breakpoint | `F5` | Resume Program's, `F9` |
| **Step** | Runs the call and stops before the next one, breakpoint or not | `F10` | Step Over's, `F8` |
| **Run to cursor** | Stops at the first call on the cursor's line, or at a breakpoint before it | `Ctrl+F10` | Run to Cursor's, `Alt+F9` |
| **Finish** | Runs the test on without stopping at a breakpoint again in this attempt | `Shift+F11` | Step Out's, `Shift+F8` |
| **End the test** | [Skips the rest of the test](./end-the-test), the stopped call included | none | none |
| **Stop** | Ends the run's process | `Shift+F5` | the Run tool window's Stop |

The keys are the IDE's own debugger keys (in a JetBrains IDE, your keymap's), Piwi's only while their control applies
and no debug session runs, and first where a JetBrains keymap gives one to another action too. On
macOS, `Cmd+F10` runs to the cursor in VS Code. **Pause** and **End the test** have no key in VS Code: bind one in
**Preferences: Open Keyboard Shortcuts** (search `piwi`). There, `F5` pressed again within two seconds of an answer
waits for the next stop rather than start a debug session.

- **In VS Code**, the controls sit in the status bar beside the run's progress: **Pause** and **Stop** while the test
  runs (`Pausing…` until it stops), **Resume**, **Step**, **Finish**, **End the test** and **Stop** while it is stopped.
  The palette has them while they apply (**Piwi: Pause the run** and its kin), and **Piwi: Show the paused page**.
- **In a JetBrains IDE**, they are under **Tools → Piwi**, enabled while they apply, and first in the status bar
  item's menu, which reads `Piwi: paused · checkout.page.ts:12` while a test is stopped.

**Pause** stops every run Piwi started in this window (in a JetBrains IDE, this project), each worker before its next
call that Playwright's debugger stops at ([which calls](./editor-breakpoints#limits)): a long call or a `waitForTimeout`
finishes first, and a worker between tests stops at the next test's first call. A test that never stops, under CI or
Playwright's own debugger, says why.

## Where the test stands

When a test stops, at a breakpoint, after **Step** or **Pause**, on the line it was run to, at `page.pause()`, or at
[a failure](./editor-stop-code#a-failure), the editor opens the file of the call about to run, with the cursor on its
line, and marks it:
an arrow in the gutter, the debugger's execution point color, and above it the call, as Playwright names it, with the
controls:

`Paused · Fill "MORNING10" getByLabel('Coupon code') · attempt 2`  Resume  Step  Run to cursor  Finish  End test

`attempt 2` shows on a retry. In VS Code the line is a CodeLens, the marked line's hover holding the controls;
the color is `piwi.executionPointBackground`. In a JetBrains IDE the line is an inlay whose words are links,
the arrow's click lists the controls, and the color is **Settings → Editor → Color Scheme → Piwi → Line a run is
stopped at**. The mark goes when the test goes on (from the editor or the bar), ends, or closes its page.

<figure>
  <img src="/screenshots/vscode-run-control.png" alt="VS Code: a test paused at a page object's line, the controls above it and in the status bar">
  <figcaption>A run paused before it types the coupon.</figcaption>
</figure>

With several workers stopped, each has its own mark, and the controls above a line act on its worker; a key or command
acts on the one at the cursor's line, else asks which. A control answers the stop it was shown for: when the test went
on meanwhile, it says so and asks nothing.

The run's code is your files as they stood when it started. The mark follows lines you add or remove above it, and
**Run to cursor** in an edited file runs to the run's line for the cursor's; on a line written since, it says the test
has none.

## A headless run

A run Piwi starts with breakpoints is headed, so the pause bar answers its stops too. One started without runs as its
config says, headless by default: when you pause it, or it reaches a breakpoint set since, no bar shows, and the editor
shows an image of the page at the stop: in VS Code in a **Piwi: paused page** tab beside the editor, in a JetBrains IDE
in the Piwi tool window's **Paused Page** tab. **Piwi: Show the paused page** (**Tools → Piwi → Show the Paused Page**)
asks for it at any stop.

With a reporter newer than 0.61.0, the image says **Click the image to pick a locator**. A click picks the element
under it, as the bar's **Pick a locator** does, without touching the page: its locator replaces the one on the stopped
line, and the tab says so, or why not. In VS Code, a script in the tab sends the editor the click's position alone.

A stop counts as one at the bar: the test's duration leaves it out, and the dashboard's timelines draw it as a
**Paused** band, with [why it stopped](./editor-breakpoints#pause-a-run).

## Breakpoints while the run goes on

A breakpoint you add, remove, enable or disable applies to the run from its next call, in each of its workers, those
Playwright starts after a failure included. One that only moves because you edited the lines above it keeps the line the
run has, and one you set in an edited file applies to that line of the run's code. The breakpoints that count are those
a run's start reads: line breakpoints in script files under a Playwright config's folder, while `piwi.breakpoints`
(**Pause the runs Piwi starts at the editor's breakpoints** in a JetBrains IDE) is on.

## How it works

<figure>
  <img src="/diagrams/run-control.svg" alt="A test run's workers report to the editor service through the run channel, which the IDE and Piwi Picker (over a WebSocket) steer; the pause bar shows in the test's browser only at a stop">
</figure>

With a reporter newer than 0.59.0, each worker of a run Piwi starts stays connected to the editor service while it runs,
through a socket on your machine that only you can read, named in the run's environment as `PIWI_RUN_CHANNEL`. The
worker says which test it runs and where it stops; the editor answers with the controls. Stopping the editor service, or
closing the IDE, closes the connections: a stop with no pause bar then goes on, and one the bar shows waits there for
its answer.

## Limits

- **Runs Piwi can follow.** A run started by the IDE's own Playwright run configuration has no controls in the editor;
  with **Run the tests in the IDE's Playwright runner** on, a JetBrains IDE's runs keep them, their Rerun, Rerun Failed
  Tests and Debug included.
- **No mark on a breakpoint that never stops.** A breakpoint on a line with no Playwright call, or only calls
  Playwright's debugger never stops at, looks like any other and does nothing.
- **Playwright calls, not JavaScript.** **Step** goes from one Playwright call to the next; stepping through the
  test's own code stays with the IDE's debugger.
- **A still image.** It does not follow the page: the [Runs window](./runs-window#watch-live) shows it live.
- **No image when the page is unknown.** A stop at a call other than a locator's (a navigation, a key press) in a
  browser context with several pages has no image, and refuses Piwi Picker's **Pick** and **Record**: the worker
  cannot tell its page. Any page of that context closing ends it.

## Related

- [Breakpoints in the browser](./editor-breakpoints): the breakpoints a run starts with, and the pause bar.
- [Runs from the editor](./editor-runs): the commands that start a run, and how the editor follows it.
- [Debug in my editor](./debug-in-editor): such a run, started from a failure's page.
- [Editor extensions](./editors): what the editor shows from your suite, in both editors.
- [Remote development](/guide/remote-development): remote windows and JetBrains Gateway.
