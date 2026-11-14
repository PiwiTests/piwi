---
title: Pause and step from the editor
description: "Pause and step a Playwright run from VS Code or a JetBrains IDE, follow its stopped line and watch or interact with its headless page in the editor."
lang: en-US
---

# Pause and step from the editor

<Needs reporter fixtures />

A test run the [editor extensions](./editors) start can be paused, stepped and resumed from the editor, with Piwi's own
commands: no debug session starts, and the IDE's debugger works as usual beside it; so can
[one started outside Piwi](./terminal-runs). The editor marks the line the test stopped at, as a debugger does, and
the breakpoints you set or remove reach the run while it goes on. The page's
[pause bar](./editor-breakpoints#pause-a-run) and Piwi Picker's [Runs window](./runs-window) answer the same stops. At
a stop, the editor also writes code from the page: [Code from a pause](./editor-stop-code).

## The controls

| Control | What it does | VS Code | JetBrains IDEs |
|---|---|---|---|
| **Pause** | Stops a running test before its next call that acts on, reads or checks the page | none | Pause Program's |
| **Resume** | Runs the stopped test on to the next breakpoint | `F5` | Resume Program's, `F9` |
| **Step** | Runs the call and stops before the next one, breakpoint or not | `F10` | Step Over's, `F8` |
| **Run to cursor** | Stops at the first call on the cursor's line (on a statement broken over lines, at its call), or at a breakpoint before it | `Ctrl+F10` | Run to Cursor's, `Alt+F9` |
| **Finish** | Runs the test on without stopping at a breakpoint again in this attempt | `Shift+F11` | Step Out's, `Shift+F8` |
| **End the test** | [Skips the rest of the test](./end-the-test), and a stopped locator call from Playwright 1.62 | none | none |
| **Stop** | Ends the run's process | `Shift+F5` | **Stop the run**, or the Run tool window's Stop |

The keys are the IDE's debugger keys (in a JetBrains IDE, [your keymap's](./jetbrains)), Piwi's only while their control
applies and the debugger does not take them. On macOS, `Cmd+F10` runs to the cursor in VS Code. **Pause** and **End the
test** have no key in VS Code: bind one in **Preferences: Open Keyboard Shortcuts** (search `piwi`). Within two seconds
of an answer, until that worker stops, a key answers no other worker and starts no debug session.

- **In VS Code**, the controls are in the Piwi item's menu while they apply, after **Go to the stopped line**, in the
  palette (**Piwi: Pause the run** and its kin) and the editor title (Resume, the rest under `…`).
- **In a JetBrains IDE**, they are under **Tools → Piwi**, enabled while they apply, and in the status bar item's menu,
  whose text says why and where a test stopped.

