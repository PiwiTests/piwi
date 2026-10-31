---
title: Live view of a run
description: "Watch the page each worker of a running CI run, or of a run a developer shares from their machine, is on, from the run page, in a project that turns it on: a few images a second with the call each was taken at, sent only while someone watches and never stored."
lang: en-US
---

# Live view of a run

<Needs reporter fixtures />

In a project that turns the live view on, a running test of a CI run, or of a run a developer
[shares from their machine](#share-a-run-from-your-machine), gets **Watch** on its run page: it opens the page that
worker is on, a few images a second, each with the call it was taken at. It is for watching a CI run that seems stuck,
or a teammate's paused test, without waiting for the trace. Nothing you do in the view reaches the test.

## Where to watch a run

| The run | Where its test's page shows |
|---|---|
| A CI run, or a run shared from a developer's machine | Its page on the team instance: **Watch** |
| A run you start from VS Code, a JetBrains IDE or a terminal | Its browser when headed; at a stop, Piwi Picker's [Runs window](./runs-window#watch-live) and the editor's [paused page](./editor-run-control#a-headless-run) |
| A run the desktop app starts | Its [Local runs](./desktop-runs#watch-live) tray and the Runs window, at a stop |

A stop is a breakpoint, a `page.pause()` or **Pause**. A run that reports to the desktop app gets no **Watch**: the
app hands out no live view key.

## Turn it on

The live view is off in every project. A Project admin turns it on in **Project → Settings → Live view**. It applies to
each CI run that starts after, as the reporter's global setup registers it: [`wrapConfig`](/guide/reporter) adds that
setup. A CI job is told by its provider's variable (`GITHUB_ACTIONS`, `GITLAB_CI`, …) or by `CI` set to anything but
`false` or `0`. Such a run's log then says:

```text
[Piwi Dashboard] Live view on: people who may open this run can watch its tests' pages on the dashboard while it runs. Nothing is stored.
```

Turning it off ends every view of the project's runs at once. A run that started while it was off stays without a view
when it is turned on again.

## Check availability

Beside its search, a running run's **Tests** tab says **Live view available**, or what is missing; its help gives the
step:

| It says | Why, and what to do |
|---|---|
| **Live view off** | A Project admin turns it on; the next run gets it. |
| **Live view unavailable** | The run has no key: it started before the setting was on, without `wrapConfig`'s global setup, with `streaming` off, or before the instance restarted. Start a new run. |
| **Live view waiting** | No worker is connected yet: they are starting, or the specs do not import `test` from the [capture fixtures](/guide/capture-fixtures). |
| **Not shared live** | The run is on a developer's machine: they [share it](#share-a-run-from-your-machine). |

## Watch a worker

On the run page's **Tests** tab, **Watch** beside a running test opens its worker's view: the test's page as the
browser paints it, headless or not, and under it the call the image was taken at (`Click getByRole('button', { name: 'Pay' }) · checkout.spec.ts:30`). A still page sends no new image.

In a CI run, the view also follows that call: how long it has run, Playwright's log of it as a failed call's error
prints it, and while it waits, what its locator matches (no element yet, several, or one not enabled), outlined on the
image, with the point a click acts on. A shared run shows the call alone.

A view belongs to the test whose row opened it. Opened between two tests or in a `beforeAll`, it says so and shows the
next test's page. It ends with its test, its worker or the run, when the live view is turned off, or when you close it.

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

Until then, its workers send nothing, and its running tests say **Not shared live** where **Watch** would be. Once
shared, its stops (the call, its file and line, the test's title) reach everyone with the run's page open, and images
only those watching. **Stop sharing** closes the views within seconds and clears **Paused** from the rows. Closing the
editor or the desktop app stops it too.

A run that cannot be shared says why: it reports to no instance or to the desktop app, its project has the live view
off, or the reporter's global setup did not register it. A sharing that stops on its own says why (the live view turned
off, the instance restarted or stopped answering), and **Share live** shows again.

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

**Masked in the worker**, with `@piwitests/reporter` 0.64.0 or later (an older one masks nothing): before an image
leaves it, the worker paints over password fields, fields whose `autocomplete` asks for a one-time code or a card's
number or code, and the project's **Masked elements** (Playwright locators). While one shows, two images a second go at
most. A secret in the page's own text still shows; the caption and the log hide credentials and typed text. The workers reach the dashboard with a key
the run got as it registered: it opens this run's live view and nothing else, ends with the run, and is never in the
environment of the tests, their hooks or their fixtures, so a process they start does not get it.

## Limits

- **Watch only.** No input and no controls: a test is stepped from the [editor](./editor-run-control) or the
  [Runs window](./runs-window).
- **The test's `page`.** The view shows the page of Playwright's `page` fixture; a popup or a second page is not shown.
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
