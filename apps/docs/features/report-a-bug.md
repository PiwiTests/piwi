---
title: Report a bug
description: "Record the steps to a bug in Piwi Picker, mark what is wrong, and get a failing Playwright test, a Markdown report and a `.piwibug` file with the evidence, with no Piwi instance."
lang: en-US
---

# Report a bug

<Needs extension />

Reproduce a bug in your browser, say what the page should show, and get the test that proves it. **Report a bug** is
a tool of the [Piwi Picker extension](./extension): it records your steps with the recorder, lets you mark what is
wrong ("this should read Total: 45"), collects evidence from the page, and hands you a failing Playwright test, a
Markdown report and a `.piwibug` file for the developer. Everything is built in your browser; nothing is sent anywhere unless you
send it to your [Piwi instance](./bug-reports).

## Recording the steps

Open the popup on the page where the flow starts and choose **Report a bug**, or press `B`. The first time on a site,
Piwi Picker asks for access to it, as [Record actions](./record-actions) does. From then on, clicks, fills,
checks, select changes, Enter and the browser's **Back**, **Forward** and reload are recorded across the site's pages,
and a red border marks the tab.

A panel in the corner lists the last steps (its four-arrow button moves it to the next corner when it covers something
you need to click) and offers three ways to say what is wrong:

- **Mark what's wrong**: pick the element, then choose what is wrong with it: its text, its value, its name as screen
  readers announce it, or its state (it should be hidden, visible, enabled or disabled). The panel shows what the page shows now and
  an **It should be** field holding the same value: type what it should be instead, and add a note if it helps.
- **Something is missing**: say what should be there (a button, a link, a title, a text field, a dropdown, …) and its
  name, such as a button
  named "Download invoice". Piwi Picker looks for it on the page first and refuses one that is there already; use
  Mark what's wrong for that one.
- **Wrong page**: type the path the flow should have reached, such as `/checkout/thanks`.

Each becomes a step of the recording, in place. **Finish** ends the recording and opens the report.

## Evidence

While a bug report records, Piwi Picker keeps:

- **Console errors and warnings**, uncaught errors and unhandled promise rejections, with the page they happened on.
- **Failed requests**: the method, the path, and the status of any request that failed or answered 400 or more: in
  Chrome and Edge, documents, scripts and images included; elsewhere, the page's `fetch` and `XMLHttpRequest` calls. Query values are removed (`/api/cart/coupon?code=<redacted>`), ids and tokens in the path are collapsed
  as Piwi does for routes, and no header or body is ever read.
- **An outline of the page** around the element you marked: roles, names, states and field values, in the YAML form
  Playwright's ARIA snapshots use, at most 400 lines. Piwi Picker builds it from its own reading of the page, so it
  is an outline, not Playwright's snapshot. Password fields, and fields for a card number, its security code or a
  one-time code, never show their value.
- **Screenshots**, at each mark, at Finish and when you ask for one, three at most.
- **A screenshot of each step**: the page as the step began, with the element it acts on, for whoever has to
  [play that step by hand](./replay-a-bug-report#when-a-step-cannot-be-played). They show the whole page: leave them out
  in the report if they show what should not be shared. Taken through the debugging protocol, so mostly in Chrome and
  Edge.
- **The context**: the page, the browser and its version, the time and the extension's version.
- **The viewport size**: at the start, then after each resize or zoom change, with the zoom when it is not 100%. The
  failing test sets it with `page.setViewportSize` before the step it applies from, so a bug seen on a narrow window
  reproduces at that width.

The first 100 console entries and 100 failed requests are kept; the report counts the rest.

### How the evidence is collected

In Chrome and Edge, Piwi Picker reads the console, the requests and the screenshots of the tab the report started in
through the browser's debugging protocol (the `debugger` permission), from the page's first script, on every page of
the recording. Chrome shows a bar saying Piwi Picker started debugging the browser until you finish; the panel says it
is expected, and adds a **Screenshot** button. Nothing leaves your machine.

Elsewhere (Firefox, the site's other tabs, or once the bar is cancelled), a small script added to the page itself
wraps `console.error`, `console.warn`, `fetch` and `XMLHttpRequest` without changing what they do, under the same site
access as recording, and is removed when you finish or discard the report. A screenshot then needs the `activeTab`
grant: it works from the Report a bug click until the tab moves to another page; after that, open Piwi Picker on the
tab and choose **Take a screenshot**.

## The report

**Finish** opens the report: a title to write, the steps with what you marked, and a line summing up the evidence.

- **Copy failing test** copies a Playwright spec for your suite: `test.fail()` so it keeps your CI green while the bug
  exists, the `@bug` tag, paths instead of the recorded site's URLs so your `baseURL` applies, the most stable locator
  recorded for each element, and a URL check after each step that leads to another page. The marked assertion carries
  the value the page showed as a comment:

  ```ts
  test.fail(); // passes while the bug exists; remove this line with the fix
  await page.goto('/cart');
  await page.getByRole('textbox', { name: 'Coupon' }).fill('SPRING10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('cart-total')).toHaveText('Total: 45'); // recorded: 'Total: 50'
  ```

  When the bug is fixed, the test passes and Playwright reports the expected failure as a failure: remove
  `test.fail()` and it guards the fix.
- **Copy report** copies the report as Markdown, for an issue or a message: the steps in plain words, what was
  expected and what the page showed, the notes, the console entries, the failed requests and the outline.
- **Download .piwibug** saves it all as one [file](/reference/bug-report-file), which Replay and the
  [desktop app](./desktop#importing-local-files) open. It is a zip archive: rename it to `.zip` to look inside, or to
  attach it to a GitHub issue. [`piwi codegen`](/reference/cli#codegen) renders its `steps.json` for any project.

Typed values stay as you typed them, except passwords, card numbers, their security codes and one-time codes, which
are never recorded: the spec reads them from an environment variable. Look over the report before you share it.

With the extension connected to an instance, **Send to Piwi…** shows exactly what would be sent, with a box per kind of
evidence, and sends it only when you click **Send**. The instance keeps the report, writes its failing test for the
project and follows its runs: see [Bug reports](./bug-reports).

## Replaying a report

**Replay**, on the finished report or from the popup (`R`), plays the steps again in a tab and says whether the bug
shows there: see [Replay a bug report](./replay-a-bug-report).

## Limits

- It follows one site, like [Record actions](./record-actions), in the top-level document only.
- Without the debugging protocol, only the page's own `fetch` and `XMLHttpRequest` calls are seen: not images,
  stylesheets, a form that loads a new page, or a request made by a worker.
- A recording sends nothing anywhere: only **Send to Piwi…** does, after showing what it sends.

## Related

- [Browser extension](./extension): every tool of Piwi Picker
- [Replay a bug report](./replay-a-bug-report): playing a report again, in the browser or with Playwright
- [Steps file](/reference/steps-format): the format of `steps.json`
- [Bug report file](/reference/bug-report-file): what a `.piwibug` holds
- [CLI: codegen](/reference/cli#codegen): a steps file rendered as a spec for your project
