---
title: Watch a running test
description: "Watch the page of a Playwright test while it runs on your machine, from VS Code, a JetBrains IDE, Piwi Picker's Runs window or the desktop app: up to ten images a second, through its next tests and stops."
lang: en-US
---

# Watch a running test

<Needs reporter fixtures />

**Watch** in your own tools shows a test's page in your editor, Piwi Picker's Runs window or the
desktop app, in a run on your machine or a remote container, read-only in a CI run of your branch. On the
team instance, it is the [live view](./live-view); a run's progress and stops: [Watch a run](./watch-a-run). The page
shows up to ten images a second, through the test's next tests and stops, and the worker Playwright starts in its
place after a failure. It needs
`@piwitests/reporter` after 0.67.0 and the [capture fixtures](/guide/capture-fixtures). Nothing leaves your
machine: [what is sent](#what-is-sent-and-kept).

## Where to watch

| Where | Open it | At a stop |
|---|---|---|
| VS Code | **Piwi: Watch a worker's test**, or the status bar's menu during a run: `Piwi: worker 2` beside the editor | A headless stop shows there, with **Interact** and the pick on a click, instead of the paused page |
| JetBrains IDEs | **Tools → Piwi → Watch a worker's test**: the Piwi tool window's **Worker 2** tab | The tab only watches: a headless stop opens the **Paused page** beside it, for **Interact**, unless that tab holds another stop |
| Piwi Picker | **Watch** on a worker's row of the [Runs window](./runs-window#watch-live) | Its controls above the view; the stopped worker scrolls into view |
| Desktop app | **Watch** on a running row of its own runs opens the [Local runs](./desktop-runs#watch) tray on it | The tray shows the stopped worker, behind its tab in a run of several |

**Pause and watch**, which also stops the test before its next call, is **Piwi: Pause and watch a worker's test**
(**Tools → Piwi → …**), and a button beside **Watch** in the Runs window and the desktop app. With several workers, the editor asks which.

## A CI run of your branch

A CI run of the branch your workspace reads or has checked out, or a teammate's on it or on the branch your results
are compared with, shows beside your runs, read-only: nothing pauses, steps, holds or shares it. VS Code's status bar
says `CI run #125` or `run #126`, its Testing view `Piwi: CI run #125 on main` with results as they end; your own run
keeps the status bar.

- **The CI Runs view** of VS Code's Piwi panel, and the **CI run** tab of the JetBrains Piwi tool window while one
  runs, list `CI run #78`, its branch and progress, **Open run #78** and its tests: those running, then the latest
  that ended, failures first. A running test opens the call it is at, else its spec (a double click in JetBrains).
- **The line each running test is at** ends with a plain mark in the CodeLens or inlay color, `CI run #78 · worker 2:
  Click getByRole('button')`: a [CI position](/guide/concepts#ci-position), never a stop, on the run's commit's line.
- **Piwi Picker's Runs window** lists them too: [CI runs](./runs-window#open-it).
- **Watch**, under a running test whose project has the [live view](./live-view) on, opens its lane read-only, named
  `CI run #78 · worker 2`, in the VS Code worker panel, the JetBrains **Worker** tab or the Runs window: no
  **Interact**, no pick. It follows the lane through its next tests, and ends with the run, as you hide or close the
  view, or as the instance closes it, saying why. Its images come from the
  [team instance](./live-view#what-is-sent-to-whom-and-what-is-kept).
- **Watch on the dashboard** opens the lane on the run's page, offered where the editor cannot show it (an older
  instance, a refused **Watch**).

## What you see

Each view names the worker by its lane (`Worker 2`) and says what it does: its running test, the call a Pause waits
in, its stop, between tests, or starting. Across a **Step**, a **Resume** or between two tests, the last image
stays until the next one comes, dimmed in VS Code, the Runs window and the desktop app, the last two marking it
**Running…**. A still page sends none. Watching pauses while the view is out of sight (another tab in front,
a minimized Runs window) and starts again as it shows. It ends when you turn it off or close the view, or as the run
ends.

## Beside the image

Under the image, the editor's view, a CI run's lane included, the Runs window and the desktop app's tray show what the
pixels cannot: why the test waits, the page's events, its text and a filmstrip of its calls
([in your own tools](./live-view-layers#in-your-own-tools)). While an editor watches a worker of your run, the line
of the call its test is in is marked until the test ends or stops, the call named after it (VS Code dims the line,
`Worker 2 · Click getByRole('button')`; a JetBrains IDE adds an inlay), and the page's events go to VS Code's
`Piwi: Page` output, its console and uncaught errors to the JetBrains Piwi tool window's **Page** tab, each test named
as it begins.

## Open the trace so far

**Open the trace so far** opens Playwright's trace viewer on the running test's trace up to now, on the machine the
run runs on, with a reporter newer than 0.68.0, while the worker runs a test: beside **Watch** in the VS Code panel
(**Piwi: Open the trace so far**), in the JetBrains **Worker** tab, and in a watched page's head in the Runs window
and the tray. The editor service or the desktop app's server asks the worker where its trace grows,
checks that file, and starts the viewer with your project's own Playwright; the path never leaves it, and each tool
hears why when the viewer does not start. Playwright 1.59 to 1.64 shows the trace as it stood when it opened: close
it and choose the button again for what came since.

It shows only where it can open: the machine has a display (on Linux, `DISPLAY` or `WAYLAND_DISPLAY` set), the tool
knows the run's folder, and a Runs window reaches the hub without a forwarded port. The attempt must be traced, from
its first browser context: `trace: 'on'` or `'retain-on-failure'` (`wrapConfig`'s default) traces every attempt,
`'on-first-retry'` and `'on-all-retries'` a retry alone.

## Interact

At a stop, **Interact**, beside **Watch** once the view is on, sends your clicks, the wheel and your
[keys](/reference/keyboard-shortcuts#piwi-picker-s-runs-window) on the view to the page as a person's would, the
picker and the recorder included. The first takes the stop, so an agent waits until you give it back, and the view
names who drives and watches it ([driving a stop](/guide/concepts#presence-driving-a-stop)). It stays on across the
worker's next stops, where your first input takes the stop again. **Give back**, `Esc` on the view, watching off or
refused, another lane's stop, a stop that takes no input, the view hidden or closed, or the run's end turns it off and
gives the stop back, once the input sent before has reached the page; what you hold down is let go before the test
goes on. While a pick or a check runs on the page, `Esc` skips the pick or closes the check instead; in a recording it
gives the stop back.

## What is sent and kept

The frames go from the test's worker only to that worker's views (an editor's, the desktop app's window, Piwi
Picker's Runs window through the extension's background worker), on your machine or through the port your IDE
forwards from a [remote window](/guide/remote-development), and to the team instance while the run is
[shared live](./share-live). The worker takes images only while a view watches it, and paints over password fields
and the fields of one-time codes and card numbers first. The editor service or the desktop app's server passes each
on, one view of the page serving every viewer. Nothing stores them.

The images follow the test's own screencast: when the test records its own (a video, a trace with screenshots), the
view takes its size and quality; when none can start, it is an image of the page twice a second. A frame over 384 KB
gives way to a lighter image, twice a second; when even that is too heavy, the view says so.

## Limits

- **One worker per editor.** The panel or tab watches one worker, a CI run's lane included: watching another moves it
  there.
- **The test's `page`.** A popup or a second page is not shown. A download a click on the view starts and a dialog
  the page opens go to the test as its own would: Playwright deletes the download with the test's context, and
  dismisses the dialog unless the test handles it.
- **An older reporter** shows a stopped test alone: the Runs window's row and the desktop app's tray hold their
  **Watch**, saying to update it, and the editors offer no Watch for its workers.

## Related

- [Pause and step from the editor](./editor-run-control)
- [Live view of a run](./live-view)
