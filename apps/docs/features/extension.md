---
title: Browser extension
description: "Piwi Picker, the browser extension: pick and lint locators, record a test or a bug report, and copy context for an agent on the live page, with or without a Piwi instance."
lang: en-US
---

# Browser extension

<Needs extension />

Piwi Picker is a Chrome, Edge and Firefox extension that picks ranked, stable Playwright locators from the page you
are looking at, scored by the same engine the dashboard uses, and records a multi-page flow into a runnable TypeScript
spec, or into a failing test and a bug report once you mark what the page gets wrong. It works standalone and sends
nothing by default; connecting it to a Piwi instance adds what needs your project's history. This page lists the
tools, where they are, the permissions they use and their limits; each tool has its own page.

## What it does

Every tool below runs on the live page, from the toolbar popup. The last three need a
[connection to a Piwi instance](#connecting-to-a-piwi-instance); the others work without one, and some do more with it:
a pick names the tests that reach the element, a recording sends its report, Developer tools lists your projects'
viewports.

| Tool | Key | For |
|---|---|---|
| [Pick an element](./pick-an-element) | `2` | a ranked locator for one element, re-checked against the page |
| [Multi-pick](./pick-an-element#multi-pick) | `3` | the shared pattern of a list's rows or cards |
| [Lint overlay](./lint-overlay) | `5` | the elements that would make bad locator targets |
| [Assertions](./pick-an-element#assertion-suggester) | `4` | `expect(...)` lines for an element |
| [Agent context](./pick-an-element#copy-context-for-agent) | `7` | one block about an element for a coding agent |
| [Record](./record-actions) | `1` | a runnable test from clicks, fills and checks across pages, with the evidence |
| [Record a bug report](./report-a-bug) | | a failing test and a report, once a recording marks what the page gets wrong |
| [Replay](./replay-a-bug-report) | `R` | a recording's steps played again in a tab, to see whether each still holds or the bug shows there |
| [Developer tools](./devtools) | | in DevTools: the selected element's locators, the locator console, the session, mocks, viewports |
| [Runs window](./runs-window) | `U` | pause, step and resume the tests your editor runs, and watch a headless one live |
| [Matching functions](./record-actions#matching-functions) | | a recording that calls your own functions |
| [Test functions](./test-functions#using-the-catalog) | `6` | which of your functions work on this page |
| [Tested elements](./tested-elements) | `T` | which elements of this page your tests reach |

## Where it is

Install Piwi Picker from the
**[Chrome Web Store ↗](https://chromewebstore.google.com/detail/piwi-picker/pakhnokpjboejcghgcmkjlpnogfjihhe)** for
Chrome or Edge 118 or later (in Edge, click **Allow** on the *Allow extensions from other stores* banner once, then
**Get**), or from **[Firefox Add-ons ↗](https://addons.mozilla.org/firefox/addon/piwi-picker/)** for Firefox 140 or
later.

Every tool in the popup has a tile with a line under its name saying what it is for, and the key in the table above,
pressed with the popup open. **Record** and **Pick an element** come first, then the **Pick** section, with
Multi-pick, Assertions, Lint overlay, Test functions and Agent context, and the **Tests** section, with Replay, Runs
and Tested elements. One tool runs at a time and **Esc** cancels it; a recording runs until its own **Finish**, and
while it runs, **Take a screenshot** (`S`) takes Replay's place. The tools that need no pick on the page are in the
browser's DevTools: [Developer tools](./devtools).

<figure>
  <img src="/screenshots/picker-popup.png" alt="The Piwi Picker popup over a shop page, one tile per tool">
  <figcaption>The popup: one tile per tool, with its key.</figcaption>
</figure>

Picking also has a shortcut, `Ctrl+Shift+E` by default (`Cmd+Shift+E` on macOS); the popup footer shows the key
bound.

## Test functions against this page

The popup's **Test functions** checklist, with a connection: see
[Using the catalog](./test-functions#using-the-catalog).

## Tested elements

With a connection, the popup's **Tested elements** outlines what your tests reach on the page: see
[Tested elements](./tested-elements).

## Runs from the editor

With Piwi Picker [paired with VS Code or a JetBrains IDE](./editor-recording#send-from-piwi-picker), the popup's
**Runs** tile, under **Tests**, opens the [Runs window](./runs-window).

## Languages

Piwi Picker speaks English, French, German, Spanish and Brazilian Portuguese, following the browser unless
**Language**, in the settings, picks another. German, Spanish and Portuguese are unreviewed drafts:
[suggest a correction](https://github.com/PiwiTests/piwi/issues/new?template=translation.yml). A bug report is
written in the extension's language; locators, test ids and specs never are.

## Permissions, explained

| Permission | Why |
|---|---|
| `activeTab` | acts on the tab you are looking at, only when you click the toolbar icon or press the shortcut |
| `debugger` (Chrome and Edge) | trusted input for a replay, a recording's evidence, DevTools' request conditions and the viewport it sets in the tab, attached only while one of them runs: see [The debugging bar](#the-debugging-bar) |
| `scripting` | injects Pick an element, the recorder or another tool into that tab on demand, and marks your instance's pages once [connected](./extension-connection#what-is-sent); nothing else runs unasked |
| `storage` | keeps your copy format and, only if you connect, the instance URL, URL patterns, cached catalogs and the last three [locator indexes](./tested-elements), on your machine. The API key and the desktop app's and editor's tokens live in the extension's own database, out of reach of web pages; the session and a running recording use `chrome.storage.session`, cleared when the browser closes |
| `cookies` (optional, not granted in advance) | [Save login for tests](./devtools#save-login-for-tests) asks for it, for the one site whose login you save |
| `optional_host_permissions` (none granted in advance) | recording asks for the one site you are on, to follow you across its pages; a connection asks for your instance's origin. Never `<all_urls>`. The settings list every site allowed under **Sites Piwi Picker may run on**, each with **Revoke** |

### The debugging bar

In Chrome and Edge, the features below use the browser's debugging protocol on the tab they act on, and Chrome
shows its bar saying Piwi Picker started debugging the browser while one runs. Each attaches when it starts and lets
go when it ends; the session is detached once none holds it. Nothing read through it leaves your machine unless you
send it. Firefox has no `debugger` permission, and **Cancel** on the bar ends the session: each feature then goes on
without it, and says so.

| Feature | With the protocol | Without it |
|---|---|---|
| [Replay](./replay-a-bug-report#trusted-input) | Trusted input, as Playwright sends it, at the viewport size each step was recorded at | The page's own events, the panel saying which, step by step |
| [Record](./report-a-bug#how-the-evidence-is-collected) | The console, every failed request, the screenshots and a screenshot of each step, in the tab the recording started in, from the page's first script | A script in the page sees `fetch` and XHR calls only; a screenshot needs the `activeTab` grant |
| [Request conditions](./mock-requests#slow-down-or-fail-a-request) | Any request, and the Network and CPU throttling | The page's `fetch` and XHR calls only, no throttling |
| [Viewport in this tab](./devtools#open-this-page-at-a-viewport) | The tab itself at a project's viewport | A new window of that size |

### Sites Piwi Picker may run on

Recording, replaying, Save login and the DevTools pane each ask for the site you are on the first time they need it,
and the access stays until you take it back. Settings → **Sites Piwi Picker may run on** lists every site allowed
with a **Revoke** button; Piwi Picker then runs there only when you click its icon. A site a recording or a replay runs
on keeps its access until it ends, and your instance's address, the desktop app's and the editor's are given back by
**Disconnect** and **Unpair**.

## Connecting to a Piwi instance

Optional and off by default: **Connect** in the settings, the URL patterns that say which project a page belongs
to, and [what a connection sends](./extension-connection#what-is-sent), never a recording, are on
[Extension connection](./extension-connection).

## Limits

- **One frame at a time.** Pick an element, the recorder and Replay see the top-level document, not iframes.
- **Open shadow roots only.** Pick an element reaches inside open shadow roots; a closed one is out of reach, and a pick
  there picks its host element. The recorder records the fields of open shadow roots, and from a closed one only the
  keys of a password field (Enter, Escape, the arrows).
- **Recording covers one origin.** On another site it stops capturing: finish, or start again there.
- **No ARIA snapshot from a plain pick.** `toMatchAriaSnapshot()` code comes from **Assert a region**, at a stopped
  test in the [Runs window](./runs-window).

## Related

- [Fix a broken locator](/recipes/broken-locator): from a failing locator to the one to use instead
- [Extension connection](./extension-connection): connecting in one step, and the URL patterns kept on the instance
- [Tested elements](./tested-elements): the elements your tests reach, drawn on the page
- [Runs window](./runs-window): the editor's runs, steered and watched from the browser
- [Write, run and fix a test](./write-run-fix): a test from an empty spec to a passing run, with the tool for each step
- [Test functions catalog](./test-functions): the functions a recording can call
- [Locator healing](./locator-healing): the replacement Piwi proposes after a failure
