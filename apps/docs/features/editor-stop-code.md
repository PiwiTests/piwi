---
title: Code from a pause
description: "At a test paused or failed in a run Piwi started from VS Code or a JetBrains IDE, write an assertion, a region's ARIA snapshot or a mock of a request the page made above the stopped line, pick a locator or record steps there, and see how many elements the locator at the cursor matches on the stopped page."
lang: en-US
---

# Code from a pause

<Needs reporter fixtures />

When a test stops in a run the [editor extensions](./editors) started, at a breakpoint, after **Pause** or **Step**,
or at a failure, the editor offers code written from the page as it stands: an assertion of what you see, a mock of a
request the page made, a better locator, the missing steps. The work on the page happens in the test's own browser;
the editor service writes the code, and the editor puts it above the stopped line. The controls that move the test
are on [Pause and step from the editor](./editor-run-control).

## The actions

| Action | What is written | Where it runs |
|---|---|---|
| **Pick a locator** | The locator of the element you pick, in place of the locator chain on the stopped line | The test's window, as the pause bar's [Pick a locator](./editor-breakpoints#where-the-pick-lands) |
| **Record here** | The steps you take, above the stopped line | The test's window, as the bar's [Record here](./editor-breakpoints#record-from-a-pause) |
| **Assert** | The check you choose in the recorder's check panel, `await expect(…).toHaveText(…)` and the like | The test's window |
| **Assert a region** | `await expect(…).toMatchAriaSnapshot(…)` with the ARIA snapshot of the region you pick | The test's window |
| **Mock a request** | `await page.route(…)` that answers as the server answered a request the page made | The editor alone, at any stop |

The first four need the pause bar, so a headed browser: a run Piwi starts with breakpoints is headed. **Mock a
request** works headless too.

- **In VS Code**, they are in the line above the stopped line, after the controls (named **Pick**, **Record**,
  **Assert**, **Assert region** and **Mock** there), in its hover, in the palette while a stop offers them (**Piwi:
  Assert in the stopped test's page**, **Piwi: Mock a request of the stopped test**…), and behind the status bar's
  `</>` item, **Piwi: Write code at the stop…**.
- **In a JetBrains IDE**, they are links in the inlay above the stopped line (by the same short names), in the
  gutter icon's menu, first in the status bar item's menu, and under **Tools → Piwi** (**Assert at the Stop**, **Mock
  a Request at the Stop**…).

None has a default key: bind one in **Preferences: Open Keyboard Shortcuts** or **Settings → Keymap** (search
`piwi`). A stop offers only the actions its reporter takes: with one that predates them, none.

<figure>
  <img src="/screenshots/vscode-run-control-code.png" alt="VS Code: a test paused before it types a coupon; above the line, the controls then Pick, Record, Assert, Assert region and Mock; at the line's end, Piwi: 1 match; at the top, the list of the requests the test made, to mock one">
  <figcaption>Mock a request lists the answers the test received; the line's locator matches one element on the paused page.</figcaption>
</figure>

## Where the code goes

The code goes on a new line above the stopped statement (the first line of a statement broken over lines), indented
for it, on the page in scope there (`this.page` in a page object), with the import of `expect` the file lacks, as one
edit that one undo takes away. A second action at the same stop goes above the same statement, under the first.
The running test goes on with the code it started with: the new lines run next time, which the first code of a run
says.

Nothing is written, and the editor says why, at a stop:

- outside a test's or a function's body, such as a test timeout stopped at its `test(` line;
- as the body of an `if`, `else`, `for`, `while`, `do` or arrow function (`() => page.click(…)`) without braces,
  or on a line where no statement starts;
- in a file written on disk since the run started, or unsaved as it started: Piwi follows a file through the edits
  the editor makes, not through another program's;
- that the test went on from: an action answers the stop it was offered at.

Assert and Assert a region check this before anything opens in the test's window. Code that arrives while you type in
its file is not written into the changed text: a warning offers **Copy the code**.

## Mock a request

In a run Piwi started, each worker keeps the text answers its test's pages received for `fetch` and
XHR requests, the latest 50, 256 KB each at most, in its memory only. **Mock a request** lists them, the latest first,
by method and URL (type to filter on the URL), with the status, the type, the size (`no size` when the response did
not say) and when it finished in the test. Only the answer you choose is read whole:

```ts
await page.route('**/api/shipping?country=FR', (route) =>
  route.fulfill({
    json: {
      "price": 4.9,
      "token": "<hidden>"
    },
  }),
);
```

It is written as [Piwi Picker's Network tab](./mock-requests#mock-this-response) writes one, the body inline whatever
its size, with what it hides:

- **Credentials.** A field named like a password, a token, a key, a signature or a session is written as `<hidden>`,
  whatever it holds, and so is a value shaped like a credential anywhere in the body, by the
  [rule Piwi Picker's mocks follow](./mock-requests#mock-this-response): ids, hashes and cursors stay. The URL pattern
  matches such a value with a wildcard, and keeps the host. The list hides them too. Headers, cookies included, are
  never written.
- **Warnings.** The editor says how many values it wrote as `<hidden>`, that a body neither JSON nor a form was
  written as it came (read it before you commit it), and that a body seems to hold an email address or a phone
  number (replace it with made-up data).

## The locator at the cursor

While a test is stopped, put the cursor on a line of the stopped file: its end says how many elements the line's
locator matches on the stopped page, `Piwi: 3 matches`, `1 match` or `no match`, and where the pause bar shows, the
matches are outlined in the page. Edit the locator and it is counted again. The outline goes
when the cursor leaves the file or the test goes on.

The locator must start from the page the test stopped on, as the code written there would: a line of `adminPage` at a
stop on `page` may be another page, and says so for a moment instead of a count. Only the stopped file's lines are
counted, and a line without a locator says nothing.

## A failure

In a run Piwi started, a failing test holds its page once the test function, its hooks and its fixtures are done,
instead of closing it, when someone can see it: in a headed browser, where the pause bar shows the failure (a run
started with breakpoints, or for a spec with `page.pause()`, is headed), or while Piwi Picker's
[Runs window](./runs-window) is open. The editor shows it as a stop of its own, at the
line where the error entered the test's code, or at the call a test timeout cut short:

`Failed · Timed out 5000ms waiting for getByRole('button', { name: 'Apply' }) · attempt 2`  Resume  Pick  Record …

**Resume** lets the test end as it failed (**Step** and **Finish** do the same); **Pick** replaces the failing
locator, **Record** writes the steps that were missing above the failing line, and the code actions work as at any
stop. Every attempt that fails is held, never an expected failure. A headless failure in any other run, such as a
plain **Run**, goes on at once, and the editor shows nothing of it.

The run reports the failure as it happened. Piwi's evidence of it is the page at the failure: the requests, console
entries and dialogs of the hold are not recorded. Playwright's own trace and video go on through it.

## Limits

- **Runs Piwi started only**, with a reporter that takes the actions; an editor extension older than the reporter
  holds no failure.
- **Assert offers what a recording's check panel offers**: a value, a text, a name, visible or hidden, enabled or
  disabled, with no `toBeChecked` or `toHaveCount` choice.
- **Assert a region** leaves out the value of a password, one-time code or card field, in a shadow root too, and a link
  whose URL holds a credential.
- **Mock a request** knows `fetch` and XHR answers with a text body only; one the browser no longer holds cannot be
  mocked, which the editor says.
- **The count needs a locator Piwi reads**: literal arguments, starting from a page in scope on the line.

## Related

- [Pause and step from the editor](./editor-run-control): the controls, the paused line, a headless test's page.
- [Breakpoints in the browser](./editor-breakpoints): the pause bar, Pick a locator and Record here.
- [Mock and slow down requests](./mock-requests): the same mocks from Piwi Picker's Network tab.
- [Recorded code](./recorded-code): what a recording writes, and how the config shapes it.
