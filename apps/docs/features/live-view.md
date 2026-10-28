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

## Turn it on

The live view is off in every project. A Project admin turns it on in **Project → Settings → Live view**, which says
what goes out, to whom, and what is kept. It applies to the project's CI runs from their next start: each run in a CI
job that the reporter's global setup registers, which [`wrapConfig`](/guide/reporter) adds. The reporter tells a CI
job as the run's origin does: by a CI provider's own variable (`GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`, …) or by
`CI` set to anything but `false` or `0`. At the start of such a run the reporter prints:

```text
[Piwi Dashboard] Live view on: people who may open this run can watch its tests' pages on the dashboard while it runs. Nothing is stored.
```

A run on a developer's machine holds a key too, and sends nothing until its developer shares it. Turning the setting
off ends every view of the project's runs at once.

## Watch a worker

On the run page's **Tests** tab, a running test shows the step its worker is on. With the live view on, **Watch**
beside it opens that worker's view: the test's page as the browser paints it, headless or not, and under it the call
the image was taken at (`Click getByRole('button', { name: 'Pay' }) · checkout.spec.ts:30`). A page that does not
change sends no new image.

A view belongs to the test on whose row you opened it. Opened while the worker runs no test, in a `beforeAll` or between
two tests, it says so, and shows the test's page once it opens. It ends as its test ends, the worker leaves, the run
ends or the project turns the live view off, and when you close it. To watch the worker's next test, click **Watch**
on its row.

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

The first share in a window (in a JetBrains IDE, since it started; in the desktop app, since it started) says what goes
out and to whom, and waits for your yes. Shared, the run says where and how many people watch, with its page's link to
copy for your teammate.

Until then, the run's workers hold their key and send nothing. Once shared, each worker, and one Playwright starts
later, opens its connection and sends what a CI run's do: images while someone watches, and its stops. **Stop
sharing** closes the connections, so nothing more goes to the instance: each view ends saying the developer stopped
sharing, and **Paused** leaves the rows. Closing the editor, or the desktop app, stops the sharing too.

A run that cannot be shared says why when you ask: it reports to no instance, its project has the live view off, or
the reporter's global setup did not register it. The key lives in the instance's memory: once the instance restarts,
it takes the key no more, and the run says its sharing stopped.

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
  [roles](/operate/project-access).
- **Nothing is kept.** The dashboard relays each image to the people watching that worker and drops it: it is never
  written to the database, the logs or an export, and a viewer that reads slowly gets the latest image alone. The
  run's trace stays the record.

The images show whatever the page shows, as the run's screenshots, videos and traces already do; a credential in a
call's URL is hidden in its caption. The workers reach the dashboard with a key the run got as it registered: it
opens this run's live view and nothing else, ends with the run, and is never in the environment of the tests, their
hooks or their fixtures, so a process they start does not get it.

## Limits

- **Watch only.** The view has no input and no controls; stepping a test is the editor's and Piwi Picker's
  ([Pause and step from the editor](./editor-run-control), [Runs window](./runs-window)).
- **The test's `page`.** The view shows the page of Playwright's `page` fixture; a test with no page has nothing to
  show, and a popup or a second page is not shown.
- **A run the global setup registered.** With the reporter entry alone, which has no global setup, the workers start
  before the run is registered and get no key.
- **Sixteen views of a run at a time.** With authentication on, four of them one person's: a fifth closes that
  person's oldest. With it off, the dashboard cannot tell people apart, and the sixteen are anyone's.
- **One dashboard server.** The view is relayed in the memory of one server, as the run's live events are, so it needs
  a deployment of one server ([Resource requirements](/operate/deployment#resource-requirements)). Sticky sessions do
  not make up for it: the run's setup, its CI workers and the people watching are separate clients.

## Related

- [Capture fixtures](/guide/capture-fixtures): the worker side of the view
- [Runs window](./runs-window): the live view of a test your editor runs, with its controls, and Share live
- [Desktop app runs](./desktop-runs): the desktop app's runs, and Share live from its tray
- [Pause and step from the editor](./editor-run-control)
- [Failure evidence](./evidence): what a finished test keeps
