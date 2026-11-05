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
| JetBrains IDEs | **Tools → Piwi → Watch a Worker's Test**: the **Worker 2** tab of the Piwi tool window | The tab only watches: a headless stop opens the **Paused Page** beside it, for **Interact** |
| Piwi Picker | **Watch** on a worker's row of the [Runs window](./runs-window#watch-live) | The controls show above the view, and the stopped worker scrolls into view |
| Desktop app | **Watch** on a running row of its own runs, which opens the [Local runs](./desktop-runs#watch-live) tray on it | The tray scrolls the stopped worker into view |

**Pause and watch** is **Piwi: Pause and watch a worker's test** in VS Code, **Tools → Piwi → Pause and Watch a
Worker's Test** in a JetBrains IDE, and a button beside **Watch** in the Runs window and the desktop app. With several
workers to choose from, the editor asks which.

## What you see

Each view names the worker by its slot in the run (`Worker 2`) and says what it does: its running test, where it
stopped, between tests, or starting. Across a **Step**, a **Resume** or between two tests, the last image stays until
the next one comes, dimmed in VS Code, the Runs window and the desktop app. A page that does not change sends no new
image.

Watching pauses while the view is out of sight (another tab in front of an editor's panel or tab, a minimized Runs
window) and starts again as it shows. It ends when you turn it off or close the view, or as the run ends.

## What is sent, and what is kept

The worker takes images only while a view watches it, and sends them to the editor service or the desktop app's
server on your machine, which passes each to the views watching that worker and keeps none. Before an image leaves
the worker, password fields and the fields of one-time codes and card numbers are painted over. One view of the page
serves every viewer at once: the editor's, Piwi Picker's and, for a run [shared live](./share-live), the team's.

## Limits

- **One worker per editor.** The panel or tab watches one worker: watching another moves it there.
- **The test's `page`.** A popup or a second page the test opens is not shown.
- **An older reporter** shows a stopped test alone: the Runs window's row says to update it, and the editors offer no
  Watch for its workers.

## Related

- [Runs window](./runs-window): watch, steer and pick from a window beside the test's browser.
- [Pause and step from the editor](./editor-run-control): the controls and the paused page, in the editor.
- [Desktop app runs](./desktop-runs): the runs the desktop app starts, and its tray.
- [Live view of a run](./live-view): a CI run's or a shared run's page, on the team instance.
