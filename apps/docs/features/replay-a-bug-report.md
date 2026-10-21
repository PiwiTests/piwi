---
title: Replay a bug report
description: "Play a bug report's steps again in a tab with Piwi Picker, with a cursor and a caption per step, and see whether the bug shows on your own dev server, or run them with Playwright in the desktop app."
lang: en-US
---

# Replay a bug report

<Needs extension />

**Replay** plays a [bug report](./report-a-bug)'s steps again in a tab, with a cursor that moves to each element and a
caption saying what it does, then says whether the bug shows there. It suits the developer who receives the report:
open the app on your own dev server, and the steps run there, with your session and your browser's developer tools at
hand.

## Choosing a report

- From the finished report, **Replay** plays it at once on the same site.
- From the popup, **Replay a bug report** (`R`) asks for the site's access if needed, then for the report: the
  [`.piwibug` file](/reference/bug-report-file) (or the same file named `.zip`) or its `steps.json`, the text of a
  `steps.json` pasted in, the report just recorded in this browser, or, connected, one of the project's reports on
  Piwi.
- From a failed execution on the dashboard, **Export → Bug report (.piwibug)** makes a report from the test run
  ([below](#a-report-made-from-a-test-run)), and **Steps (steps.json)** copies its steps to paste.

The steps run on the tab's site, whichever site they were recorded on. A step that opens its page in a new tab, such as
a link that opens an order beside the list, takes the replay to that tab, as the recording went on there.

## The answer

Each element is found with the locator the failing test uses, and waited for as Playwright waits: exactly one match,
visible, enabled and still. The replay ends with one of three answers:

- **Reproduced**: an expected result does not hold, such as a total that still reads "Total: 50", and the panel says
  whether that is the value reported.
- **Not reproduced**: every expected result holds here.
- **Could not reach the bug**: a step could not be played (it found no element, several, or a disabled one, or the
  flow ended on another page) and you stopped there. The data, the login or a flag differ here.
- **Failed at step 4, as in the test run**: in a report made from a test run, the step that could not be played is
  the one the test failed at.

Under the answer, the panel lists the failed requests and console errors the page showed during the replay, such as
"POST /api/cart/coupon answered 500". For a report from Piwi, **Share result…** records the answer on the report, with
the site it ran on, after showing what it sends.

**Step by step** waits for **Next** before each step, with the element outlined, so you can set a breakpoint first.

## When a step cannot be played

A step Replay cannot play is handed to you rather than ending the replay. The panel says why, names the step in words
and, when the report has [a screenshot of each step](./report-a-bug#evidence), shows the page as it began there, the
element outlined. It lists the locators the element was recorded with and outlines on the page every element they
still find, such as two buttons where the recording saw one, as the page changes. Do it yourself on the page, then
choose:

- **I did it, continue**: the replay goes on with the next step, even when your action loaded another page or opened
  one in a new tab.
- **Skip this step**: it goes on without it.
- **Stop here**: it ends there, and says it could not reach the bug.

Under the answer, the panel lists the steps played by hand.

## A report made from a test run

A `.piwibug` exported from a failed execution holds the test's steps up to the failure, setup hooks included, and its
failing assertion with what it expected and what the run received. What the run did not keep enough of to play
becomes a **manual step**, which Replay hands to you as above, with the line of the test it stands for: a click at a
point of the page, a value the run kept only in part, a file choice, a check with a regular expression. API requests,
scripts run in the page, route mocks and checks on values are not steps at all: the report's Markdown lists them under
**Not replayed**, with why.

When the test failed on an action rather than on an assertion, the report says which step; reaching it and failing
there answers **Failed at step N, as in the test run**, and playing it answers **Not reproduced**. A typed password is
never in the report: the step asks for it.

A test run does not keep the page each step happened on once a click may have opened another, so Replay does not
follow such a step into a new tab: it stays in the tab it started in, and a step the test played in a popup is handed
to you.

## Trusted input

In Chrome and Edge, Replay sends trusted input as Playwright does: a real hover, clicks, keys and drags that the page
cannot tell from a person's. Chrome shows its debugging bar until the replay ends. In Firefox, when the browser refuses
the session, once the bar is cancelled, or once the browser refuses one of its commands (the bar then closes), Replay
goes on with the page's own events; the panel says which, step by step.

A report names the files a step chose but never carries them: Replay asks you to choose them, or to skip the step.

With trusted input, each step plays at the viewport size it was recorded at, in CSS pixels whatever your zoom, and the
tab gets its own size back when the replay ends. Otherwise the panel says when the window's size differs from the recorded one, so you can resize it.

## Running it with Playwright

**Run with Playwright…**, beside **Start** and on a finished replay, sends the steps to the paired
[desktop app](./bug-reports#running-it-with-playwright-in-the-desktop-app), which runs them in your project once you
confirm it there.

## Limits

- It plays one site, in the top-level document only, as the report was recorded. A step that opens another site, or
  an address that is not a web page, is handed to you.
- **Share result…** and **Run with Playwright…** are the only parts that send anything, each after showing what it
  sends.

## Related

- [Report a bug](./report-a-bug): recording the report Replay plays
- [Bug reports](./bug-reports): the reports kept on your instance
- [Bug report file format](/reference/bug-report-file): what a `.piwibug` holds
