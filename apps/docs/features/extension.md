---
title: Browser extension
description: "Piwi Picker, the browser extension: pick and lint locators, record actions and copy context for an agent on the live page, with or without a Piwi instance."
lang: en-US
---

# Browser extension

<Needs extension />

Piwi Picker is a Chrome, Edge and Firefox extension that picks ranked, stable Playwright locators from the page you
are looking at, scored by the same engine the dashboard uses, and records a multi-page flow into a runnable TypeScript
spec. It works standalone and sends nothing by default; connecting it to a Piwi instance adds what needs your
project's history.

## What it does

Every tool below runs on the live page, from the toolbar popup. The last three need a
[connection to a Piwi instance](#connecting-to-a-piwi-instance); the others never reach it.

| Tool | For |
|---|---|
| [Pick an element](./pick-an-element) | a ranked locator for one element, re-checked against the page |
| [Multi-pick](./pick-an-element#multi-pick) | the shared pattern of a list's rows or cards |
| [Lint overlay](./lint-overlay) | the elements that would make bad locator targets |
| [Assertion suggester](./pick-an-element#assertion-suggester) | `expect(...)` lines for an element |
| [Copy context for agent](./pick-an-element#copy-context-for-agent) | one block about an element for a coding agent |
| [Record actions](./record-actions) | a runnable spec from clicks and fills across pages |
| [Report a bug](./report-a-bug) | a failing test and a report of a bug you reproduce |
| [Developer tools](./devtools) | in DevTools: the selected element's locators, the locator console, the session, mocks, viewports |
| [Runs from the editor](#runs-from-the-editor) | pause, step and resume the tests your editor runs, from a window beside them |
| [Matching functions](./record-actions#matching-functions) | a recording that calls your own functions |
| [Test functions](#test-functions-against-this-page) | which of your functions work on this page |
| [Tested elements](#tested-elements) | which elements of this page your tests reach |

## Where it is

Install Piwi Picker from the
**[Chrome Web Store ↗](https://chromewebstore.google.com/detail/piwi-picker/pakhnokpjboejcghgcmkjlpnogfjihhe)** for
Chrome or Edge 118 or later (in Edge, click **Allow** on the *Allow extensions from other stores* banner once, then
**Get**), or from **[Firefox Add-ons ↗](https://addons.mozilla.org/firefox/addon/piwi-picker/)** for Firefox 140 or
later.

Every tool in the popup has a tile with a line under its name saying what it is for, and a key (`1` records, `2`
picks, `B` reports a bug). One tool runs at a time and **Esc** cancels it; recording runs until its own **Stop**. The
tools that need no pick on the page are in the browser's DevTools: [Developer tools](./devtools).

<figure>
  <img src="/screenshots/picker-popup.png" alt="The Piwi Picker popup over a shop page, one tile per tool">
  <figcaption>The popup: one tile per tool, with its key.</figcaption>
</figure>

Picking also has a shortcut, `Ctrl+Shift+E` by default (`Cmd+Shift+E` on macOS); the popup footer shows the key
bound.

## Test functions against this page

**Test functions** in the popup scores every function of the active project's catalog against the page:
**Ready to use here** (every step finds one element), **Partly found here**, or **Not on this page**.

## Tested elements

With a connection, [Tested elements](./tested-elements) outlines every element of the page a test of the active
project reaches, lists those tests, and marks the buttons, links and fields no test reaches.

## Runs from the editor

With Piwi Picker [paired with VS Code or a JetBrains IDE](./editor-recording#send-from-piwi-picker), the popup shows a
**Runs** tile under **More tools** while the editor answers, with the number of runs it has. It opens the Runs
window, a small window of its own to keep beside the test's browser. For each run the editor
[started](./editor-runs), it shows the folder and the command, then each worker's test, project and attempt, and
whether it runs or where it stopped: the file and line, the call about to run, and an image of the page, taken again
at each stop.

**Pause** stops a running test before its next call. At a stop, **Resume**, **Step** and **Finish** do what they do
[in the editor](./editor-run-control#the-controls); **Pick** and **Record**, when Piwi's pause bar shows in the test's
window, start the bar's **Pick a locator** and **Record here** there, and the code lands in the editor. Run to cursor
stays in the editor, which has the file. A control the editor refuses, because the test went on meanwhile, says why
under the test.

<figure>
  <img src="/screenshots/picker-runs.png" alt="The Runs window beside a shop page stopped before a click on Checkout: the test, its file and line, the call, an image of the page, and Resume, Step, Finish, Pick and Record">
  <figcaption>The Runs window, beside a test stopped at a breakpoint.</figcaption>
</figure>

`Ctrl+Shift+9` (`Cmd+Shift+9` on macOS) works from any window in Chrome and Edge, the test's and the editor's
included, Runs window open or not: it resumes the stopped tests, each at its stop, or with none stopped, pauses every
run. In Firefox it works while Firefox has the focus; ChromeOS has no shortcut of this kind. Change it at
`chrome://extensions/shortcuts` (`edge://extensions/shortcuts` in Edge).

The extension's background worker asks the editor for the address of each of its windows' services, once the program
on the paired port has proved it holds the pairing's token, and keeps a WebSocket to each on `127.0.0.1`, their tokens
in the extension's own database. A page, even one your machine serves, cannot reach them:
[how the pieces connect](./editor-run-control#how-it-works).

## Languages

Piwi Picker speaks English, French, German, Spanish and Brazilian Portuguese, following the browser unless
**Language**, in the settings, picks another. German, Spanish and Portuguese are unreviewed drafts:
[suggest a correction](https://github.com/PiwiTests/piwi/issues/new?template=translation.yml). A bug report is
written in the extension's language; locators, test ids and specs never are.

## Permissions, explained

| Permission | Why |
|---|---|
| `activeTab` | acts on the tab you are looking at, only when you click the toolbar icon or press the shortcut |
| `debugger` (Chrome and Edge) | trusted input for a [replay](./replay-a-bug-report), a bug report's console, requests and screenshots, and DevTools' [throttling](./mock-requests#slow-down-or-fail-a-request), attached only while one of them runs, under Chrome's own debugging bar. Without it (Firefox, or **Cancel** there), they use the page's events. Nothing leaves your machine |
| `scripting` | injects the picker or the recorder into that tab on demand, and marks your instance's pages once [connected](./extension-connection#what-is-sent); nothing else runs unasked |
| `storage` | keeps your copy format and, only if you connect, the instance URL, URL patterns, cached catalogs and the last three [locator indexes](./tested-elements), on your machine. The API key and the desktop app's and editor's tokens live in the extension's own database, out of reach of web pages; the session and a running recording use `chrome.storage.session`, cleared when the browser closes |
| `cookies` (optional, not granted in advance) | [Save login for tests](./devtools#save-login-for-tests) asks for it, for the one site whose login you save |
| `optional_host_permissions` (none granted in advance) | recording asks for the one site you are on, to follow you across its pages; a connection asks for your instance's origin. Never `<all_urls>`. The settings list every site allowed under **Sites Piwi Picker may run on**, each with **Revoke** |

### Sites Piwi Picker may run on

Recording, replaying, Save login and the DevTools pane each ask for the site you are on the first time they need it,
and the access stays until you take it back. Settings → **Sites Piwi Picker may run on** lists every site allowed
with a **Revoke** button; Piwi Picker then runs there only when you click its icon. A site a recording or a replay runs
on keeps its access until it ends, and your instance's address, the desktop app's and the editor's are given back by
**Disconnect** and **Unpair**.

## Connecting to a Piwi instance

Optional and off by default. In the settings, type your instance's address and click
**Connect**, then **Allow** in the tab that opens: Piwi Picker receives its own API key. Which project applies on a
page comes from URL patterns kept on the instance and from any you keep in this browser; the popup's **Active
project** select overrides both for the session. See [Extension connection](./extension-connection).

Function catalogs refresh in the background. **A recording is never sent to your instance**, and a
[bug report](./bug-reports) only from its preview.

## Limits

- **One frame at a time.** The picker and the recorder see the top-level document, not iframes.
- **Open shadow roots only.** The picker reaches inside open shadow roots; a closed one is out of reach, and a pick
  there picks its host element. The recorder records the fields of open shadow roots, and from a closed one only the
  keys of a password field (Enter, Escape, the arrows).
- **Recording covers one origin.** On another site it stops capturing: stop and review, or start again there.
- **No aria-snapshot copier** yet for `toMatchAriaSnapshot()`.

## Related

- [Fix a broken locator](/recipes/broken-locator): from a failing locator to the one to use instead
- [Extension connection](./extension-connection): connecting in one step, and the URL patterns kept on the instance
- [Tested elements](./tested-elements): the elements your tests reach, drawn on the page
- [Test functions catalog](./test-functions): the functions a recording can call
- [Locator healing](./locator-healing): the replacement Piwi proposes after a failure
