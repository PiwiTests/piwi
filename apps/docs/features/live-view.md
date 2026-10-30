---
title: Live view of a run
description: "Watch the page each worker of a running CI run, or of a run a developer shares from their machine, is on, from the run page, in a project that turns it on: a few images a second with the call each was taken at, sent only while someone watches and never stored."
lang: en-US
---

# Live view of a run

<Needs reporter fixtures />

While a run executes, its run page shows the step each worker is on. In a project that turns the live view on, a
running test of a CI run, or of a run a developer [shares from their machine](#share-a-run-from-your-machine), also
gets **Watch**: it opens the page that worker is on, a few images a second, each with the call it was taken at. It is
for watching a CI run that seems stuck, or a teammate's test paused at a breakpoint, from the dashboard, without
waiting for the trace. You watch; nothing you do in the view reaches the test.

## Where to watch a run

| The run | Where its test's page shows |
|---|---|
| A CI run, or a run shared from a developer's machine | Its page on the team instance: **Watch** |
| A run you start from VS Code, a JetBrains IDE or a terminal | Its browser when headed; at a stop, Piwi Picker's [Runs window](./runs-window#watch-live) and the editor's [paused page](./editor-run-control#a-headless-run) |
| A run the desktop app starts | Its [Local runs](./desktop-runs#watch-live) tray and the Runs window, at a stop |

A stop is a breakpoint, a `page.pause()` or **Pause**. A run that reports to the desktop app gets no **Watch**: the
app hands out no live view key.

## Turn it on

The live view is off in every project. A Project admin turns it on in **Project → Settings → Live view**, which says
what goes out, to whom, and what is kept. It applies to the project's CI runs from their next start: each run in a CI
job that the reporter's global setup registers, which [`wrapConfig`](/guide/reporter) adds. The reporter tells a CI
job as the run's origin does: by a CI provider's own variable (`GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`, …) or by
`CI` set to anything but `false` or `0`. At the start of such a run the reporter prints:

```text
[Piwi Dashboard] Live view on: people who may open this run can watch its tests' pages on the dashboard while it runs. Nothing is stored.
```

Turning the setting off ends every view of the project's runs at once.

## Watch a worker

On the run page's **Tests** tab, a running test shows the step its worker is on. With the live view on, **Watch** beside
it opens that worker's view: the test's page as the browser paints it, headless or not, and under it the call the image
was taken at (`Click getByRole('button', { name: 'Pay' }) · checkout.spec.ts:30`). A page that does not change sends no
new image.

A view belongs to the test on whose row you opened it. Opened while the worker runs no test, in a `beforeAll` or between
two tests, it says so, and shows the test's page once it opens. It ends as its test ends, the worker leaves, the run
ends or the project turns the live view off, and when you close it.

A CI run never stops at a breakpoint or a `page.pause()`; a shared run does, and its row then says **Paused** at the
stopped call, which opens in your editor.

## Share a run from your machine

A run that stops where you can steer it, from VS Code, a JetBrains IDE, a terminal an editor follows, Piwi Picker or
the desktop app, can be shared on the instance it reports to, for a teammate to watch from its page: **Share live**, at
any time while it runs, in a project with the live view on.

| Where | Share | Stop |
|---|---|---|
| VS Code | **Piwi: Share the run live on the team instance**, or the status bar's broadcast icon | **Piwi: Stop sharing the run live**, or the status bar's **Live** |
| JetBrains IDEs | **Tools → Piwi → Share the Run Live** | **Tools → Piwi → Stop Sharing the Run Live** |
| Piwi Picker's [Runs window](./runs-window) | **Share live** under the run's name | **Stop sharing** |
| The desktop app's [Local runs tray](./desktop-runs) | **Share live** above the run's workers | **Stop sharing** |

The first share in a window (in a JetBrains IDE, in each project since it opened; in the desktop app, since it
started) says what goes out and to whom, and waits for your yes. Shared, the run says where and how many views of it
are open (one person may open several), with its page's link to copy for your teammate.

Until then, its workers send nothing, and its running tests say **Not shared live** where **Watch** would be. Once
shared, each worker, and one Playwright starts later, sends what a CI run's do: its stops, which everyone with the
run's page open sees (the call, its file and line, and the test's title), even while nobody watches; and images while
someone does. **Stop sharing** closes the connections within seconds, so nothing more goes to the instance: each view ends
saying the developer stopped sharing, and **Paused** leaves the rows. Closing the editor, or the desktop app, stops the
sharing too.

A run that cannot be shared says why, in Piwi Picker's Runs window in place of **Share live**, elsewhere when you ask:
it reports to no instance or to the desktop app, its project has the live view off, or the reporter's global setup did
not register it. A sharing that stops on its own says why, and **Share live** shows again: the project's
live view turned off, the instance restarted (the key lives in its memory), or it stopped answering.

## What is sent, to whom, and what is kept

- **Nothing from a run on your machine until you share it.** Its workers open no connection.
- **Nothing while nobody watches.** Each worker of a CI or shared run keeps one connection to the dashboard and says
  only when its test stops and goes on. No image is taken.
- **While someone watches a worker**, that worker sends JPEG images of its test's page, at most 640 by 400 pixels at
  quality 50, four a second at most and about 256 KB a second: a heavier image holds the next one back longer. A test
  whose trace or video already films the page (the trace `wrapConfig` sets does) shares that recording's images, 800
  pixels wide at quality 90, and so sends fewer of them. The recording stays whole. A test that starts its own
  `page.screencast` gets it, and the view goes on with an image a second. Nothing of the view is a step of the test or
  an action of its trace.
- **Only to people who may open the run**: watching needs what opening the run needs, the project's
  [roles](/operate/project-access). On an instance with authentication off, that is anyone who can reach it.
- **Nothing is kept.** The dashboard relays each image to the people watching that worker and drops it: it is never
  written to the database, the logs or an export, and a viewer that reads slowly gets the latest image alone. The
  run's trace stays the record.

The images show whatever the page shows, as the run's screenshots, videos and traces already do; a credential in a
call's URL and the text a call types are hidden in its caption. The workers reach the dashboard with a key the run got as it registered: it
opens this run's live view and nothing else, ends with the run, and is never in the environment of the tests, their
hooks or their fixtures, so a process they start does not get it.

## Limits

- **Watch only.** No input and no controls: a test is stepped from the [editor](./editor-run-control) or the
  [Runs window](./runs-window).
- **The test's `page`.** The view shows the page of Playwright's `page` fixture; a test with no page has nothing to
  show, and a popup or a second page is not shown.
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
- [Pause and step from the editor](./editor-run-control)
- [Failure evidence](./evidence): what a finished test keeps
