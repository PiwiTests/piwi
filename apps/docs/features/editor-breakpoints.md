---
title: Breakpoints in the browser
description: "Set a breakpoint in VS Code or a JetBrains IDE and the next test run Piwi starts pauses there, before a navigation, an action, a key press or an assertion: headless, its page shown in the editor; with Run headed, under a bar to resume, step, pick a locator that replaces the one on that line, or record the steps that come next."
lang: en-US
---

# Breakpoints in the browser

<Needs reporter fixtures />

A breakpoint you set with the editor's own gutter click pauses the next test run the [editor extensions](./editors)
start, in the browser, right before the call on its line that acts on, reads or checks the page: a navigation, a
click, a key press, an assertion. Piwi's bar at the top of the page lets you look at the page, step through the calls,
or pick a better locator, which lands back on that line in the editor. The stop is Playwright's own debugger
(`context.debugger`) without its Inspector: Piwi's bar answers it, and no JavaScript debugger attaches.

## Pause a run

1. Set a line breakpoint on a line with a Playwright call, in a spec, a page object or a fixture:
   `await page.getByText('Pay now').click();`, `await page.goto('/checkout');`, `await page.keyboard.press('Tab');`
   or `await expect(page).toHaveURL(/cart/);`. On a statement broken over lines, any of its lines will do.