The item's line comes from the run, so it counts offline and with the desktop app
([Watch a run](./watch-a-run#how-far-it-is)); its tooltip names the other tools that have the run open.

**Pause** stops every run Piwi started in this window (in a JetBrains IDE, this project), each worker before its next
call that Playwright's debugger stops at ([which calls](./editor-breakpoints#limits)): a long call or a `waitForTimeout`
finishes first, unless you [end the test there](./end-the-test#while-a-pause-waits-for-a-call), and a worker between
tests stops at the next test's first call. A test that never stops, under CI or
Playwright's own debugger, says why.

## Where the test stands

When a test stops, at a breakpoint, after **Step** or **Pause**, on the line it was run to, at `page.pause()`, or at
[a failure](./editor-stop-code#a-failure), the editor opens the file of the call about to run, with the cursor on its
line, and marks it:
an arrow in the gutter, the debugger's execution point color, and above it the call, as Playwright names it, with the
controls:

`Stopped at a breakpoint · Fill "MORNING10" getByLabel('Coupon code') · attempt 2`  Resume  Step  Run to cursor  Finish  End test

It says [why the test stopped](./watch-a-run#where-a-test-stopped); `attempt 2` shows on a retry. VS Code's CodeLens holds Resume, Step, Finish and **Write code…**, its hover all controls;
the color is `piwi.executionPointBackground`. In a JetBrains IDE the line is an inlay whose words are links,
the arrow's click lists the controls, and the color is **Settings → Editor → Color Scheme → Piwi → Line a run is
stopped at**. The mark goes when the test goes on (from the editor or the bar), ends, or closes its page.

<figure>
  <img src="/screenshots/vscode-run-control-hover.png" alt="VS Code: a test paused at a page object's line, its hover naming the call that runs next with Resume, Step, Run to cursor and Finish, and Resume, Step and Finish above the line">
  <figcaption>A run paused before it types the coupon.</figcaption>
</figure>

With several workers stopped, each has its own mark. A stop takes the cursor only on the worker you last answered or
worked on, or as the first shown while no step waits; another opens beside your editor, or, in a busy JetBrains IDE,
waits in the status bar's menu. The controls above a line act on its worker, a key or command on the one at the
cursor's line, else the only one shown, else it asks which. A control answers the stop it was shown for: when the test
went on meanwhile, it says so and asks nothing.

The run's code is your files as they stood when it started. The mark follows lines you add or remove above it, and
**Run to cursor** in an edited file runs to the run's line for the cursor's; on a line written since, it says the test
has none.

## A headless run

A run Piwi starts follows your config, headless by default, unless you choose
[**Run headed**](./editor-runs#how-a-run-starts) or an [older reporter](./editor-breakpoints#what-it-needs) needs it. A headless stop opens **Piwi: paused page** beside VS Code's editor, or **Paused page** in the JetBrains
Piwi tool window, which keeps its stop until it goes on, and after a **Step** or **Run to cursor** from the editor
waits up to 10 seconds for its next stop. **Piwi: Show the paused page** (**Tools → Piwi → Show the paused page**)
opens it at any stop.

<figure>
  <img src="/screenshots/vscode-run-control-paused-page.png" alt="VS Code: a headless test paused before it clicks Apply, and beside the editor the Piwi: paused page tab showing the cart page with the coupon typed in">
  <figcaption>A headless run paused before it clicks Apply: the page at the stop, beside the editor.</figcaption>
</figure>

Clicking the image picks a locator when the reporter supports it, on Playwright 1.60 or later: it replaces the
stopped line's, and the tab shows the result or refusal.

**Watch** updates the paused page until you hide or close the tab, resume or switch stops. Choose
[**Interact**](./watch-running-test#interact) to click, scroll or type on it; your first one drives the stop.
Interact stays on through the worker's stops, and goes off, giving the stop back, on Escape outside a pick or check,
another
[lane](/guide/concepts#worker)'s stop, a stop without input, **Watch** off or refused, the tab hidden or closed,
or the run's end. The caption names who drives and watches the stop
([driving a stop](/guide/concepts#presence-driving-a-stop)).
The preview uses the editor's connection: no Picker, pairing, live-view setting or port forwarding. Older reporters
keep the still image. To watch the test before it stops: [Watch a running test](./watch-running-test).

## Breakpoints while the run goes on

A breakpoint you add, remove or toggle applies to the run from its next call, in every worker, later ones included.
One that only moves because you edited the lines above it keeps the line the run has, and one you set in an edited file
applies to that line of the run's code. The breakpoints that count are those a run's start reads: line
breakpoints in script files under a Playwright config's folder, while `piwi.breakpoints` (**Pause the runs Piwi starts
at the editor's breakpoints** in a JetBrains IDE) is on. A logpoint, or a breakpoint that does not suspend, never stops
the test; a condition is not read, so a conditional breakpoint stops at each pass.

## How it works

<figure>
  <img src="/diagrams/run-control.svg" alt="A test run's workers report to the editor service through the run channel, which the IDE and Piwi Picker (over a WebSocket) steer; the pause bar shows in the test's browser only at a stop">
</figure>

With a reporter newer than 0.59.0, each worker of a Piwi run stays connected to the editor service, through a socket on
your machine only you can read (`PIWI_RUN_CHANNEL`): it says which test it runs and where it stops, and the editor
answers. Closing the IDE closes the connections: a stop with no pause bar then goes on, one the bar shows waits there.

## Limits

- **No mark on a breakpoint that never stops.** One on a line with no call Playwright's debugger stops at looks like
  any other and does nothing.
- **Playwright calls, not JavaScript.** **Step** goes from one Playwright call to the next; stepping through the
  test's code stays with the IDE's debugger.
- **No image when the page is unknown.** A stop at a call other than a locator's (a navigation, a key press) in a
  browser context with several pages has no image, and refuses Piwi Picker's **Pick** and **Record**: the worker
  cannot tell its page. Any page of that context closing ends it.

## Related

- [Breakpoints in the browser](./editor-breakpoints): the breakpoints a run starts with, and the pause bar.
- [Runs from the editor](./editor-runs): the commands that start a run, and how the editor follows it.
- [Share a run live](./share-live): let a teammate watch a run Piwi started, from the editor.
- [Debug in my editor](./debug-in-editor): such a run, started from a failure's page.
- [Remote development](/guide/remote-development): remote windows and JetBrains Gateway.
