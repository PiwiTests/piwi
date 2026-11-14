---
title: Record tests from the editor
description: "Record a Playwright test from VS Code or a JetBrains IDE: a browser your project's own Playwright opens, and each step you take there written at the cursor as you go, with locators verified on the page and calls to your own page objects."
lang: en-US
---

# Record tests from the editor

<Needs editor />

**Piwi: Record here…** opens a browser through your project's own Playwright and writes what you do there at the cursor,
as you do it: steps inside a test, a page object's method or a helper function, a new test anywhere else in a spec. It
works in VS Code (and Cursor, VSCodium) and in the JetBrains IDEs with the
[Piwi plugin](./jetbrains), and needs no instance, no desktop app and no browser extension.

<figure>
  <video src="/videos/editor-recording-loop.mp4" autoplay loop muted playsinline controls aria-label="VS Code beside the browser the project's Playwright opened: Piwi: Record here at a blank line of a test, then a coupon typed and applied and the total checked in the browser, each step written in the test as it is made, the coupon's two steps becoming a call to the page object's applyCoupon, and Stop ending the recording with Run and Verify ×3 offered"></video>
  <figcaption>Record here: the steps written as you go, folded into your page object's method.</figcaption>
</figure>

## Start a recording

| Editor | Record at the cursor | Record a new test file |
|---|---|---|
| VS Code | **Piwi: Record here…**, from the command palette, the editor's context menu (**Piwi** submenu) or a spec's editor title; any editor's title shows **Stop recording** while one runs | **Piwi: Record a new test file…**, also in the explorer's **Piwi** submenu while the editor is connected to an instance |
| JetBrains IDE | **Tools → Piwi → Record here…**, **Alt+Enter** or **Alt+Insert** (Generate), or the editor's context menu (**Piwi** submenu) | **New → Playwright test (recorded)…** on a folder of a Playwright config, or the project view's **Piwi** submenu |

Before the browser opens, the editor asks for:

1. **The start page**: a path on the project's `baseURL`, or an address; left empty, the browser opens the `baseURL`.
2. **The page the steps run on**, when the code around the cursor offers several: `page`, a fixture such as
   `adminPage`, or `this.page` in a page object. A fixture named like a page object (`todoPage`) comes after `page`
   until the test calls a page method on it. Any other expression can be typed.
3. **The Playwright project**, when the config has several. The browser gets its `use` options: `baseURL`,
   `storageState`, the viewport and device, the locale, the extra headers and `testIdAttribute`.

The editor offers your last answers. A new spec goes beside the one at hand, else in `testDir`, and receives the whole
recording.

## While it records

- **The block** the recording writes is tinted and marked in the gutter, and written again as each step arrives: a run of steps becomes one call
  to your own page object or helper once its last step is recorded. Started on a line inside a call that spans several
  lines, the block goes after that statement.
- **The controls**: the step count, **Stop** and **Pause** (**Resume** while paused), above the block in VS Code and in
  a banner above the editor in a JetBrains IDE, and **Pause**, **Stop** and the checks in the browser's recording bar. The status
  bar shows the recording too. While paused, from the editor or the browser, what you do in the browser is not
  recorded: use it to reach a page or set up data without writing those steps; **Resume** continues from there.
- **Checks**: **Check an element** in the browser's recording bar lets you pick an element and check its text, its
  value, its accessible name or its state, starting from what it shows now; **Check the address** checks the page's
  address. Each is written as an `await expect(…)` where you added it.
- **Typing in the block** pauses the recording. **Resume** writes the block again from the recorded steps, over your
  edits; **Keep my edits** stops the recording and keeps the code as you changed it.
- **Warnings** (a [brittle locator](/reference/locator-stability), a password read from the environment, a file to upload) are on their lines. They stay
  after the recording, each until its line is edited.

What the code holds, from locators to imports, and the options in the Playwright config that shape it:
[Recorded code](./recorded-code).

## Stop and undo

**Stop** in the editor or in the browser's recording bar, or closing the browser, ends the recording, and the code stays.
Closing the file ends it too. One **Undo** then removes the whole recording, imports included. In VS Code, a save or an
edit of the file during the recording starts a new undo step, so your own changes stay undoable on their own; in a
JetBrains IDE, that Undo also takes back the edits you made in the file meanwhile, and Redo brings everything back.

### Run it, or verify it three times

Once the recording stopped, a notification says what it wrote, `Recorded 6 steps into checkout.spec.ts.`, with two
actions for the test that holds the block, the new test or the test you recorded steps into:

- **Run** runs that test, with your breakpoints, as **Piwi: Run the test at the cursor** does.
- **Verify ×3** runs it as a [verification](./editor-runs#when-your-run-ends), as **Piwi: Verify the test at the
  cursor ×3** does.

Both save the file, then run the test by the line of its `test(…)` call
(`npx playwright test tests/checkout.spec.ts:42`), so neither needs an instance. A verification that reached none is
told by its exit code, which cannot tell a pass from a skip: `None of 3 runs failed: tests/checkout.spec.ts:42`, or
`Failed at least 1 of 3: tests/checkout.spec.ts:42 (exit code 1)`. Steps recorded into a
page object or a helper offer neither action: no test holds them.

### Choose another locator

The recorder keeps up to five locators for each element it acts on, each verified to find that element alone on the
page, and writes the best one. Once the recording stopped, a warning on a step that has other locators offers each of
them as a quick fix, best first: **Use getByTestId('pay')** in the light bulb menu in VS Code, with **Alt+Enter** in a
JetBrains IDE. It puts that locator in place of the one written on the line, as one edit that **Undo** takes back, and
the line's warning goes. While the recording runs, none is offered: each step writes the block again.

The quick fix replaces the locator only where the line holds it once, as it was written: a line that calls your own
page object or helper has none of its own, and offers none.

## Send from Piwi Picker

A locator picked with the [Piwi Picker](./extension) browser extension in your everyday browser, or a flow it
recorded, lands at the editor's cursor too, once Piwi Picker is [paired with the editor](./editor-pairing). A picked
locator's row, the top locator of the [Elements sidebar](./devtools#the-elements-sidebar), the
[Locators console](./devtools#the-piwi-panel) in DevTools and the recording review then show **Send to editor**. A
locator is inserted in the copy form you chose; a recording is rendered as the body of a test, like
[`piwi codegen --body`](/reference/cli#codegen), or as a new test outside one. With no editor open, a JetBrains IDE
puts it in a new scratch file. A locator picked at a stop of a run Piwi starts reaches the editor the same way.

## Limits

- The browser is the one your tests use, installed by Playwright (`npx playwright install chromium`).
- Your project's Playwright runs with the first `node` on the editor's `PATH` in VS Code (when it is Node 20 or later,
  else with the editor's own runtime), and with the project's Node.js interpreter in a JetBrains IDE.
- The recording does not start your `webServer`: start the application first.
- It records the top-level page: clicks inside an iframe, and steps in a popup or a new tab, are not recorded yet. The
  editor says so when the application opens a tab or a popup.
- A file takes one recording at a time.
- A recording starts on a fresh page. To record where a test already is (signed in, halfway through a flow), pause the
  test there and [record from the pause](./editor-breakpoints#record-from-a-pause).

## Related

- [Recorded code](./recorded-code): what a recording writes, and the options that shape it.
- [Editor extensions](./editors): everything else the editor shows from your suite.
- [Piwi Picker](./extension): records in your everyday browser, for a bug report or a steps file.
- [Test functions](./test-functions): the page objects and helpers a recording calls.
