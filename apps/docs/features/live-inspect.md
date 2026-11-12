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
works in a CI run or a run [shared from a developer's machine](./share-live), and the dashboard stores none of it. The
[desktop app](./desktop-runs#watch-live) shows the same view of its own runs, from the test's own trace.

## Use it

In the lane panel of a running test, open **Inspect** under the image.

- **The latest call.** The view opens on the page at the latest call the worker sent, and shows each new call as it
  comes while **Follow the latest call** is on: about three a second at most while they keep coming, the latest
  each time.
- **Before, Action, After.** The page before the call ran, at its action (where a click or a fill acts, for an input
  action) and after it. A moment the worker sent no page of stays greyed out.
- **The calls.** Under the page, each call whose page came, the latest last. Choosing an older one turns following
  off, so the view stays on it as the test goes on; tick **Follow the latest call** to go back to the newest.
- **Pick a locator** opens the [snapshot picker](./evidence#one-execution-diagnosis-first) on the page shown: click an
  element to get the locators that target it, ranked, to copy. Picking turns following off. Nothing is saved: the
  test is still running.

As the test ends, the dashboard lets its pages go: the page shown stays, but no other call's page opens and Pick a
locator is off. The view goes on with the lane's next test, as the image does, following its latest call. When no
page comes, Inspect says why, in place of the page or above the calls it already lists.

## Where the pages come from

- **The test's own trace**, when the project's `trace` option records this attempt: the worker reads the snapshots
  the trace takes as it grows. Nothing in the trace changes, and the archive the runner keeps is the same.
- **Otherwise, a trace of the worker's own**, started when the first viewer opens Inspect, taking DOM snapshots alone,
  and stopped unsaved when the last closes it: its files are deleted, and so are the response bodies it wrote to the
  trace folder's `resources/` that no other trace there names, then or as the test's context closes. A test that
  starts or stops tracing itself meanwhile, even while the worker's trace starts or stops, waits for the worker's
  trace to stop, then goes; the worker starts none again until the test's own stops. That trace sees only what the
  page loads from then on, so a page loaded before Inspect opened may show unstyled until the test loads it again.
  Playwright's snapshot script stays in the pages that context opens later.

## What is sent, and what is not

- **Nothing until someone opens Inspect.** The worker sends pages only while a viewer of it has Inspect open: first
  the page's snapshots since its last navigation, 16 MB at most, then each new one, 12 a second at most. Past 16 MB,
  the oldest snapshots after a frame's full one are left out, never the full one, which the others build on; a large
  trace starts from the page's last navigation. A snapshot is 4 MB at most. Each waits once, a second at most, behind
  the view's images, then goes, and its bytes space the images after it: the image can slow while Inspect sends.
- **The stylesheets, fonts and images a page names**, once per run, 2 MB each at most, each sent only when its bytes
  are of the kind its type says; fonts are WOFF, WOFF2, TTF, OTF, font collections and EOT alone. Never a script, a
  document, an SVG or an SVG font.
- **Secrets.** Before a page leaves the worker, the value of each field that holds a secret is removed: a password, a
  one-time code, a card's number or code, a field whose name, label (an `aria-labelledby` one too) or `autocomplete`
  names one. So is any text equal to a value the test's secret fields held or its calls typed into one, and anything
  that reads as a card's number: each reads `<hidden>`. Each address in the page (its links, sources, forms, its own
  and its stylesheets') and each text and attribute value has its credentials hidden, as the
  [page's events](./live-view-layers#page-events) do: a URL's password, a query value named or shaped like a token, a
  key's or a JWT's shape anywhere. A `meta` named for a token, a key or a secret has its content hidden. The dashboard
  hides fields, credentials and those `meta` again before it renders a page: a secret field shows empty.
- **No page the worker could not clean**: one whose secret fields it could not read, or whose snapshot it could not
  read whole (deeper than 512 levels, more than 500,000 nodes, or naming one it no longer holds).
- **A project with Masked elements gets no page.** Its masks are locators, which a snapshot cannot apply. As a project
  starts masking elements, the dashboard lets go of every page it kept of its live runs and takes no more.
- **No script of the page runs.** The worker empties a script Playwright kept (an SVG's) and leaves out an attribute
  whose address runs one. The dashboard renders each page itself, its scripts, inline handlers and `javascript:`
  links left out, in a sandboxed frame that loads nothing from the network.

## What the dashboard keeps

The pages and their resources stay in the dashboard server's memory, for the run alone, and only those of each
worker's running test: a worker's pages go as its test ends. It keeps each worker's latest 32 MB of pages (8,192 at
most), 128 MB for the run's workers together (32,768), the resources they name, the 64 MB used last (4,096), and the
8 rendered pages read last, until one they are built from goes. Every live run's together take 512 MB at most:
past it, no new page is kept until runs end. Nothing goes to the database, the disk, the logs or an export, and it all
goes when the run ends.

Who sees them: who may open the run, each from their own view, as for the [images](./live-view#what-is-sent-to-whom-and-what-is-kept).
The dashboard takes pages only from a worker someone inspects: 24 a second from each worker, 8 MB of resources a
second, and 16 MB of pages and resources a second from the run's workers together, apart from their images.

## When no page comes

Inspect says why:

- **The project masks elements.** When the worker's reporter cannot read the masks, Inspect asks to update it.
- **The trace takes no DOM snapshots** (`snapshots` off, or in Playwright 1.64 an object without `dom`), the browser
  keeps no trace folder, or the test traces itself: open Inspect again once its trace stopped.
- **A page not sent**: its secret fields or its snapshot could not be read, it passes 4 MB, Inspect fell behind the
  test's calls (16 MB waiting), or the page's full snapshots alone pass 16 MB. Most say Inspect sends it again from
  its next navigation.
- **A page no longer kept**: let go at the bounds above, of a test that ended, or as the project began masking
  elements; built on a page the worker did not send; or one the dashboard cannot read whole or render in time.
- **The view ended**: the run ended, the live view was turned off, the test ended, or the view closed.

## Limits

- **The test's `page`, its main frame.** An iframe's content is not shown, nor another page of the test.
- **A worker of an older reporter** sends no page: Inspect waits for one.
- **A trace's snapshots, not the live page.** A page shows what Playwright recorded at a call: an element that
  appears between two calls shows at the next.

## In the demo

The live demo runs no browser, and Inspect needs a running test: [Watch all](./watch-all#in-the-demo).

## Related

- [Live view of a run](./live-view): turning it on, and the image and call of one worker
- [Page events, text and filmstrip](./live-view-layers): what the page and its requests said, beside the image
- [Failure evidence](./evidence): the DOM snapshot and the picker of a finished test
- [Share a run live](./share-live): a run on your machine, watched from the dashboard
