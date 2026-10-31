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
the breakpoints you set or remove reach the run while it goes on. The [pause bar](./editor-breakpoints#pause-a-run) in
the page answers the same stops, as does Piwi Picker's [Runs window](./runs-window). At a stop, the editor also writes
code from the page: [Code from a pause](./editor-stop-code).

## The controls

| Control | What it does | VS Code | JetBrains IDEs |
|---|---|---|---|
| **Pause** | Stops a running test before its next call that acts on, reads or checks the page | none | Resume Program's, `F9` |
| **Resume** | Runs the stopped test on to the next breakpoint | `F5` | Resume Program's, `F9` |
| **Step** | Runs the call and stops before the next one, breakpoint or not | `F10` | Step Over's, `F8` |
| **Run to cursor** | Stops at the first call on the cursor's line (on a statement broken over lines, at its call), or at a breakpoint before it | `Ctrl+F10` | Run to Cursor's, `Alt+F9` |
| **Finish** | Runs the test on without stopping at a breakpoint again in this attempt | `Shift+F11` | Step Out's, `Shift+F8` |
| **End the test** | [Skips the rest of the test](./end-the-test), and a stopped locator call from Playwright 1.62 | none | none |
| **Stop** | Ends the run's process | `Shift+F5` | the Run tool window's Stop |

The keys are the IDE's own debugger keys (in a JetBrains IDE, your keymap's), Piwi's only while their control applies
and no debug session runs, and first where a JetBrains keymap gives one to another action too. On macOS, `Cmd+F10`
runs to the cursor in VS Code. **Pause** and **End the test** have no key in VS Code: bind one in
**Preferences: Open Keyboard Shortcuts** (search `piwi`). There, `F5` pressed again within two seconds of an answer
waits for the next stop rather than start a debug session.

- **In VS Code**, the controls sit in the status bar beside the run's progress while they apply (`Pausing…` until a
  paused test stops), and in the palette (**Piwi: Pause the run** and its kin, **Piwi: Show the paused page**).
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
  <img src="/screenshots/vscode-run-control-hover.png" alt="VS Code: a test paused at a page object's line, its hover naming the call that runs next with Resume, Step, Run to cursor and Finish, the same controls above the line and in the status bar">
  <figcaption>A run paused before it types the coupon.</figcaption>
</figure>

With several workers stopped, each has its own mark, and the controls above a line act on its worker; a key or command
acts on the one at the cursor's line, else asks which. A control answers the stop it was shown for: when the test went
on meanwhile, it says so and asks nothing.

The run's code is your files as they stood when it started. The mark follows lines you add or remove above it, and
**Run to cursor** in an edited file runs to the run's line for the cursor's; on a line written since, it says the test
has none.

## A headless run

A run Piwi starts with breakpoints is headed, with a pause bar. Without breakpoints it follows your config, headless
by default. A headless stop opens **Piwi: paused page** beside VS Code's editor, or **Paused Page** in the JetBrains
Piwi tool window. **Piwi: Show the paused page** (**Tools → Piwi → Show the Paused Page**) opens it at any stop.

<figure>
  <img src="/screenshots/vscode-run-control-paused-page.png" alt="VS Code: a headless test paused before it clicks Apply, and beside the editor the Piwi: paused page tab showing the cart page with the coupon typed in">
  <figcaption>A headless run paused before it clicks Apply: the page at the stop, beside the editor.</figcaption>
</figure>

Clicking the image picks a locator when the reporter supports it, on Playwright 1.60 or later: the locator replaces
the one on the stopped line, and the tab shows the result or refusal.

**Watch live** updates the paused page in the same tab. Choose **Interact** separately to click, scroll or type on
the page; **Escape** releases the keyboard, and **Shift+click** picks a locator. Watching stops when you hide or close
the tab, resume the test or switch stops. Interact starts off at each stop. No Picker installation, pairing, project
live-view setting or extra port forwarding is needed: the preview uses the editor's existing connection. Reporters
without live-view support keep the still image.

## Breakpoints while the run goes on

A breakpoint you add, remove or toggle applies to the run from its next call, in each of its workers, later ones
included. One that only moves because you edited the lines above it keeps the line the run has, and one you set in an
edited file applies to that line of the run's code. The breakpoints that count are those a run's start reads: line
breakpoints in script files under a Playwright config's folder, while `piwi.breakpoints` (**Pause the runs Piwi starts
at the editor's breakpoints** in a JetBrains IDE) is on. A logpoint, or a breakpoint that does not suspend, never stops
the test; a condition is not read, so a conditional breakpoint stops at each pass.

## Share live

**Share live** lets a teammate watch the run from its page on your team's instance: **Piwi: Share the run live on the
team instance** in VS Code, **Tools → Piwi → Share the Run Live** in a JetBrains IDE, any time. It first says what goes
out and to whom (once a VS Code window, once a JetBrains project); shared, the status bar counts its views, until
**Stop sharing**: [Share a run from your machine](./live-view#share-a-run-from-your-machine).

## How it works

<figure>
  <img src="/diagrams/run-control.svg" alt="A test run's workers report to the editor service through the run channel, which the IDE and Piwi Picker (over a WebSocket) steer; the pause bar shows in the test's browser only at a stop">
</figure>

With a reporter newer than 0.59.0, each worker of a Piwi run stays connected to the editor service, through a socket on
your machine only you can read (`PIWI_RUN_CHANNEL`): it says which test it runs and where it stops, and the editor
answers. Closing the IDE closes the connections: a stop with no pause bar then goes on, one the bar shows waits there.

## Limits

- **The IDE's own runs** (the gutter's Run, a run configuration) are [runs started outside Piwi](./terminal-runs): no
  Stop, and no Pick, Record or Assert in the test's window. With **Run the tests in the IDE's Playwright runner** on,
  Piwi's commands run there with every control, the runner's Rerun and Debug included.
- **No mark on a breakpoint that never stops.** One on a line with no call Playwright's debugger stops at looks like
  any other and does nothing.
- **Playwright calls, not JavaScript.** **Step** goes from one Playwright call to the next; stepping through the
  test's own code stays with the IDE's debugger.
- **No image when the page is unknown.** A stop at a call other than a locator's (a navigation, a key press) in a
  browser context with several pages has no image, and refuses Piwi Picker's **Pick** and **Record**: the worker
  cannot tell its page. Any page of that context closing ends it.

## Related

- [Breakpoints in the browser](./editor-breakpoints): the breakpoints a run starts with, and the pause bar.
- [Runs from the editor](./editor-runs): the commands that start a run, and how the editor follows it.
- [Debug in my editor](./debug-in-editor): such a run, started from a failure's page.
- [Editor extensions](./editors): what the editor shows from your suite, in both editors.
- [Remote development](/guide/remote-development): remote windows and JetBrains Gateway.
