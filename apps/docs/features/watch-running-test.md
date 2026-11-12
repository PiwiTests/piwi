---
title: Watch a running test
description: "Watch the page of a Playwright test while it runs on your machine, from VS Code, a JetBrains IDE, Piwi Picker's Runs window or the desktop app: up to ten images a second, through its next tests and stops."
lang: en-US
---

# Watch a running test

<Needs reporter fixtures />

A test that runs headless on your machine, or in a remote container, shows its page while it runs: up to ten images
a second, through its next tests and its stops, and the worker Playwright starts in its place after a failure. Choose
a worker in your editor, in Piwi Picker's Runs window or in the desktop app, and watch it work; **Pause and watch**
stops it before its next call too. It needs `@piwitests/reporter` newer than 0.67.0 and the
[capture fixtures](/guide/capture-fixtures). Nothing leaves your machine.

## Where to watch

| Where | Open it | At a stop |
|---|---|---|
| VS Code | **Piwi: Watch a worker's test**, or a click on the run's progress in the status bar: **Piwi: worker 2** beside the editor | A headless stop of the worker shows there, with **Interact** and the pick on a click, instead of the paused page |
| JetBrains IDEs | **Tools → Piwi → Watch a Worker's Test**: the **Worker 2** tab of the Piwi tool window | The tab only watches: a headless stop opens the **Paused Page** beside it, for **Interact**, unless that tab holds another stop |
| Piwi Picker | **Watch** on a worker's row of the [Runs window](./runs-window#watch-live) | The controls show above the view, and the stopped worker scrolls into view |
| Desktop app | **Watch** on a running row of its own runs, which opens the [Local runs](./desktop-runs#watch-live) tray on it | The tray shows the stopped worker, behind its tab in a run of several |

**Pause and watch** is **Piwi: Pause and watch a worker's test** in VS Code, **Tools → Piwi → Pause and Watch a
Worker's Test** in a JetBrains IDE, and a button beside **Watch** in the Runs window and the desktop app. With several
workers to choose from, the editor asks which.

## A CI run of your branch

A CI run of the branch your workspace reads or has checked out shows beside your own runs while it runs, read-only:
nothing in your editor or Piwi Picker pauses, steps, holds or shares it.

- **VS Code**: the **CI Runs** view of the Piwi panel lists it as `CI run #78`, its branch and progress beside it,
  then **Open run #78** and its tests: those running, then the latest that ended, failures first. A running test
  opens the call it is at, else its spec.
- **JetBrains IDEs**: the **CI Run** tab of the Piwi tool window, added while one runs, lists the same rows; a double
  click opens one.
- **The line each running test is at** ends with a plain mark in the CodeLens or inlay color, `CI run #78 · worker 2:
  Click getByRole('button')`: a CI position, never a stop. The line is the run's commit's.
- **Piwi Picker's Runs window** lists the CI runs in progress of the projects your
  [connection](./extension-connection) maps, through that instance, with **Open**.
- **Watch on the dashboard**, under a running test of a run whose project has the [live view](./live-view) on, opens
  its lane's view on the run's page.

The editor follows the two newest CI runs of a branch through the connection to the instance it already holds, and
Piwi Picker reads the list every 15 seconds while its Runs window is open. While the editor follows a run, the run's
reporter streams the call each test is at.

## What you see

Each view names the worker by its slot in the run (`Worker 2`) and says what it does: its running test, the call a Pause waits in, where it
stopped, between tests, or starting. Across a **Step**, a **Resume** or between two tests, the last image stays until
the next one comes, dimmed in VS Code, the Runs window and the desktop app, the last two marking it **Running…**. A
page that does not change sends no new image.

Watching pauses while the view is out of sight (another tab in front of an editor's panel or tab, a minimized Runs
window) and starts again as it shows. It ends when you turn it off or close the view, or as the run ends.

## Interact

At a stop, **Interact**, beside **Watch live** or **Watch** in each view once the view is on, sends your clicks, the
wheel and your keys on the view to the page as a person's would. The first of them takes control of the stop, so an
agent waits until you give it back ([driving a stop](/guide/concepts#presence-driving-a-stop)). It stays on across the
worker's next stops, where your first click or key takes the stop again. Turning it or watching off, **Give back** or
`Esc` on the view turns it off and gives the stop back, once the input sent before has reached the page. While a
pick or a check runs on the page, started there or from its pause bar, `Esc` goes to the page instead, as its own
key: it skips the pick or closes the check. A recording takes no `Esc` of its own, so there `Esc` gives the stop back. A `Shift`+click
picks a locator instead. The keys that stay the window's are listed under
[keyboard shortcuts](/reference/keyboard-shortcuts#piwi-picker-s-runs-window).

## What is sent, and what is kept

The worker takes images only while a view watches it, and sends them to the editor service or the desktop app's
server on your machine, which passes each to the views watching that worker and keeps none. Before an image leaves
the worker, password fields and the fields of one-time codes and card numbers are painted over. One view of the page
serves every viewer at once: the editor's, Piwi Picker's and, for a run [shared live](./share-live), the team's.

## Limits

- **One worker per editor.** The panel or tab watches one worker: watching another moves it there.
- **The test's `page`.** A popup or a second page the test opens is not shown. A download a click on the view starts
  and a dialog the page opens go to the test as its own would: Playwright deletes the download with the test's
  context, and dismisses the dialog unless the test handles it.
- **A test's own screencast.** When the test records its own (a video, a trace with screenshots), the view takes its
  size and quality; when none can start, it is an image of the page twice a second.
- **A heavy page.** A frame over 384 KB gives way to a lighter image of the page, twice a second; when even that is
  too heavy, the view says so in its place.
- **An older reporter** shows a stopped test alone: the Runs window's row and the desktop app's tray hold their
  **Watch**, saying to update it, and the editors offer no Watch for its workers.

## Related

- [Runs window](./runs-window): watch, steer and pick from a window beside the test's browser.
- [Pause and step from the editor](./editor-run-control): the controls and the paused page, in the editor.
- [Desktop app runs](./desktop-runs): the runs the desktop app starts, and its tray.
- [Live view of a run](./live-view): a CI run's or a shared run's page, on the team instance.
- [Runs from the editor](./editor-runs): your own runs, and the status bar that counts a CI run of your branch.
