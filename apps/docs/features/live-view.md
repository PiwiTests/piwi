---
title: Live view of a run
description: "Watch the page each worker of a running CI run, or of a run a developer shares from their machine, is on, from the run page, in a project that turns it on: a few images a second with the call each was taken at, sent only while someone watches and never stored."
lang: en-US
---

# Live view of a run

<Needs reporter fixtures />

In a project that turns the live view on, a running test of a CI run, or of a run a developer
[shares from their machine](./share-live), gets **Watch** on its run page: it opens the page that
worker is on, a few images a second, each with the call it was taken at. It is for a CI run that seems stuck, or a
teammate's paused test, without waiting for the trace. Nothing you do in the view reaches the test.

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

A CI run without a view logs why instead.

Turning it off ends every view at once; a run that started while it was off stays without one.

## Check availability

A running run's **Tests** tab says **Live view available**, or what is missing, its help giving the step:

| It says | Why, and what to do |
|---|---|
| **Live view off** | A Project admin turns it on for the next runs. |
| **Live view unavailable** | The run has no key: it started before the setting was on, without `wrapConfig`'s global setup, or with `streaming` off. Start a new run. |
| **Live view waiting** | No worker is connected yet: they are starting. |
| **No worker connected** | Tests run without one: the specs import `test` from `@playwright/test`, not the [capture fixtures](/guide/capture-fixtures). |
| **Not shared live** | The run is on a developer's machine: they [share it](./share-live). |

## Watch a worker

On the run page's **Tests** tab, **Watch** at the end of a running test's row opens its worker's view, docked beside
the page (a sheet on a smaller screen): the test's page as the browser paints it, headless or not, under it the call
the image was taken at (`Click getByRole('button', { name: 'Pay' }) · checkout.spec.ts:30`). A still page sends no new
image, so the caption names the step the test began since. Widen the panel by its edge or open it full screen; a click
on the image zooms.

In a CI run, the view follows that call: how long it has run, Playwright's log of it as a failed call's error
prints it, and while it waits, what its locator matches (no element yet, several, or one not enabled), outlined on the
image, with the point a click acts on; **Zoom to the element** crops the image around it. A shared run shows the call
alone. Following the call needs Playwright 1.64: 1.63 shows its log without the matches, an older one the call alone.

A view follows its worker's lane: it says how each test ended, lists the lane's earlier tests and goes on, across
worker restarts; untick **Follow the worker's next test** to end it with its test. The page's address names the lane
(`?watch=2`; `?watch=3.2` for worker 2 of shard 3) for a link. It ends with the run, saying how it went, 30 s after its
lane's worker left, as the live view turns off, or as you close it. A view that cannot open says why.

A CI run never stops at a breakpoint or a `page.pause()`; a shared run does, and its row then says **Paused** at the
stopped call, which opens in your editor.

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
most. A zoomed-in page sends no image. A secret in the page's own text still shows; the caption and the log hide credentials and typed text. The workers reach the dashboard with a key
the run got as it registered: it opens this run's live view and nothing else, ends with the run, and is never in the
environment of the tests, their hooks or their fixtures, so a process they start does not get it. The dashboard keeps
the key's SHA-256 digest with the run, never the key, so a dashboard that restarts takes the key back from the
workers that present it while the run lasts.

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
- [Share a run live](./share-live): let a teammate watch a run on your machine
- [Runs window](./runs-window): the live view of a test your editor runs, with its controls
- [Desktop app runs](./desktop-runs): the desktop app's runs, and Share live from its tray
- [Failure evidence](./evidence): what a finished test keeps
