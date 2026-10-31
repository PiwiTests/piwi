---
title: End the test
description: "End a stopped test where it stands, from the editor, the pause bar, Piwi Picker's Runs window, the desktop app or an agent: the call it stopped before never runs, and Playwright reports the test as skipped."
lang: en-US
---

# End the test

<Needs fixtures />

At a stop, **End the test** ends the test there, as if it had called `test.skip()` at that line: the call it stopped
before never runs, nor the rest of the test, and Playwright reports it as skipped, its `skip` annotation reading
`Ended from Piwi`. The run goes on with its next test. Use it once you have seen what you stopped for, or recorded the
steps you were missing, and the rest of the test has nothing to show you.

## Where it is

It is offered at any stop but a failure, with a reporter newer than 0.62.0:

- **VS Code**: **End test** on the stopped line's CodeLens and in its hover, the status bar beside **Finish**, and
  **Piwi: End the test here, skipping the rest of it** in the palette. It has no key: bind one in **Preferences: Open
  Keyboard Shortcuts** (search `piwi`).
- **A JetBrains IDE**: **End Test** in the stopped line's inlay and the arrow's menu, **Tools → Piwi → End the Test**
  and the status bar item's menu. Give it a key in **Settings → Keymap**.
- **The [pause bar](./editor-breakpoints#pause-a-run)**: **End the test**.
- **Piwi Picker's [Runs window](./runs-window)** and the desktop app's [Local runs tray](./desktop-runs): **End the
  test**, beside **Finish**.
- **An [agent](./agent-run-control)**: `run_control` with `end`, answered as the test ends.

## What runs, and what does not

- **At a locator call or an assertion** (`click`, `fill`, `expect(locator).toBeVisible()`), the call is given up
  before it runs, with Playwright 1.62 or later; an older one runs it first, and the editor says so. At a
  `page.pause()`, nothing after it runs.
- **At another call** (a navigation, a key press on the page, `page.evaluate`), the call runs first: Piwi does not
  hold it. The test is skipped at its next locator call, or as its function ends, and the editor says so.
- **At a failure**, it is not offered: **Resume** lets the test end as it failed, and the failure is kept.
- **In a `beforeEach` hook**, it skips the test. **In an `afterEach` hook or a fixture's teardown**, the test's
  function already ended: it goes on as **Resume** does, keeping the test's result, and says so. Piwi never stops in a
  `beforeAll` or `afterAll` hook.
- **After it**, the test's `afterEach` hooks and its fixtures' teardown run as after any skip, so its page closes as
  usual, with nothing of Piwi left in it.
- **A retry** is an attempt of its own. Playwright does not retry a skipped test; a failure you let end runs the next
  attempt, which stops at your breakpoints as the first did.

## Limits

- **Playwright's calls alone.** The test's own code between two calls, a loop or a helper, runs until its next call.
- **One test.** It ends the stopped worker's test; the run's other tests run. To end the run, **Stop** it (one Piwi
  started) or end it in its terminal.

## Related

- [Pause and step from the editor](./editor-run-control): the other controls at a stop.
- [Breakpoints in the browser](./editor-breakpoints): the pause bar.
- [Runs window](./runs-window): the same controls from Piwi Picker.
- [Run control for agents](./agent-run-control): `run_control` and the other tools.
