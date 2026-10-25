---
title: Pause and step from the editor
description: "Pause a test run Piwi started from VS Code or a JetBrains IDE, step it call by call, run it to the cursor, resume or finish it, with the paused line marked in the editor, your breakpoints applied as you change them, and a headless test's page shown as an image."
lang: en-US
---

# Pause and step from the editor

<Needs reporter fixtures />

A test run the [editor extensions](./editors) start can be paused, stepped and resumed from the editor, with Piwi's
own commands: no debug session starts, and the IDE's debugger works as usual beside it. The editor marks the line the
test is stopped at as a debugger marks its execution point, and the breakpoints you set or remove reach the run while
it goes on. The [pause bar](./editor-breakpoints#pause-a-run) in the page answers the same stops.

## The controls

| Control | What it does | VS Code | JetBrains IDEs |
|---|---|---|---|
| **Pause** | While a test runs: stops it before its next call that acts on, reads or checks the page | `F6` | Resume Program's, `F9` |
| **Resume** | Runs the stopped test on to the next breakpoint | `F5` | Resume Program's, `F9` |
| **Step** | Runs the call and stops before the next one, breakpoint or not | `F10` | Step Over's, `F8` |
| **Run to cursor** | Stops at the first call on the cursor's line, or at a breakpoint before it | `Ctrl+F10` | Run to Cursor's, `Alt+F9` |
| **Finish** | Runs the test on without stopping at a breakpoint again in this attempt | `Shift+F11` | Step Out's, `Shift+F8` |
| **Stop** | Ends the run's process | `Shift+F5` | the Run tool window's Stop |

The keys are the IDE's own debugger keys: VS Code's defaults, and in a JetBrains IDE the shortcuts of those debugger
actions in your keymap (the default keymap's shown). They are Piwi's only while a run Piwi started is stopped or
running and no debug session runs; the rest of the time they do what they always do. On macOS, `Cmd+F10` runs to the
cursor in VS Code. **Preferences: Open Keyboard Shortcuts** (search `piwi`) changes them in VS Code.

- **In VS Code**, the controls sit in the status bar beside the run's progress: **Pause** and **Stop** while the test
  runs (`Pausing…` until it stops), **Resume**, **Step**, **Finish** and **Stop** while it is stopped. The palette has
  them while they apply: **Piwi: Pause the run**, **Piwi: Resume the run**, **Piwi: Step to the next call**,
  **Piwi: Run to the cursor**, **Piwi: Finish the test without stopping again**, **Piwi: Stop the run** and
  **Piwi: Show the paused page**.
- **In a JetBrains IDE**, they are under **Tools → Piwi**, enabled while they apply, and first in the status bar
  item's menu, which reads `Piwi: paused · checkout.page.ts:12` while a test is stopped.

**Pause** stops every worker of the run, each before its next call that Playwright's debugger stops at, the calls
[Breakpoints in the browser](./editor-breakpoints#limits) lists: a long call or a `waitForTimeout` finishes first, and
a worker between tests stops at the next test's first call. A test that never stops, under CI or Playwright's own
debugger, says why.

## Where the test stands

When a test stops, at a breakpoint, after **Step** or **Pause**, on the line it was run to, or at `page.pause()`, the
editor opens the file of the call about to run, a spec or a page object, with the cursor on its line, and marks the
line: an arrow in the gutter, the debugger's execution point color, and above the line what is about to run, as
Playwright names the call, with the controls:

`⏸ Paused · Fill "WELCOME10" getByLabel('Coupon') · attempt 2`  Resume  Step  Run to cursor  Finish

`attempt 2` shows on a retry. In VS Code the line is a CodeLens, and the hover on the paused line has the same
controls; the color is `piwi.executionPointBackground`. In a JetBrains IDE the line is an inlay whose words are links,
the arrow's click lists the controls, and the color is **Settings → Editor → Color Scheme → Piwi → Line a run is
stopped at**. The mark goes as soon as the test goes on, from the editor or from the pause bar.

With several workers stopped, each has its own mark, and the controls above a line act on its worker; a key or a
command acts on the one stopped at the cursor's line, else asks which.

## A headless run

A run Piwi starts with breakpoints is headed, so the pause bar answers its stops too. One started without runs as its
config says, headless by default: when you pause it, or it reaches a breakpoint set since, no bar shows, and the
editor shows an image of the page instead, as it stood when the test stopped: in VS Code in a **Piwi: paused page**
tab beside the editor, in a JetBrains IDE in the **Paused Page** tab of the Piwi tool window. It is taken again at each
such stop; **Piwi: Show the paused page** (**Tools → Piwi → Show the Paused Page**) asks for it at any stop.

## Breakpoints while the run goes on

A breakpoint you add, remove, enable or disable applies to the run from its next call, in each of its workers and in
those Playwright starts after a failure. The breakpoints that count are those a run's start reads: line breakpoints
in script files under a Playwright config's folder, while `piwi.breakpoints` (**Pause the runs Piwi starts at the
editor's breakpoints** in a JetBrains IDE) is on. Turning the setting off lets the run go on without them.

## How it works

With a reporter newer than 0.59.0, each worker of a run Piwi starts keeps a connection to the editor service while it
runs, through a socket on your machine that the service opens, readable by you only, named in the run's environment as
`PIWI_RUN_CHANNEL`. The worker says which test it runs and where it stops; the editor answers with the controls. A run
whose connection does not open, or closes, pauses as it would without it, and a stop that nothing answers goes on when
the connection closes. Stopping the editor service, or closing the IDE, lets every stopped test go on.

## Limits

- **Runs Piwi started only.** A run started in a terminal, or by the IDE's own Playwright run configuration, has no
  controls in the editor; with **Run the tests in the IDE's Playwright runner** on, a JetBrains IDE's runs keep them.
- **No mark on a breakpoint that never stops.** A breakpoint on a line whose calls Playwright's debugger never stops
  at, or with no Playwright call, looks like any other and does nothing.
- **Playwright calls, not JavaScript.** **Step** goes from one Playwright call to the next; stepping through the
  test's own code stays with the IDE's debugger.
- **One image a stop.** The paused page is a still image, not a live view: it does not follow what you do in a
  headed browser.

## Related

- [Breakpoints in the browser](./editor-breakpoints): the breakpoints a run starts with, and the pause bar.
- [Runs from the editor](./editor-runs): the commands that start a run, and how the editor follows it.
- [Editor extensions](./editors): what the editor shows from your suite, in both editors.
