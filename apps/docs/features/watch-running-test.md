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
[capture fixtures](/guide/capture-fixtures). Nothing leaves your machine: [what is
sent](/guide/concepts#watch-share-live).

## Where to watch

| Where | Open it | At a stop |
|---|---|---|
| VS Code | **Piwi: Watch a worker's test**, or a click on the run's progress in the status bar: **Piwi: worker 2** beside the editor | A headless stop of the worker shows there, with **Interact** and the pick on a click, instead of the paused page |
| JetBrains IDEs | **Tools → Piwi → Watch a Worker's Test**: the **Worker 2** tab of the Piwi tool window | The tab only watches: a headless stop opens the **Paused Page** beside it, for **Interact**, unless that tab holds another stop |
| Piwi Picker | **Watch** on a worker's row of the [Runs window](./runs-window#watch-live) | The controls show above the view, and the stopped worker scrolls into view |
| Desktop app | **Watch** on a running row of its own runs, which opens the [Local runs](./desktop-runs#watch) tray on it | The tray shows the stopped worker, behind its tab in a run of several |

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
  [connection](./extension-connection) maps, through that instance, with **Open** and their running tests.
- **Watch**, under a running test of a run whose project has the [live view](./live-view) on, opens its lane
  read-only (the VS Code worker panel, the JetBrains **Worker** tab, named `CI run #78 · worker 2`, or under the run in
  the Runs window): **Watch** alone, no **Interact** and no pick. It follows the lane
  through its next tests, and ends with the run, as you hide or close the view, or as the instance closes it, saying
  why.
- **Watch on the dashboard**, beside it, opens the lane's view on the run's page: the choice where the editor cannot
  show it (an older instance, a refused **Watch**, which offers it).

What the editor reads for a CI run, and where a CI lane's images come from: [CI position](/guide/concepts#ci-position)
and [Watch](/guide/concepts#watch-share-live).

## What you see

Each view names the worker by its slot in the run (`Worker 2`) and says what it does: its running test, the call a Pause waits in, where it
stopped, between tests, or starting. Across a **Step**, a **Resume** or between two tests, the last image stays until
the next one comes, dimmed in VS Code, the Runs window and the desktop app, the last two marking it **Running…**. A
page that does not change sends no new image.

Watching pauses while the view is out of sight (another tab in front of an editor's panel or tab, a minimized Runs
window) and starts again as it shows. It ends when you turn it off or close the view, or as the run ends.

## Beside the image

Under the image, the editor's view shows what the pixels cannot, a CI run's lane included:

- **Why it waits**: the call the test is in, how long it has run, how many elements its locator matches and whether
  the first is enabled, and the last lines of Playwright's log.
- **Events**: console and uncaught errors, failed requests, requests pending long (`POST /api/checkout pending 17 s`)
  and the errors the backend logged, newest first.
- **Text**: the page as roles and names, its secret fields hidden. Find searches it.
- **Filmstrip**: one image per call the test finished; click one to see it larger.

The text and the filmstrip are read only while open. The view says when an older reporter, or team instance, may send
none of them.

While an editor watches a worker of your run, the line of the call its test is in is marked until the test ends or
stops, the call named after it (VS Code dims the line, `Worker 2 · Click getByRole('button')`; a JetBrains IDE adds an
inlay), and the page's events go to VS Code's **Piwi: Page** output, its console and uncaught errors to the
JetBrains Piwi tool window's **Page** tab, each test named as it begins.

## Open the trace so far

**Open the trace so far** opens Playwright's trace viewer on the running test's trace up to now, on the machine the
run runs on ([what it shows](/guide/concepts#trace-so-far)): beside **Watch** in the VS Code panel (or **Piwi: Open the
trace so far**), as **Open the Trace So Far** in the JetBrains **Worker** tab, and in a watched page's head in the Runs
window and the desktop app's tray, while the worker runs a test, stopped or not, with a reporter newer than 0.68.0.

It shows only where it can open: the machine the run runs on has a display (on Linux, `DISPLAY` or `WAYLAND_DISPLAY`
set), the editor or the desktop app knows the run's folder, and a Runs window reaches the hub without a forwarded port.

The attempt must be traced: [which attempts are](/guide/concepts#trace-so-far).

## Interact

At a stop, **Interact**, beside **Watch** in each view once the view is on, sends your clicks, the
wheel and your keys on the view to the page as a person's would. The first of them takes control of the stop, so an
agent waits until you give it back ([driving a stop](/guide/concepts#presence-driving-a-stop)). It stays on across the
worker's next stops, where your first click or key takes the stop again. Turning it or watching off, **Give back** or
`Esc` on the view turns it off and gives the stop back, once the input sent before has reached the page. While a
pick or a check runs on the page, started there or from its pause bar, `Esc` goes to the page instead, as its own
key: it skips the pick or closes the check. A recording takes no `Esc` of its own, so there `Esc` gives the stop back. A `Shift`+click
picks a locator instead. The keys that stay the window's are listed under
[keyboard shortcuts](/reference/keyboard-shortcuts#piwi-picker-s-runs-window).

## Limits

- **One worker per editor.** The panel or tab watches one worker, a CI run's lane included: watching another moves it
  there.
- **The test's `page`.** A popup or a second page the test opens is not shown. A download a click on the view starts
  and a dialog the page opens go to the test as its own would: Playwright deletes the download with the test's
  context, and dismisses the dialog unless the test handles it.
- **The images** follow the test's own screencast and give way on a heavy page:
  [Watch](/guide/concepts#watch-share-live).
- **An older reporter** shows a stopped test alone: the Runs window's row and the desktop app's tray hold their
  **Watch**, saying to update it, and the editors offer no Watch for its workers.

## Related

- [Runs window](./runs-window): watch, steer and pick from a window beside the test's browser.
- [Pause and step from the editor](./editor-run-control): the controls and the paused page, in the editor.
- [Desktop app runs](./desktop-runs): the runs the desktop app starts, and its tray.
- [Live view of a run](./live-view): a CI run's or a shared run's page, on the team instance.
- [Runs from the editor](./editor-runs): your own runs, and the status bar that counts a CI run of your branch.
