---
title: Breakpoints in the browser
description: "Set a breakpoint in VS Code or a JetBrains IDE and the next test run Piwi starts pauses there in a headed browser, with a bar to resume, step, pick a locator that replaces the one on that line, or record the steps that come next."
lang: en-US
---

# Breakpoints in the browser

<Needs reporter fixtures />

A breakpoint you set with the editor's own gutter click pauses the next test run the [editor extensions](./editors)
start, in the browser, right before the locator action or assertion on its line. Piwi's bar at the top of the page lets
you look at the page, step through the actions, or pick a better locator, which lands back on that line in the editor.
It is not Playwright's inspector, and no debugger attaches: the test waits in the browser.

## Pause a run

1. Set a line breakpoint on a line that calls a locator, in a spec or a page object:
   `await page.getByText('Pay now').click();`.
2. Run the test from Piwi: **Run this test**, the lines above a locator, **Piwi: Run the tests that reach this file**,
   **Piwi: Run selection…** or **Re-run the failing tests** ([Runs from the editor](./editor-runs#run-tests)).
3. The run opens a headed browser. Before the action on your line runs, its element is highlighted and the pause bar
   appears: `Paused at login.spec.ts:42 · click · getByText('Pay now')`.

| Button | What it does |
|---|---|
| **Resume** (<kbd>Esc</kbd>) | Runs on to the next breakpoint |
| **Step** | Pauses again before the next locator action or assertion, breakpoint or not |
| **Pick a locator** | Opens Piwi's [element picker](/features/locator-healing#pick-a-replacement-locator-on-the-failing-page-local-runs): pick the element, choose stable parents, confirm a ranked locator; the bar comes back after |
| **Record here** | Records what you do in the page into the editor, above the paused line: [Record from a pause](#record-from-a-pause) |
| **Finish** | Runs on without pausing again in this test |

<figure>
  <img src="/screenshots/picker-pause.png" alt="A shop page in the browser, paused before a click on Checkout: the button highlighted, Piwi's pause bar at the top with Resume, Step, Pick a locator, Record here and Finish">
  <figcaption>A run paused before the click on <strong>Checkout</strong>: the element highlighted, and Piwi's bar at the top of the page.</figcaption>
</figure>

The page under the bar stays live: scroll it, open the browser's developer tools, or click through it before you
resume. The test timeout stops while the test is paused, and the test has the time it had left once it resumes.

## Where the pick lands

A locator you confirm replaces the locator chain on the breakpoint's line, in the file as it stands, saved or not:
`page.getByText('Pay now').click()` becomes `page.getByRole('button', { name: 'Pay now' }).click()`, and a
notification says so. When the line holds no locator, because you edited it during the pause or it takes its locator
from a page object (`checkout.payButton().click()`), the locator is inserted at the cursor instead, and the
notification says why.

The pick is also printed in the run's terminal (`[piwi] Locator picked at tests/login.spec.ts:42: getByRole(…)`) and
recorded in the run's locator snapshots, so the [Locator fix](/features/locator-healing) panel shows it as **Your
pick** once the run uploads.

The run reaches the editor through the address [Piwi Picker sends to](./editor-recording#send-from-piwi-picker): VS
Code starts its listener when a run with breakpoints starts, and the JetBrains plugin answers on the IDE's built-in
server. Nothing is copied to the clipboard.

## Record from a pause

**Record here** hands the paused page to the editor's [recorder](./editor-recording): the steps you take from there
are written into the file on a new line above the paused statement (the first line of a statement broken over lines),
on the page expression in scope there, as **Record here** in the editor writes them, but with no `page.goto`: the page
is where the test left it, signed in and filled in as the test made it. The editor opens the file at that line and
starts recording without asking anything. Pause and Stop are in the recorder's bar in the page and in the editor; once
you stop, the pause bar comes back, and **Resume** runs the rest of the test from the page as you left it, which checks
at once that the new steps fit what follows.

`await page.pause()` in a test does the same without a breakpoint: in a run Piwi starts, it shows Piwi's pause bar there
in place of Playwright's Inspector, with **Record here** among its buttons, and Piwi adds `--headed` to a run whose
spec holds a `page.pause()` call. The `page.pause()` line stays, so the next run can record from there again; remove
it when the test is done. In a run Piwi did not start, and in a headless one, `page.pause()` is Playwright's own.
**Record here** records http(s) pages: on a page the test made with `setContent`, or a `file:` page, the editor says
so and nothing is recorded.

The test reaches the editor through a socket on your machine that the editor service opens, readable by you only,
named in the run's environment as `PIWI_RECORD_CHANNEL`. A recording the editor does not start within 30 seconds is
refused, and the test goes on.

## The setting

Breakpoints are on by default. Turn them off with the `piwi.breakpoints` setting in VS Code, or **Pause the runs Piwi
starts at the editor's breakpoints** under **Settings → Tools → Piwi** in a JetBrains IDE, kept on your machine only.
With the setting off, a run started from Piwi ignores the editor's breakpoints.

## What it needs

- **`@piwitests/reporter` 0.48.0 or later**, with the [capture fixtures](/guide/capture-fixtures) in your tests: the
  pause runs in them. The status bar's tooltip names the reporter version the project installs. With an older one,
  the run starts anyway and the editor warns once: `Breakpoints need @piwitests/reporter 0.48.0 or later; this project
  has 0.46.0.`
- **A run started from Piwi.** The editor passes the breakpoints under the Playwright config's folder to the run as
  `PIWI_PAUSE_AT` (`tests/login.spec.ts:42;tests/pages/checkout.page.ts:9`, relative to that folder, separated by
  semicolons), with its pairing address as
  `PIWI_EDITOR_SEND`, and adds `--headed` to the command unless it already has `--headed`, `--ui` or `--debug`. Set
  `PIWI_PAUSE_AT` yourself to [pause a run you start](/features/locator-healing#pause-at-a-breakpoint-local-runs).

## Limits

- **Headed and local only.** Under CI (`CI` set to anything but empty or `false`) or in a headless browser, the run
  ignores the breakpoints and says why once in its output.
- **Only locator actions and assertions pause**: `click()`, `fill()`, `expect(locator).toBeVisible()` and the like. A
  breakpoint on `page.goto`, on a helper call or on a line with no locator call does nothing. A breakpoint on the line
  of a page object method that runs an action pauses every test that calls the method.
- **Every attempt pauses.** With retries, a test pauses again on its retry, and the bar says `attempt 2`.
- **Each worker pauses its own browser.** When several tests reach a breakpoint, run them with `--workers=1` to pause
  one at a time.
- Stepping through the test's JavaScript stays with the editor's own debugger and Playwright's; **Record here** is not
  offered from a debugger paused in your code, only from Piwi's pause bar.
- **Record here** records the paused page alone: a tab or a popup it opens is not recorded, as in any recording.

## Related

- [Runs from the editor](./editor-runs): the commands that start a run, and how the editor follows it.
- [Locator healing](/features/locator-healing): the picker, and the panel a pick shows in.
- [Editor extensions](./editors): the failures, lenses and quick fixes the editor shows from your suite.
