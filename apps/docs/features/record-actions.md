---
title: Record a test
description: "Record clicks and fills across a site's pages with Piwi Picker into a runnable Playwright test, with checks of what the page shows and the evidence of each step, replayed before you copy it."
lang: en-US
---

# Record a test

<Needs extension />

**Record**, the first tile of Piwi Picker's popup (`1`), captures what you do on a site, across its pages, and turns it
into a runnable Playwright test. The same recording becomes a [bug report](./report-a-bug) once you mark something
the page gets wrong; this page covers the recording itself and a test that passes.

<figure>
  <video src="/videos/picker-record-loop.mp4" autoplay loop muted playsinline controls aria-label="Recording on a shop page: a search typed, a mug added to the cart, a coupon applied, each counted on the recording bar as a step, then Finish opens the finish panel with the steps and the test to copy"></video>
  <figcaption>Each action becomes a step on the bar; Finish opens the finish panel.</figcaption>
</figure>

## Starting a recording

The first time on a site, Record asks the browser for access to it, so the recorder can follow you from page to page.
The popup closes once the browser's prompt shows, and the recording starts when you allow it. If you refuse, nothing is
recorded, and the next time you open the popup it says the recording did not start because Piwi Picker was not allowed
on the site. While the recording runs, a red border marks the tab and the popup's first tile reads **Finish (3)**, with
the number of steps so far.

The recorder captures clicks, double clicks, fills, checks, choices, drags, the names of chosen files (never their
content), the keys that submit, close or move through a list, a click on what a hover shows, and the browser's
**Back**, **Forward** and reload as a step to the page they reach. Each element is recorded with up to five locators
that find it alone, ranked, so a replay has others to try when one no longer holds. Passwords are never captured, nor
a card number, its security code or a one-time code in a field whose `autocomplete` names it: the test reads them from
`process.env`.

## The recording bar

A bar in a corner of the page lists the last steps and holds the recording's tools:

- **Check an element**: pick an element, then choose what to check: its text, its value, its name as screen readers
  announce it, or its state (visible or hidden, usable or grayed out). The dialog starts from what the page shows, on
  its **The page shows** line; keeping it records an `expect(…)` that passes.
- **Check the address**: an `expect(page).toHaveURL(…)` of the page you are on, starting from its path.
- **Something is missing**: an element that should be on the page and is not.
- **Screenshot**: the page as it is now, while the debugging protocol takes the screenshots (below).
- **Pause** stops capturing without ending the recording, on every page and tab of it, so signing in or closing a
  banner stays out of the test, until **Resume**.
- **Finish** ends the recording and opens the finish panel.

Changing what a check expects, or naming something missing, marks the page as wrong and makes the recording a bug
report: [Record a bug report](./report-a-bug). When the bar covers something you need to click, its four-arrow button
(**Move this bar to another corner**) moves it to the next corner, where it stays on every page. Under its buttons, the
bar lists the [test functions](#matching-functions) the steps look like, with a connection, then the evidence collected
so far.

## Evidence

Every recording keeps the evidence a bug report needs, whether or not you mark anything wrong: the console errors, the
failed requests, screenshots, a screenshot of each step, and the window's size, which the test sets with
`page.setViewportSize`. In Chrome and Edge it reads them through the browser's
[debugging protocol](./extension#the-debugging-bar), so Chrome shows its bar saying Piwi Picker started debugging the
browser for as long as the recording runs; the recording bar says why, and Chrome's bar goes when you finish. In
Firefox, or once that bar is cancelled, a script in the page reads the console and the requests instead, and the
popup's **Take a screenshot** (`S`), which takes Replay's place while a recording runs, takes the screenshots. What is
kept, and how: [Evidence](./report-a-bug#evidence). Nothing leaves the browser unless you send it.

## The finish panel

**Finish**, on the bar or in the popup, opens the finish panel: a **Title**, filled with the first page's own title (or,
left empty, the first step in words), which names the test; the steps, each step a test function covers marked with its
name; a line summing up the evidence; and a checkbox to keep or leave out the screenshot of each step. Then two rows of
actions:

- **Copy test** copies a runnable Playwright test that opens the addresses as recorded and waits for each page it
  opens. With steps that match your test functions, it calls them, and **Without your functions** copies the same test
  with locators only.
- [**Send to editor**](./editor-recording#send-from-piwi-picker), with an editor paired, inserts it at the editor's
  cursor.
- [**Replay**](./replay-a-bug-report) plays the steps again in the tab, to see that each still finds its element.
- **Copy report** copies the recording as Markdown, **Download .piwibug** saves its steps, its test and its evidence as
  one [file](/reference/bug-report-file), and **Send to Piwi…**, with a connection, sends it to your instance after a
  [preview](./bug-reports#sending-a-report).
- **Discard** drops the recording.

Until you discard it, the popup's first tile reads **Review (7)** and opens the finish panel again. Once a step is marked
wrong, the panel is a bug report's and **Copy test** becomes **Copy failing test**:
[The report](./report-a-bug#the-report).

<figure>
  <img src="/screenshots/picker-record.png" alt="The finish panel after a recording: its title, seven steps and Copy test">
  <figcaption>The finish panel: every step, the test one click away.</figcaption>
</figure>

## Matching functions

With a connection, the recorder loads the [function catalog](./test-functions) of the project mapped to the page and
ranks, while you record, the functions the steps look like, under **Matching test functions** on the bar. In the copied
test, a complete match becomes a call to your function. No AI: it scores your registered functions' DOM patterns.

## Limits

- It follows one site, in the top-level document only: see the [extension's limits](./extension#limits).
- [Recording from the editor](./editor-recording) uses the same bar with the checks only: it marks nothing wrong,
  keeps no evidence and writes the code in the editor instead of a finish panel.

## Related

- [Record a bug report](./report-a-bug): the same recording, with what the page should show and the evidence
- [Replay a recording](./replay-a-bug-report): play recorded steps again in a tab
- [Bug report file](/reference/bug-report-file): what **Download .piwibug** saves, `steps.json` included
- [Send to editor](./editor-recording#send-from-piwi-picker): the test inserted in VS Code or a JetBrains IDE
- [Browser extension](./extension): the other tools, the permissions and the limits
