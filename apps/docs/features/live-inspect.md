---
title: Inspect a running test's page
description: "In the live view of a running Playwright test, Inspect shows the page at each call as a document, before it, at its action and after it, with the locator picker; sent only while open, and never stored."
lang: en-US
---

# Inspect a running test's page

<Needs reporter fixtures />

Under a worker's [live view](./live-view), **Inspect** shows its test's page as a document rather than an image: the
DOM Playwright's trace takes at each call (before the call, at its action and after it), rendered by the dashboard
with its stylesheets and images, and the locator picker on it. It is for a CI test that waits on an element: you see
the page as the test sees it, at the call it is stuck on, and pick the locator to use while the test still waits. It
works in a CI run or a run [shared from a developer's machine](./share-live), and the dashboard stores none of it.

## Use it

In the lane panel of a running test, open **Inspect** under the image.

- **The latest call.** The view opens on the page at the latest call the worker sent, and shows each new call as it
  comes while **Follow the latest call** is on.
- **Before, Action, After.** The page before the call ran, at its action (where a click or a fill acts, for an input
  action) and after it. A moment the worker sent no page of stays greyed out.
- **The calls.** Under the page, each call whose page came, the latest last. Choosing an older one turns following
  off, so the view stays on it as the test goes on; tick **Follow the latest call** to go back to the newest.
- **Pick a locator** opens the [snapshot picker](./evidence#one-execution-diagnosis-first) on the page shown: click an
  element to get the locators that target it, ranked, to copy. Picking turns following off. Nothing is saved: the
  test is still running.

The view goes on with the lane's next test, as the image does, and lets the pages of the test before go.

## Where the pages come from

- **The test's own trace**, when the project's `trace` option records this attempt: the worker reads the snapshots
  the trace takes as it grows. Nothing in the trace changes, and the archive the runner keeps is the same.
- **Otherwise, a trace of the worker's own**, started when the first viewer opens Inspect, taking DOM snapshots alone,
  and stopped unsaved, its files deleted, when the last closes it. A test that starts tracing itself meanwhile gets
  it: the worker's trace stops first. That trace sees only what the page loads from then on, so a page loaded before
  Inspect opened may show unstyled until the test loads it again.
- **No page** comes from a trace whose `snapshots` option is off, or a page the worker cannot trace: Inspect says why.

## What is sent, and what is not

- **Nothing until someone opens Inspect.** The worker sends pages only while a viewer of it has Inspect open: first
  the page's snapshots since its last navigation, 16 MB at most, the oldest left out past them, then each new one, 12
  a second at most. A snapshot is 4 MB at most. The view's images go first: a snapshot never holds one back.
- **The stylesheets, fonts and images a page names**, once per run, 2 MB each at most. Never a script, a document or
  an SVG: a page renders without them.
- **Secrets.** Before a page leaves the worker, the value of each field that holds a secret is removed: a password, a
  one-time code, a card's number or code, a field whose name, label or `autocomplete` names one. So is any text equal
  to a value the test's secret fields held or its calls typed into one, and anything that reads as a card's number:
  each reads `<hidden>`. The dashboard removes those fields' values again before it renders a page: they show
  empty.
- **A project with Masked elements gets no page.** Its masks are locators, which a snapshot cannot apply; Inspect says
  so in place of the page.
- **No script of the page runs.** The dashboard renders each page itself, its scripts, inline handlers and
  `javascript:` links left out, in a sandboxed frame that loads nothing from the network.

## What the dashboard keeps

The pages and their resources stay in the dashboard server's memory, for the run alone: each worker's latest 32 MB of
pages, 128 MB for the run's workers together, and the resources they name, the 64 MB used last. Nothing goes to the
database, the disk, the logs or an export, and it all goes when the run ends. A call whose page the dashboard no
longer keeps says so in place of the page.

Who sees them: who may open the run, each from their own view, as for the [images](./live-view#what-is-sent-to-whom-and-what-is-kept).
The pages count against the 4 MB a second the run's workers send together.

## Limits

- **The test's `page`, its main frame.** An iframe's content is not shown, nor another page of the test.
- **A worker of an older reporter** sends no page: Inspect waits for one.
- **A trace's snapshots, not the live page.** A page shows what Playwright recorded at a call: an element that
  appears between two calls shows at the next.

## In the demo

The live demo runs no browser, so its runs have no worker to watch in full: [Watch all](./watch-all#in-the-demo) names
each worker's step, and Inspect needs a running test.

## Related

- [Live view of a run](./live-view): turning it on, and the image and call of one worker
- [Page events, text and filmstrip](./live-view-layers): what the page and its requests said, beside the image
- [Failure evidence](./evidence): the DOM snapshot and the picker of a finished test
- [Share a run live](./share-live): a run on your machine, watched from the dashboard
