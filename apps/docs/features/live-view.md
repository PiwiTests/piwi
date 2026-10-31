---
title: Live view of a run
description: "Watch the page each worker of a running CI run, or of a run a developer shares from their machine, is on, from the run page, in a project that turns it on: a few images a second with the call each was taken at, sent only while someone watches and never stored."
lang: en-US
---

# Live view of a run

<Needs reporter fixtures />

Watch a running CI test, or a test a developer [shares](#share-a-run-from-your-machine), without waiting for its
trace. **Watch** on its run page shows the browser's page and current call. The project must enable live view.
The view is read-only.

## Where to watch a run

| The run | Where its test's page shows |
|---|---|
| A CI run, or a run shared from a developer's machine | Its page on the team instance: **Watch** |
| A run you start from VS Code, a JetBrains IDE or a terminal | Its browser when headed; at a stop, Piwi Picker's [Runs window](./runs-window#watch-live) and the editor's [paused page](./editor-run-control#a-headless-run) |
| A run the desktop app starts | Its [Local runs](./desktop-runs#watch-live) tray and the Runs window, at a stop |

A stop is a breakpoint, a `page.pause()` or **Pause**. A run that reports to the desktop app gets no **Watch**: the
app hands out no live view key.

## Turn it on

Live view is off by default. A Project admin enables it in **Project → Settings → Live view** before the run starts.
The reporter's global setup, added by [`wrapConfig`](/guide/reporter), registers the run. CI is detected from provider
variables (`GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`, …), or `CI` set to anything but `false` or `0`.

Turning it off ends every view immediately. Turning it on, including after disabling it, needs a new run. The run
page's **Tests** tab shows a compact status beside search. Its help icon opens setup guidance and, for a Project admin,
a link to enable live view.

## Check availability

Live result counts do not by themselves mean a browser can be watched. The run page explains the missing step:

| State | What to do |
|---|---|
| Live view is off | A Project admin enables it, then starts a new run. |
| Unavailable for this run | Check `wrapConfig` registered the run at startup and result streaming is enabled, then start a new run. Enabling the setting after startup, or an instance restart, can also cause this. |
| Waiting for workers | Allow startup or reconnection to finish. If tests already run, check their specs import `test` from the capture fixtures. Creating the fixtures file alone does not activate them. |
| Local run not connected | Its developer chooses **Share live**; if already sharing, check its worker connection and fixture imports. |
| Checking availability | Wait for the run's connection to return. |

The desktop app shows where to open a local preview at a pause. The browser demo simulates progress and has no real
test browser to watch. Local previews do not require the project's setting.

## Watch a worker

On the **Tests** tab, **Watch** beside a running test shows its worker's page, headless or headed, and the call at each
image (`Click getByRole('button', { name: 'Pay' }) · checkout.spec.ts:30`). An unchanged page sends no new image.

In a CI run, the view also follows that call: how long it has run, Playwright's log of it as a failed call's error
prints it, and while it waits, what its locator matches (no element yet, several, or one not enabled), outlined on the
image, with the point a click acts on. A shared run shows the call alone.

A view follows the selected test. Between tests or during `beforeAll`, it waits for a page. It ends with that test,
worker or run, when the project disables live view, or when closed.

A CI run never stops at a breakpoint or a `page.pause()`; a shared run does, and its row then says **Paused** at the
stopped call, which opens in your editor.

## Share a run from your machine

Choose **Share live** while a local run executes to let a teammate watch it. The run must report to a team instance
whose project enables live view, and connect to an editor or the desktop app for controls.

| Where | Share | Stop |
|---|---|---|
| VS Code | **Piwi: Share the run live on the team instance**, or the status bar's broadcast icon | **Piwi: Stop sharing the run live**, or the status bar's **Live** |
| JetBrains IDEs | **Tools → Piwi → Share the Run Live** | **Tools → Piwi → Stop Sharing the Run Live** |
| Piwi Picker's [Runs window](./runs-window) | **Share live** under the run's name | **Stop sharing** |
| The desktop app's [Local runs tray](./desktop-runs) | **Share live** above the run's workers | **Stop sharing** |

The first share in a window asks for confirmation. The shared run shows its destination, viewer count and a link to copy.

Until shared, workers send nothing. Once shared, stops (call, file, line and test title) reach everyone with the run
page open; images go only to viewers. **Stop sharing** closes views within seconds and clears **Paused** from the rows.
Closing the editor or desktop app also stops sharing.

A run that cannot be shared says why, in Piwi Picker's Runs window in place of **Share live**, elsewhere when you ask:
it reports to no instance or to the desktop app, its project has the live view off, or the reporter's global setup did
not register it. A sharing that stops on its own says why, and **Share live** shows again: the project's
live view turned off, the instance restarted, or it stopped answering.

## What is sent, to whom, and what is kept

- **Nothing from a run on your machine until you share it.** Its workers open no connection.
- **Nothing while nobody watches.** Each worker of a CI or shared run keeps one connection to the dashboard and says
  only when its test stops and goes on. No image is taken.
- **While someone watches a worker**, that worker sends JPEG images of its test's page, at most 640 by 400 pixels at
  quality 50, four a second at most and about 256 KB a second: a heavier image holds the next one back longer. A test
  whose trace or video already films the page shares that recording's images, 800 pixels wide at quality 90, and so
  sends fewer of them. The recording stays whole. A test that starts its own `page.screencast` gets it, and the view
  goes on with an image a second. A CI run's worker also sends the call's log. Nothing of the view is a step of the
  test or an action of its trace.
- **Only to people who may open the run**: watching needs what opening the run needs, the project's
  [roles](/operate/project-access). On an instance with authentication off, that is anyone who can reach it.
- **Nothing is kept.** The dashboard relays each image to the people watching that worker and drops it: never written
  to the database, the logs or an export. A viewer that reads slowly gets the latest image alone. The run's trace stays
  the record.

The images show whatever the page shows, as the run's screenshots, videos and traces already do; a credential in a
call's URL, the text a call types and a password field's value are hidden in its caption and its log. The workers reach the dashboard with a key
the run got as it registered: it opens this run's live view and nothing else, ends with the run, and is never in the
environment of the tests, their hooks or their fixtures, so a process they start does not get it.

## Limits

- **Watch only.** No input and no controls: a test is stepped from the [editor](./editor-run-control) or the
  [Runs window](./runs-window).
- **The test's `page`.** The view shows the page of Playwright's `page` fixture; a popup or a second page is not shown.
- **A run the global setup registered.** With the reporter entry alone, which has no global setup, the workers start
  before the run is registered and get no key.
- **Sixteen views of a run at a time**, four of them one person's with authentication on: a fifth closes that
  person's oldest.
- **One dashboard server.** The view is relayed in the memory of one server, as the run's live events are, so it needs
  a deployment of one server ([Resource requirements](/operate/deployment#resource-requirements)). Sticky sessions do
  not make up for it: the run's setup, its CI workers and the people watching are separate clients.

## Related

- [Capture fixtures](/guide/capture-fixtures): the worker side of the view
- [Runs window](./runs-window): the live view of a test your editor runs, with its controls, and Share live
- [Desktop app runs](./desktop-runs): the desktop app's runs, and Share live from its tray
- [Failure evidence](./evidence): what a finished test keeps
