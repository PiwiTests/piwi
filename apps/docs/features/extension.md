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

<figure>
  <img src="/screenshots/picker-pick.png" alt="The ranked locators of a Checkout button, the unique one first">
  <figcaption>Pick an element: the locator that finds exactly one element comes first.</figcaption>
</figure>

## What it does

Every tool below runs on the live page, from the toolbar popup. The last three need a
[connection to a Piwi instance](#connecting-to-a-piwi-instance); the others never reach it.

| Tool | For |
|---|---|
| [Pick an element](#pick-an-element) | a ranked locator for one element, re-checked against the page |
| [Multi-pick](#multi-pick) | the shared pattern of a list's rows or cards |
| [Lint overlay](#lint-overlay) | the elements that would make bad locator targets |
| [Assertion suggester](#assertion-suggester) | `expect(...)` lines for an element |
| [Copy context for agent](#copy-context-for-agent) | one block about an element for a coding agent |
| [Record actions](#record-actions) | a runnable spec from clicks and fills across pages |
| [Report a bug](./report-a-bug) | a failing test and a report of a bug you reproduce |
| [Developer tools](./devtools) | in DevTools: the selected element's locators, the locator console, the session, mocks, viewports |
| [Matching functions](#matching-functions) | a recording that calls your own functions |
| [Test functions](#test-functions-against-this-page) | which of your functions work on this page |
| [Tested elements](#tested-elements) | which elements of this page your tests reach |

## Where it is

Install Piwi Picker from the
**[Chrome Web Store ↗](https://chromewebstore.google.com/detail/piwi-picker/pakhnokpjboejcghgcmkjlpnogfjihhe)** for
Chrome or Edge 118 or later (in Edge, click **Allow** on the *Allow extensions from other stores* banner once, then
**Get**), or from **[Firefox Add-ons ↗](https://addons.mozilla.org/firefox/addon/piwi-picker/)** for Firefox 140 or
later.

Every tool in the popup has a key on its tile (`1` records, `2` picks, `B` reports a bug). One tool runs at a time and
**Esc** cancels it; recording runs until its own **Stop**. The tools that need no pick on the page are in the browser's
DevTools: [Developer tools](./devtools).

<figure>
  <img src="/screenshots/picker-popup.png" alt="The Piwi Picker popup over a shop page, one tile per tool">
  <figcaption>The popup: one tile per tool, with its key.</figcaption>
</figure>

Picking also has a shortcut, `Ctrl+Shift+E` by default (`Cmd+Shift+E` on macOS); the popup footer shows the key
bound.

## Pick an element

Hover highlights, a click picks. The pick snaps to the nearest actionable ancestor (the text inside a button picks
the button), and ↑/↓ walk the DOM tree, showing the locator each step would produce. For an element with a role, an
**anchors** step offers stable parents to scope the locator to, with a live match count.

**Enter** picks too: the highlighted element when the pointer is on one, otherwise the element that has the keyboard
focus, so a control reached with Tab is picked without the mouse. **Esc** cancels the pick.

Elements inside a web component's open shadow root are picked like any other: ↑ walks out of the shadow root through
its host element, and the anchors step lists the host and its parents and counts the matches inside open shadow roots,
as Playwright's locators do.

Every candidate uses the names Playwright computes (a tab with a count badge is `{ name: 'Regressions 5' }`), is
scored as the dashboard scores locators, and run against the page. Those that find only the picked element come
first; one that also finds others is offered narrowed (exact, filtered by its text, or scoped to
its landmark, dialog or row) and, failing that, with `.first()` or `.nth()` and a warning.

Copy the result as the bare locator, an action line or an assertion; **Copy all** copies every ranked locator for a
project's [Locators page](./locator-usage#the-locators-page). The action is the one the element calls for: `fill` with
what a field holds (`'value'` for an empty field or a password), `check` for a checkbox or a radio, `selectOption` for
a select, `click` for anything else. The assertion is the element's first
[suggestion](#assertion-suggester), and `toHaveCount` for a locator that finds several elements. Each button names
what it writes, such as **Action (fill)** or **Assertion (toHaveText)**.

## Multi-pick

Pick two or three similar items (rows, cards) to get the pattern they share, such as
`getByRole('row').filter({ hasText: … })`. It warns when only `.nth()` could tell them apart.

## Lint overlay

One click outlines every interactive element no stable locator finds alone, with a suggested `data-testid` for each
and a Markdown checklist.

<figure>
  <img src="/screenshots/picker-lint.png" alt="Four Add to cart buttons outlined, each with a suggested data-testid">
  <figcaption>Lint overlay: four buttons share a name; each gets a test id to add.</figcaption>
</figure>

## Assertion suggester

Pick an element to get the `expect(...)` candidates that apply to it, most telling first (`toHaveValue`,
`toBeChecked`, `toContainText` with the start of a long text, `toHaveText`, `toHaveAccessibleName`, `toBeVisible`),
built on its top-ranked locator. `toHaveAccessibleName` is offered only for an
element that has a name, as Playwright computes it: a paragraph takes none from its text, a field takes its label's.

## Copy context for agent

Pick an element to copy one block for a coding agent: the page URL, the element and every ranked locator.

## Record actions

**Record actions** asks for access to the site you are on, then captures clicks, fills, checks, choices, drags, the
names of chosen files (never their content), the keys that submit, close or move through a list, and a click on what a
hover shows, across pages. **Check an element** and **Check the address** add an `expect(…)` of what the page shows
now. **Stop** opens the review: **Copy as TypeScript** for a runnable spec that waits for each page it opens,
**Download steps** for a [steps file](/reference/steps-format) to share or render with
[`piwi codegen`](/reference/cli#codegen), [**Send to editor**](./editor-recording#send-from-piwi-picker), or
**Discard**. Passwords are never captured, nor a card number, its security code or a one-time code in a field whose
`autocomplete` names it: the spec reads them from `process.env`.

<figure>
  <img src="/screenshots/picker-record.png" alt="The review panel after a recording: seven steps, Copy as TypeScript">
  <figcaption>The review after Stop: every step, the spec one click away.</figcaption>
</figure>

## Matching functions

With a connection, the recorder loads the [function catalog](./test-functions) of the project mapped to the page and
ranks, while you record, the functions the steps look like. On export, a complete match becomes a call to your
function. No AI: it scores your registered functions' DOM patterns.

## Test functions against this page

**Test functions** in the popup scores every function of the active project's catalog against the page:
**Ready to use here** (every step finds one element), **Partly found here**, or **Not on this page**.

## Tested elements

With a connection, [Tested elements](./tested-elements) outlines every element of the page a test of the active
project reaches, lists those tests, and marks the buttons, links and fields no test reaches.

## Languages

Piwi Picker speaks English, French, German, Spanish and Brazilian Portuguese, following the browser unless
**Language**, in the settings, picks another. German, Spanish and Portuguese are unreviewed drafts:
[suggest a correction](https://github.com/PiwiTests/platform/issues/new?template=translation.yml). A bug report is
written in the extension's language; locators, test ids and specs never are.

## Permissions, explained

| Permission | Why |
|---|---|
| `activeTab` | acts on the tab you are looking at, only when you click the toolbar icon or press the shortcut |
| `debugger` (Chrome and Edge) | trusted input for a [replay](./replay-a-bug-report), a bug report's console, requests and screenshots, and DevTools' [throttling](./devtools#slow-down-or-fail-a-request), attached only while one of them runs, under Chrome's own debugging bar. Without it (Firefox, or **Cancel** there), they use the page's events. Nothing leaves your machine |
| `scripting` | injects the picker or the recorder into that tab on demand, and marks your instance's pages once [connected](./extension-connection#what-is-sent); nothing else runs unasked |
| `storage` | keeps your copy format and, only if you connect, the instance URL, URL patterns, cached catalogs and the last three [locator indexes](./tested-elements), on your machine. The API key and the desktop app's and editor's tokens live in the extension's own database, out of reach of web pages; the session and a running recording use `chrome.storage.session`, cleared when the browser closes |
| `cookies` (optional, not granted in advance) | [Save login for tests](./devtools#save-login-for-tests) asks for it, for the one site whose login you save |
| `optional_host_permissions` (none granted in advance) | recording asks for the one site you are on, to follow you across its pages; a connection asks for your instance's origin. Never `<all_urls>` |

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
