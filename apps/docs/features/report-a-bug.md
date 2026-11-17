---
title: Record a bug report
description: "Record the steps to a bug in Piwi Picker, mark what the page gets wrong, and get a failing Playwright test, a Markdown report and a `.piwibug` file with the evidence, with no Piwi instance."
lang: en-US
---

# Record a bug report

<Needs extension />

Reproduce a bug in your browser, say what the page should show, and get the test that proves it. A
[recording](./record-actions) of the [Piwi Picker extension](./extension) becomes a bug report as soon as you mark
something on the page as wrong ("this should read Total: 36.00"): it then hands you a failing Playwright test, a
Markdown report and a `.piwibug` file for the developer, with the evidence every recording collects. Everything is
built in your browser; nothing is sent anywhere unless you send it to your Piwi instance. This page covers marking what
is wrong and what a report holds, with no instance; [Replay a recording](./replay-a-bug-report) plays one again, and
[Bug reports on your instance](./bug-reports) covers what an instance does with one sent to it.

<figure>
  <video src="/videos/picker-report-loop.mp4" autoplay loop muted playsinline controls aria-label="Recording a bug on a cart page: a coupon applied, the total checked with what it should read instead of what it shows, then Finish opens the report with its steps, its evidence and a failing test to copy"></video>
  <figcaption>Reproduce it, say what the page should show, finish: the report and its failing test.</figcaption>
</figure>

## Marking what is wrong

Open the popup on the page where the flow starts, choose **Record** (`1`) as [Record a test](./record-actions)
describes, and reproduce the bug. These tools of the recording bar say what is wrong:

- **Check an element**: pick the element, then choose what to check: its text, its value or its name as screen readers
  announce it. The dialog shows what the page shows now and an **Expected** field holding the same value: type what it
  should be instead. For a state, choose the one the element should be in and is not, such as **It should be hidden**
  or **It should be grayed out, not usable**.
- **Check the address**: type the path the flow should have reached, such as `/checkout/thanks`, in place of the one
  the page is on.
- **Something is missing**: say what should be there (a button, a link, a title, a text field, a dropdown, …) and its
  name, such as a button named "Download invoice". Piwi Picker looks for it on the page first and refuses one that is
  there already; use Check an element for that one.

Before you press **Add the check**, the dialog says which of the two it will record: a check that passes, or the page
marked as wrong, which makes the recording a bug report whose test fails until the page shows what you expect. Once it
is wrong, a **Note** field takes what happened, in your words. Each becomes a step of the recording, in place, with what
the page showed. **Finish** ends the recording and opens the report.

## Evidence

Every recording keeps, whether or not anything is marked wrong:

- **Console errors and warnings**, uncaught errors and unhandled promise rejections, with the page they happened on.
- **Failed requests**: the method, the path, and the status of any request that failed or answered 400 or more: in
  Chrome and Edge, documents, scripts and images included; elsewhere, the page's `fetch` and `XMLHttpRequest` calls. Query values are removed (`/api/cart/coupon?code=<redacted>`), ids and tokens in the path are collapsed
  as Piwi does for routes, and no header or body is ever read.
- **An outline of the page** around the element marked wrong, or of the page at **Finish** when nothing was: roles,
  names, states and field values, in the YAML form Playwright's ARIA snapshots use, at most 400 lines. Piwi Picker
  builds it from its own reading of the page, so it is an outline, not Playwright's snapshot. Password fields, and
  fields for a card number, its security code or a one-time code, never show their value.
- **Screenshots**, when something is marked wrong, at **Finish** and when you ask for one, three at most.
- **A screenshot of each step**: the page as the step began, with the element it acts on, for whoever has to
  [play that step by hand](./replay-a-bug-report#when-a-step-cannot-be-played). They show the whole page: leave them out
  in the report if they show what should not be shared. Taken through the debugging protocol, so mostly in Chrome and
  Edge.
- **The context**: the page, the browser and its version, the time and the extension's version.
- **The viewport size**: at the start, then after each resize or zoom change, with the zoom when it is not 100%. The
  test sets it with `page.setViewportSize` before the step it applies from, so a bug seen on a narrow window
  reproduces at that width.

The first 100 console entries and 100 failed requests are kept; the report counts the rest.

### How the evidence is collected

In Chrome and Edge, Piwi Picker reads the console, the requests and the screenshots of the tab the recording started
in through the browser's [debugging protocol](./extension#the-debugging-bar), from the page's first script, on every
page of the recording. Chrome's debugging bar shows from the start until you finish; the recording bar says it is
expected, and adds a **Screenshot** button.

Elsewhere (Firefox, the site's other tabs, or once the bar is cancelled), a small script added to the page itself
wraps `console.error`, `console.warn`, `fetch` and `XMLHttpRequest` without changing what they do, under the same site
access as recording, and is removed when you finish or discard the recording. A screenshot then needs the `activeTab`
grant: it works from the click that started the recording until the tab moves to another page; after that, open Piwi
Picker on the tab and choose **Take a screenshot** (`S`), which takes Replay's place in the popup while a recording
runs.

## The report

**Finish** opens the recording's [finish panel](./record-actions#the-finish-panel) as a report: a title to write, the
steps with the wrong ones highlighted, and a line summing up the evidence.

- **Copy failing test**, in place of **Copy test**, copies a Playwright spec for your suite, marked `test.fail()` so it
  keeps your CI green while the bug exists, tagged `@bug`, with paths instead of the recorded URLs, the most stable
  locator recorded for each element and, with a connection, calls to your test functions. What it holds, and what to
  do once it passes: [The failing test](./bug-reports#the-failing-test).
- **Copy report** copies the report as Markdown, for an issue or a message: the steps in plain words, what was
  expected and what the page showed, the notes, the console entries, the failed requests and the outline.
- **Download .piwibug** saves it all as one [file](/reference/bug-report-file), which Replay and the
  [desktop app](./desktop#importing-local-files) open. It is a zip archive: rename it to `.zip` to look inside, or to
  attach it to a GitHub issue. [`piwi codegen`](/reference/cli#codegen) renders its `steps.json` for any project.

Typed values stay as you typed them, except passwords, card numbers, their security codes and one-time codes, which
are never recorded: the spec reads them from an environment variable. Look over the report before you share it.

With the extension connected to an instance, **Send to Piwi…** sends the report after a preview: see
[Sending a report](./bug-reports#sending-a-report).

## Replaying a report

**Replay**, on the finished report or from the popup (`R`), plays the steps again in a tab and says whether the bug
shows there: see [Replay a recording](./replay-a-bug-report).

## Limits

- It follows one site, like any [recording](./record-actions), in the top-level document only.
- Without the debugging protocol, only the page's own `fetch` and `XMLHttpRequest` calls are seen: not images,
  stylesheets, a form that loads a new page, or a request made by a worker.
- A recording sends nothing anywhere: only **Send to Piwi…** does, after showing what it sends.

## Related

- [Record a test](./record-actions): the recording, its bar and its finish panel
- [Replay a recording](./replay-a-bug-report): playing a report again, in the browser or with Playwright
- [Steps file](/reference/steps-format): the format of `steps.json`
- [Bug report file](/reference/bug-report-file): what a `.piwibug` holds
- [CLI: codegen](/reference/cli#codegen): a steps file rendered as a spec for your project
- [Browser extension](./extension): every tool of Piwi Picker