2. Run the test from Piwi: **Run this test**, or any command of [Runs from the editor](./editor-runs#run-tests).
3. The test stops before the call on your line runs. A run Piwi starts follows your config, headless unless it sets
   `headless: false` or you chose **Run headed** ([How a run starts](./editor-runs#how-a-run-starts)): the editor
   marks the line and shows the stopped page ([A headless run](./editor-run-control#a-headless-run)). In a headed run,
   the pause bar appears in the
   browser with the call as Playwright names it, `Paused at login.spec.ts:42 · Click getByText('Pay now')`, and a
   locator call's element is highlighted.

The pause bar's buttons:

| Button                      | What it does                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resume** (<kbd>Esc</kbd>) | Runs on to the next breakpoint                                                                                                                                                                                  |
| **Step**                    | Pauses again before the next call that acts on, reads or checks the page, breakpoint or not                                                                                                                     |
| **Pick a locator**          | Opens Piwi's [element picker](/features/locator-healing#pick-a-replacement-locator-on-the-failing-page-local-runs): pick the element, choose stable parents, confirm a ranked locator; the bar comes back after |
| **Record here**             | Records what you do in the page into the editor, above the paused line: [Record from a pause](#record-from-a-pause)                                                                                             |
| **Finish**                  | Runs on without pausing again in this test                                                                                                                                                                      |
| **End the test**            | [Skips the rest of the test](./end-the-test)                                                                                                                                                                    |

<figure>
  <img src="/screenshots/picker-pause.png" alt="A shop page in the browser, paused before a click on Checkout: the button highlighted, Piwi's pause bar at the top with Resume, Step, Pick a locator, Record here and Finish">
  <figcaption>A run paused before the click on <strong>Checkout</strong>: the element highlighted, and Piwi's bar at the top of the page.</figcaption>
</figure>

The page under the bar stays live: scroll it, open the browser's developer tools, or click through it before you
resume. The test timeout stops while the test is paused; [a stop](/guide/concepts#stop) says which waits keep their
deadline, and how the dashboard counts the time paused.

## Where the pick lands

A locator you confirm replaces the locator chain on the breakpoint's line, in the file as it stands, saved or not:
`page.getByText('Pay now').click()` becomes `page.getByRole('button', { name: 'Pay now' }).click()`, and a
notification says so. When the line holds no locator, because you edited it during the pause or it takes its locator
from a page object (`checkout.payButton().click()`), the locator is inserted at the cursor instead, and the
notification says why.

The pick is also printed in the run's terminal (`[piwi] Locator picked at tests/login.spec.ts:42: getByRole(…)`) and
recorded in the run's locator snapshots, so the [Locator fix](/features/locator-healing) panel shows it as **Your
pick** once the run uploads.

The pick reaches the editor through the address [Piwi Picker sends to](./editor-recording#send-from-piwi-picker);
nothing is copied to the clipboard.

## Record from a pause

**Record here** hands the paused page to the editor's [recorder](./editor-recording): the steps you take from there
are written into the file on a new line above the paused statement (the first line of a statement broken over lines),
on the page expression in scope there, as **Record here** in the editor writes them, but with no `page.goto`: the page
is where the test left it, signed in and filled in as the test made it. The editor opens the file at that line and
starts recording. Pause and Stop are in the recorder's bar in the page and in the editor; once you stop, the pause bar
comes back, and **Resume** runs the rest of the test from the page as you left it, which checks that the new steps fit
what follows.

`await page.pause()` in a test does the same without a breakpoint: in a run Piwi starts or
[that follows your editor](./terminal-runs), or any headed run with breakpoints, it stops there under Piwi's pause bar
in place of Playwright's Inspector (headless, in the editor), with **Record here** among its
buttons in a run Piwi starts, and Piwi adds `--headed` to a run whose spec holds a `page.pause()` call. The
`page.pause()` line stays, so the next run can record from there again; remove it when the test is done. In any other
run, outside a test (a `beforeAll` or `afterAll`) and on a page of a browser the
test launched itself, `page.pause()` is Playwright's own, with its Inspector; in a headless browser it returns at
once.
**Record here** records http(s) pages: on a page the test made with `setContent`, or a `file:` page, the editor says
so and nothing is recorded.

The test reaches the editor through `PIWI_RECORD_CHANNEL`, the socket of
[the run's connection](./editor-run-control#how-it-works); a recording not started within 30 seconds is refused, and
the test goes on.

## The setting

Breakpoints are on by default. Turn them off with the `piwi.breakpoints` setting in VS Code, or **Pause the runs Piwi
starts at the editor's breakpoints** under **Settings → Tools → Piwi** in a JetBrains IDE, kept on your machine only.

## What it needs

- **`@piwitests/reporter` 0.48.0 or later**, with the [capture fixtures](/guide/capture-fixtures) in your tests: the
  pause runs in them. With an older one, the run starts anyway and the editor warns once. A reporter of 0.59.0 or
  older pauses before locator actions and assertions only. A spec that imports `test` from `@playwright/test` never
  stops, and the run's output names it once.
- **A run started from Piwi**, or [started outside Piwi](./terminal-runs). The editor passes the breakpoints under the
  Playwright config's folder to the run as `PIWI_PAUSE_AT` (`tests/login.spec.ts:42;tests/pages/checkout.page.ts:9`,
  relative to that folder), with its pairing address as `PIWI_EDITOR_SEND`. It adds `--headed` when you chose
  **Run headed**, or when the reporter stops only headed: older than 0.62.0, of an unknown version, or with no run
  channel to show a headless stop. Set `PIWI_PAUSE_AT` yourself to
  [pause a run you start](/features/locator-healing#pause-at-a-breakpoint-local-runs).

## Limits

- **The bar needs a headed browser, and a local run.** Under CI (a provider's variable such as `GITHUB_ACTIONS`, or `CI` not `false` or `0`) or
  Playwright's debugger (`--debug`, `PWDEBUG`), the run ignores breakpoints, saying why once, as does a headless
  run of yours with `PIWI_PAUSE_AT`; one Piwi starts stops with no bar, and the editor shows its page
  ([A headless run](./editor-run-control#a-headless-run)).
- **Only the calls Playwright's debugger stops at pause**: navigations, actions, key presses and mouse moves,
  assertions, `evaluate`, `waitForFunction`, screenshots and an element's reads (`textContent`, `inputValue`,
  `getAttribute`, `isVisible`, `count`). `waitForTimeout`, `waitForSelector`, `waitForURL`, `waitForEvent`, `title()`
  and `ariaSnapshot()` never do, so a breakpoint on such a line, on a helper call or on a line with no Playwright call
  does nothing. A breakpoint in a page object method pauses every test that calls it.
- **A run with breakpoints stops before every call** and lets those off your lines go on at once, at about a millisecond
  a call.
- **The paused call lasts as long as you looked** at the page, in Playwright's trace, its HTML report and the
  dashboard's steps; only the statistics leave it out.
- **A call the test ended under runs** as the bar goes away, during teardown, when the test fails under the bar or does
  not await the call; the call is waited for, up to two seconds, so its requests stay the test's.
- **One Inspector switch per worker.** While Playwright's own `page.pause()` runs, a stop in another context opens its
  Inspector too, and a context that opened one keeps it. A `page.pause()` on a browser launched through a second copy
  of Playwright shows neither bar nor Inspector and waits until the test's timeout.
- **Every attempt pauses.** With retries, a test pauses again on its retry, and the bar says `attempt 2`.
- **Each worker pauses its own browser.** When several tests reach a breakpoint, run `--workers=1` to pause one at a
  time.
- **Record here** is offered from Piwi's pause bar only, never from a debugger paused in your code.
- **Record here** records the paused page alone: a tab or a popup it opens is not recorded, as in any recording.

## Related

- [Runs from the editor](./editor-runs): the commands that start a run, and how the editor follows it.
- [Pause and step from the editor](./editor-run-control): the same stops, answered from the editor.
- [Locator healing](/features/locator-healing): the picker, and the panel a pick shows in.
- [Editor extensions](./editors): the failures, lenses and quick fixes the editor shows from your suite.
