---
title: Page events, text and filmstrip
description: "Under the live view of a running Playwright test: its page's console errors, failed and slow requests and backend errors, its text as roles and names, and a filmstrip of its calls, masked in the worker and never stored."
lang: en-US
---

# Page events, text and filmstrip

<Needs reporter fixtures />

Under the image of a worker's [live view](./live-view), the panel also shows what the image cannot: what the page and
the test's requests said, the page as text, and a filmstrip of the test's calls. It is for a test that fails or waits
for a reason the pixels do not show: a console error, a request that never answered, a 500 and the exception the
backend logged for it. Each part comes from the worker only while the panel shows it, in a CI run or a run
[shared from a developer's machine](./share-live), and the dashboard stores none of it.

## Page events

**Page events**, open by default, lists as they happen, newest first:

- **Console errors** and **uncaught errors** the page threw;
- **failed requests**: no answer, or a status of 400 or more;
- **pending requests**, once one has waited 5 seconds for its answer: one line whose time grows
  (`POST /api/checkout`, pending for 17 s), then says how long it took;
- what the backend **logged** while it answered, errors and warnings, under the request it answered, from its
  [backend instrumentation](/guide/backend-logs);
- the test's **API calls** through Playwright's `request`, with their status and time: a test with no page shows these.

Addresses and texts reach the dashboard with their credentials hidden. A worker sends 20 events a second at most and
counts the others, the dashboard counts those a page reading too slowly could not take, and the list keeps the latest
100; each says how many it left out. Folding the section stops them coming.

## Page text

**Page text**, folded by default, shows the page as roles and names when you open it, as Playwright's ARIA snapshot
writes it (`- button "Pay €84.90" [disabled]`): what a screen reader would read, searchable and selectable at any width.

- **Where it comes from**: the test's own trace, when the project's trace takes ARIA snapshots (`snapshots.aria`;
  `wrapConfig`'s does not), a new one after each call. Otherwise the worker reads the page as you open the section or
  choose **Read again**: about 8 levels deep, which can hold a heavy page's test up for 120 to 300 milliseconds.
- **Find in the text** ignores case and accents, and says how many matches it has.
- **The element the call waits on**, when its locator names it by role and name, label, placeholder or text
  (`getByRole('button', { name: 'Pay' })`), is marked in the text.
- **Masked in the worker**: the value of a password, PIN, one-time code or card field, anything that reads as a card's
  number, the values the page's secret fields hold, and the project's **Masked elements** read `<hidden>`. A masked
  element the snapshot cannot name sends no text, and the section says why.

A text is 96 K characters and 192 KB at most, and says so when it is cut.

## Filmstrip

Under the image, the **filmstrip** shows the page after each call of the test that ended, one small image a call; a
click on one shows it larger, with its call's title. The worker takes them from the view's own images, masked as its
frames are, 320 by 200 pixels at most, only while someone watches, and keeps the current test's strip in its memory,
40 images at most. A view that opens later gets that strip at once: from the test's start, when someone watched it all
along.

## What is sent, and what is kept

- **Only what a panel shows.** The worker sends events while a panel shows **Page events**, the text as one opens
  **Page text**, and the filmstrip while a panel shows the worker; to those panels alone.
- **Bounded.** The dashboard relays at most 40 events, 4 texts and 16 filmstrip images a second of a worker; the images
  count against the [bytes](./live-view#limits) a run's workers and each page may send, and a page past its bytes gets
  the filmstrip's images a little later, in their order.
- **Nothing is kept.** As with the images, the dashboard relays each part and drops it: never written to the database,
  the logs or an export. The panel holds the parts of the test it shows in the browser's memory, until the view moves
  to the next test or closes.

A worker of an older reporter sends none of them: the sections stay empty, and **Page text** says no text came.

## In the demo

The live demo runs no browser, so its runs have no worker to watch in full: [Watch all](./watch-all#in-the-demo)
names each worker's step, and the panel with its events, text, filmstrip and Inspect never opens.

## Related

- [Live view of a run](./live-view): turning it on, and the image and call of one worker
- [Watch all workers](./watch-all): every worker of a run at once
- [Inspect a running test's page](./live-inspect): the page at each call as a document, with the locator picker
- [Backend logs](/guide/backend-logs): what the backend instrumentation attaches to a response
- [Failure evidence](./evidence): the console, network and ARIA a finished test keeps
