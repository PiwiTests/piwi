---
title: Browser extension
description: "Piwi Picker, the browser extension: pick and lint locators, record actions and copy context for an agent on the live page, with or without a Piwi instance."
lang: en-US
---

# Browser extension

<Needs extension />

Piwi Picker is a Chrome, Edge and Firefox extension (Manifest V3) that picks ranked, stable Playwright locators from
the page you are looking at, scored by the same engine the dashboard uses, and records a multi-page flow into a
runnable TypeScript spec. It works standalone and sends nothing by default; connecting it to a Piwi instance adds what
needs your project's history.

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

Every tool in the popup has a key shown on its tile (`1` records, `2` picks, `T` opens Tested elements, `B`
reports a bug). One tool runs at a time and **Esc** cancels it; recording runs until its own **Stop**. The developer
tools that need no pick on the page are in the browser's DevTools: see [Developer tools](./devtools).

Picking also has a shortcut, suggested as `Ctrl+Shift+E` (`Cmd+Shift+E` on macOS); the popup footer shows the key
actually bound.

## Pick an element

Hover highlights, a click picks. The pick snaps to the nearest actionable ancestor (the text inside a button picks
the button), and ↑/↓ walk the DOM tree first, showing the locator each step would produce. For an element with a role,
an **anchors** step lets you pick stable parents to scope the locator to, with a live match count.

Every candidate uses the names Playwright computes (a tab with a count badge is `{ name: 'Regressions 5' }`), is scored
the way the dashboard scores captured locators, and is run against the page as Playwright runs it. Those that find only
the picked element come first. One that also finds others is offered narrowed: exact (`{ name: 'Failed' }` also finds
"3 failed"), filtered by its text, or scoped to its landmark, dialog or row, and below it with its count;
failing that, `.first()` or `.nth()`, with a warning.

Copy the result as the bare locator, an action line (`await page.getByRole(…).click();`) or a visibility assertion. **Copy all** copies every ranked locator, one per line, for a project's
[Locators page](./locator-usage#the-locators-page).

## Multi-pick

Pick two or three similar items (table rows, cards) to derive the pattern they share, such as
`getByRole('row').filter({ hasText: … })`. It warns when only `.nth()` could tell them apart.

## Lint overlay

One click outlines every interactive element no stable locator finds alone, with a suggested `data-testid` for each
and a Markdown checklist.

## Assertion suggester

Pick an element to get the `expect(...)` candidates that apply to it (`toHaveValue`, `toHaveText`,
`toHaveAccessibleName`, `toBeVisible`), built on its top-ranked locator, each with a copy button.

## Copy context for agent

Pick an element to copy one block for a coding agent: the page URL, a summary of the element and every ranked locator.

## Record actions

**Record actions** asks for access to the site you are on, then captures clicks, double clicks, fills, checks,
choices, drags, the names of chosen files (never their content) and the keys that submit, close or move through a
list, across pages, and a click on what a hover shows after that hover. **Check an element** and **Check the
address** add an `expect(…)` of what the page shows now. **Stop** opens the review: **Copy as TypeScript** for a runnable spec that waits for each page it opens, **Download steps** for a
[steps file](/reference/steps-format) to share or render with [`piwi codegen`](/reference/cli#codegen),
[**Send to editor**](./editor-recording#send-from-piwi-picker), or **Discard**. Passwords are never captured, nor a card number, its security code or a one-time code in a field whose `autocomplete` names it: the spec reads them from `process.env`.

## Matching functions

With a connection, the recorder loads the [function catalog](./test-functions) of the project mapped to the page and
ranks, while you record, the functions the steps look like. On export, a complete match becomes a call to your
function; other steps stay locator lines. No AI: it scores your registered functions' DOM patterns.

## Test functions against this page

**Test functions** in the popup scores every function of the active project's catalog against the page as it is now:
**Ready to use here** (every step finds one element), **Partly found here**, or **Not on this page**. Its link opens
the catalog in Piwi.

## Tested elements

With a connection, [Tested elements](./tested-elements) outlines every element of the page a test of the active
project reaches, lists those tests, and marks the buttons, links and fields no test reaches.

## Languages

Piwi Picker speaks English, French, German, Spanish and Brazilian Portuguese, following the browser unless
**Language**, in the settings, picks another. German, Spanish and Portuguese are unreviewed drafts:
[suggest a correction](https://github.com/PiwiTests/platform/issues/new?template=translation.yml). A bug report is
written in the extension's language; page texts, locators, test ids, `steps.json` and generated specs never are.

## Permissions, explained

| Permission | Why |
|---|---|
| `activeTab` | acts on the tab you are looking at, only when you click the toolbar icon or press the shortcut |
| `debugger` (Chrome and Edge) | trusted input for a [replay](./replay-a-bug-report), a bug report's console, requests and screenshots, and DevTools' [throttling](./devtools#slow-down-or-fail-a-request). Attached only while one of them runs, under Chrome's bar saying Piwi Picker started debugging the browser. Without it (Firefox, or **Cancel** there), they use the page's own events. Nothing leaves your machine |
| `scripting` | injects the picker or the recorder into that tab on demand, and marks your instance's pages once [connected](./extension-connection#what-is-sent); nothing else runs unasked |
| `storage` | keeps your copy format and, only if you connect, the instance URL, URL patterns, cached catalogs and the last three [locator indexes](./tested-elements), on your machine. The API key and the desktop app's and editor's tokens are kept in the extension's own database, which scripts it runs in web pages cannot read. The session and the running recording use `chrome.storage.session`, cleared when the browser closes |
| `cookies` (optional, not granted in advance) | [Save login for tests](./devtools#save-login-for-tests) asks for it, for the one site whose login you save |
| `optional_host_permissions` (none granted in advance) | recording asks for the one site you are on, to follow you across its pages; a connection asks for your instance's origin. Never `<all_urls>` |

## Connecting to a Piwi instance

Optional and off by default. In the settings (the popup's gear button), type your instance's address and click
**Connect**, then **Allow** in the tab that opens: Piwi Picker receives its own API key. Which project applies on a
page comes from URL patterns kept on the instance, per project, and from any you keep in this browser; the popup's
**Active project** select overrides both on the tab's site for the session. See [Extension connection](./extension-connection).

Function catalogs refresh in the background; **Refresh** in Test functions fetches them now. **A recording is never sent to your instance**, and a [bug report](./bug-reports) only from its preview.

## Limits

- **One frame at a time.** The picker and the recorder see the top-level document, not iframes. The picker does not
  reach inside shadow DOM; the recorder records the fields of a page's open shadow roots, and from a closed one only
  the keys it records in a password field (Enter, Escape, the arrows).
- **Recording covers one origin.** On another site, recording stops capturing steps; stop and review, or start again
  there.
- **No aria-snapshot copier** yet for `toMatchAriaSnapshot()`.

## Related

- [Fix a broken locator](/recipes/broken-locator): from a failing locator to the one to use instead
- [Extension connection](./extension-connection): connecting in one step, and the URL patterns kept on the instance
- [Tested elements](./tested-elements): the elements your tests reach, drawn on the page
- [Test functions catalog](./test-functions): the functions a recording can call
- [Locator healing](./locator-healing): the replacement Piwi proposes after a failure
