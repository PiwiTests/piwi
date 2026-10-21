# Developer tools for tests, in the browser

- Status: accepted
- Date: 2026-09-27

A plan for the developer tools Piwi Picker should grow, and the ones it should not. The question was whether the
extension should also become a web developer toolbar. It should not: the browser's DevTools already disable styles,
measure boxes, edit cookies and throttle the network better than an extension can, and most toolbar features need
standing permissions this extension refuses on principle. What DevTools does not do is look at a page the way a
Playwright test does. That is the gap this plan fills: a **Piwi panel inside DevTools**, a **Playwright view** of the
page, **mocks written from real responses**, the **login saved for tests**, **slow and failing requests** on demand,
and **viewports** from the project's own configuration.

**Status.** Proposed 2026-09-27; built the same day, PRs 1 to 7 in their Delivery order, then a layout pass on the
DevTools pages and two more panel tabs (Locators, Session; see 1.2). No part needed the `debugger` permission, and only
one added a permission at all: `cookies`, optional, requested when the login is saved. Revised 2026-09-28: `debugger`
is used on demand (T2), which brings what was out of reach below within reach in Chrome and Edge. The DevTools panel adds a manifest
key (`devtools_page`) that shows no install warning. The open questions are settled below.

What is left:

- **Firefox.** Nothing here was run in Firefox. The sidebar's route there (`$0` marked in the page's world, the
  content script asked by message, since `useContentScriptContext` is missing) and the Locators tab's message route
  are written but unverified, as are the main-world request conditions and `cookies` in a Firefox container tab.
- **Flake Lab's suspects** as a source for Slow down or fail a request (2.4): not built; the Network tab's requests are
  the only source.
- **The replay dialog** does not list the conditions on before a replay starts; the replay's panel and the Piwi panel
  list them from its start to its verdict.
- **Real DevTools** is exercised by one spec (`devtools-real.spec.ts`): the `devtools_page` loads, `$0` reaches the
  ranking script, and Reveal's `inspect()` moves the selection. The sidebar and panel pages themselves are tested as
  tabs with `chrome.devtools` stubbed; opening them inside DevTools' own frames from a test was not attempted.
- **The lab** has no scenario for these tools: they add no recorded action, and the lab measures recordings and their
  replays. On the demo seed its README prescribes, `project-tests-search` fails with or without the extension, since
  the seed has no "Piwi Dashboard" project; the other 23 scenarios pass.

**Summary.** A developer writing a test switches between the page, DevTools and the editor: they read the accessibility
tree to guess what `getByRole` will find, copy a response from the Network panel to write a mock by hand, and log in
again in every test because saving `storageState` means writing a setup project first. Piwi Picker already has the
pieces: an engine that evaluates locators the way Playwright does, the ranked and verified locators the recorder
keeps, the bug report's evidence scripts, and a connection to the project's instance. This plan puts them where the
developer already is:

- a **Piwi sidebar in the Elements panel**: select a node in DevTools and read its ranked locators, each verified on
  the page, without switching to the Pick tool;
- a **Piwi panel** that holds the recorder and the replay beside the page, survives its navigations, and reads the
  network log that content scripts cannot see;
- a **Playwright view** overlay: each element labelled with the role and name `getByRole` sees, its test id, and a
  mark on the ones no stable locator can reach or that share a name;
- **Mock this response**: a request from the network log becomes `page.route(...)` code with its body;
- **Save login for tests**: the tab's cookies and storage written as a Playwright `storageState` file;
- **Slow down or fail a request**, for the flaky conditions Flake Lab names, and a replay under that condition;
- **Viewport presets** from the project's Playwright projects.

## What the reader gets

In DevTools, the Elements panel gets a **Piwi** sidebar. Selecting `<button class="btn">Apply coupon</button>` there
shows what the Pick tool shows today, for that node, as it is selected:

```
getByRole('button', { name: 'Apply coupon' })     ✓ unique · stable
getByTestId('apply-coupon')                        ✓ unique · stable
locator('.btn').nth(2)                             3 match · brittle
[Copy]  [Copy as click]  [Copy as expect]  [Add to session]
```

The **Piwi** panel lists the recording's steps as they happen, and a replay's steps with their results, and stays
open across the page's navigations where the in-page HUD redraws on each page. Its **Network** tab lists the page's
`fetch` and XHR requests; one click on `GET /api/cart` gives:

```ts
await page.route('**/api/cart', (route) =>
  route.fulfill({ json: { items: [{ sku: 'SPRING-TEE', qty: 1 }], total: 40 } }),
);
```

The popup's **Playwright view** tile labels the page: `button · Apply coupon`, `textbox · Coupon`,
`link · Cart (2)`, a test id badge where there is one, a red mark on a clickable `<div>` with no role and no name, an
amber one on two buttons both named "Show popup".

**Save login for tests** writes `auth.json`, which a project's setup uses as it is:

```ts
test.use({ storageState: 'playwright/.auth/user.json' });
```

## Why not a general toolbar

| Toolbar feature | Where it belongs |
| --- | --- |
| Disable CSS or JavaScript, outline blocks, show rulers | DevTools does it; an extension would need to rewrite every page |
| View and edit cookies, clear storage | DevTools' Application panel; an extension needs `cookies` and host access to every site |
| Emulate a device (touch, pixel ratio, user agent) | DevTools and Playwright do it. Throttling the network, going offline and a viewport in the tab are built since `debugger` is used on demand (T2): see 2.4 and 2.5 |
| Validate HTML, check links | Other tools; nothing to do with tests |

A toolbar would also blur what Piwi Picker is for. Every tool below answers one question: *what will my test see, and
how do I get the test there?*

## What exists

- **The engine.** `src/content/engine-aria.ts` and `locator-engine.ts` evaluate locator chains with Playwright's
  rules (roles, accessible names, visibility), compared against Playwright in `tests/e2e/locator-engine.spec.ts`.
  `verified-locators.ts` keeps the candidates that find exactly the element and narrows the ambiguous ones.
- **The tools.** Pick, hover, the locator console, multi-pick, the lint overlay, assertions, the session, agent
  context, the recorder, the bug report and the replay, all as content scripts opened from the popup.
- **Evidence.** The bug report registers a main-world script (`bug-evidence-main.ts`) that sees `fetch`, XHR and the
  console while a bug recording runs, under the origin's optional host permission.
- **The instance.** An optional connection reads the project list, the function catalog and the locator index; the
  project a tab belongs to comes from URL patterns stored on the instance (`adr/extension-connect.md`).

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| T1 | No general developer toolbar. | DevTools does those better, and they need permissions the extension refuses. |
| T2 | `debugger` used on demand since 2026-09-28, option A: required in the Chromium build, attached to the inspected tab only while a request condition, throttling or a viewport set there is on, released when all are off; Firefox keeps the page-level wrapper. See [`bug-report-to-failing-test.md`](bug-report-to-failing-test.md#the-debugger-permission). | It cannot be optional; the owner accepted the install warning and the debugging bar while the extension has few users, for conditions on every request, and throttling. |
| T3 | The DevTools panel is an addition, never a requirement: every tool still opens from the popup. | Testers do not open DevTools. |
| T4 | Network data is read only through `chrome.devtools.network`, only while DevTools is open on the tab, and never leaves the browser unless the user exports it. | It needs no permission, and a HAR holds credentials. |
| T5 | Exports hide credentials by default: `Authorization`, `Cookie` and `Set-Cookie` headers, and fields named like a password or a token, until the user reveals them. | A mock or a login file is committed more often than it should be. |
| T6 | `cookies` is an optional permission, requested in the click that saves a login, for the tab's origin only. | The only feature that needs it, used rarely. |
| T7 | Slowing or failing a request goes through the debugging protocol's `Fetch` domain in Chrome and Edge (every request, documents, scripts and images included), and wraps `fetch` and XHR in the page's main world, as the bug evidence script does, where the protocol is not there (Firefox, a cancelled bar). | `Fetch` reaches what flaky tests wait on beyond API calls; the wrapper keeps the tool working where the protocol is not. |

## Part 1 — In DevTools

### 1.1 The Elements sidebar

`devtools_page` loads a small page for every DevTools window. It creates a sidebar pane in the Elements panel
(`chrome.devtools.panels.elements.createSidebarPane`) and follows the selection (`onSelectionChanged`). On each change
it asks the tab's content script to rank the selected node:
`chrome.devtools.inspectedWindow.eval('__piwiRankSelected($0)', { useContentScriptContext: true })` hands `$0`, the
node selected in DevTools, to a function the extension's content script defines. The ranking is the verified one the
Pick tool uses (see the "accurate names and verified locators" work on this branch). The pane shows the candidates, a
count and a stability label for each, and the Pick panel's copy actions.

The content script is injected on demand with `chrome.scripting.executeScript`, under the tab's `activeTab` grant
when DevTools was opened from a click on the extension, or the origin's optional host permission; the pane asks for
the permission in a click when it has neither.

### 1.2 The Piwi panel

`chrome.devtools.panels.create('Piwi', …)` adds a panel with three tabs:

- **Record**: the recording's steps, live, with the same actions as the review panel (copy as TypeScript, download
  steps, discard). The in-page HUD stays for people without DevTools open.
- **Replay**: the replay's steps and verdict, with Pause, Next step and Stop. The panel lives as long as DevTools, so
  it does not redraw on each page as the HUD does, and it has room for each step's detail and the locator it used.
- **Network**: the page's `fetch` and XHR requests from `chrome.devtools.network.onRequestFinished`, each with its
  method, path, status and duration, filtered to the tab's origin by default. See 2.2 and 2.4.

The panel reads the same session storage the popup and the in-page panels read, and redraws on
`chrome.storage.onChanged`: no channel through the background worker is needed (a change from the `runtime.connect`
first planned). Its buttons do what the in-page panels do: Stop recording is the popup's stop; Pause, Continue, Next
step and Stop write the replay state and then send `piwi-replay-wake` to the replayed site's tabs, whose replay script
redraws its panel and, except after a pause, goes on. A bug report is finished from its panel on the page, which
collects the evidence, and a recording is started from the popup, as before.

Two popup tools gained a place in the panel, since DevTools does more for them than a panel on the page can: the
locator console (**Locators**), whose matches are revealed in the Elements panel with `inspect()`, and the pick session
(**Session**), which the Elements sidebar's Add to session fills. Both stay in the popup (T3). Both DevTools pages share
one stylesheet drawn like DevTools' own (flat toolbars, 12px type, the DevTools theme), and the Network tab splits the
requests and the selected one side by side.

## Part 2 — The tools

### 2.1 Playwright view

A tool in the popup, and a toggle in the Piwi panel, that labels every element a test could reach: its role and
accessible name as `getByRole` sees them (from `DomModel`), its test id when it has one, and two marks:

- **unreachable** (red): an element with a click handler or `tabindex` but no role Playwright recognizes, or a role
  with no name, so no stable locator can reach it;
- **ambiguous** (amber): two or more elements sharing a role and a name, where `getByRole` would need `exact`, a scope
  or `.nth()`.

Labels are placed like the lint overlay's badges, skip hidden elements, and follow scrolling. A filter limits them to
one role. The lint overlay stays for its suggestions (a `data-testid` to add); this view answers "what does the test
see here".

### 2.2 Mock this response

From the panel's Network tab, a request becomes code:

- `page.route('**/api/cart', …)` with `route.fulfill({ json })` for a JSON body, `{ body, contentType }` otherwise, and
  the status when it is not 200;
- the URL pattern keeps the path and drops the origin; volatile query values (a timestamp, a cache buster) become `*`
  rather than being dropped, since a Playwright glob with no query does not match a URL that has one. It is shown for
  editing before copying, and a method other than GET adds a check that falls back for the other methods;
- **Mock with an error** writes the same route with a 500 or a network failure (`route.abort()`), for testing the
  page's error state;
- bodies over 100 kB are written to a file (`mocks/cart.json`) the snippet reads, and the file is downloaded beside it.

Credentials in headers and bodies are hidden (T5).

### 2.3 Save login for tests

A button in the popup's settings row and in the panel: the tab's cookies (through `chrome.cookies.getAll` for the
tab's origin, `httpOnly` ones included, which `document.cookie` cannot read) and the origin's `localStorage` (from the
content script), written as Playwright's `storageState` JSON and downloaded. The dialog says what the file holds and
that it logs anyone in as this user until the session expires, recommends a test account, and offers the setup snippet:

```ts
// auth.setup.ts
setup('log in', async ({ page }) => {
  /* … the login steps, or none: the saved file is enough until it expires */
  await page.context().storageState({ path: 'playwright/.auth/user.json' });
});
```

IndexedDB is left out: Playwright saves it only with `indexedDB: true`, and reading it from an extension means walking
every database of the origin. A later option if asked.

As built, the dialog is an extension page (`login.html`) the popup's header and the panel open for the tab, and the
click that saves asks for `cookies` together with the site's origin (the `cookies` API needs the host permission too).
T5's hiding does not apply to this file: the cookie values are what makes it work, so the page warns instead, gives the
`.gitignore` line, and says to use a test account.

### 2.4 Slow down or fail a request

From the Network tab, or from Flake Lab's suspects when the instance has them: **Slow down GET /api/cart by 2 s**,
**Fail it with 500**, **Fail it (network error)**. A main-world script registered for the origin (as the bug evidence
script is, under the same grant) wraps `fetch` and `XMLHttpRequest` and applies the conditions to matching requests,
until the user turns them off or closes the tab; a banner on the page says a condition is on.

A replay can run under a condition: the replay dialog lists the active ones, and the verdict says which were on. That
is the manual half of Flake Lab ([`flake-lab.md`](flake-lab.md)): a condition the lab reproduced in CI, tried by hand in
the developer's own tab.

Built since 2026-09-28 through `debugger` (T2), in Chrome and Edge: delays and failures on documents, scripts and
images (`Fetch`), whole-page network throttling and offline (`Network.emulateNetworkConditions`), and CPU throttling
(`Emulation.setCPUThrottlingRate`), in the Network tab's toolbar. Still out of reach: requests a service worker makes
itself (a separate target the tab's session does not pause), and, in Firefox, everything but `fetch` and XHR.

As built: the conditions belong to one tab, kept by the background worker, which registers the main-world wrapper and
an isolated-world relay for the page's origin; the relay asks the worker for the tab's conditions (other tabs of the
site get none) and posts them to the wrapper, which holds a request back until they arrive, at most a second. A new
condition on the same method and URL pattern replaces the old one. The replay carries the conditions on when it
starts, and its panel and the Piwi panel list them from the start to the verdict, rather than in the replay dialog.
Starting from Flake Lab's suspects is not built: the Network tab's requests are the only source for now.

### 2.5 Viewport presets

When the instance knows the project's Playwright projects and their `use.viewport` (from the runs, see the first open
question), the popup offers them: **Open this page at iPhone 13 (390×844)** opens the page in a new window sized so its viewport, not its
outer frame, matches (`chrome.windows.create`, then corrected by the difference between the window's outer and inner
size). No emulation of touch, device pixel ratio or user agent: that takes the debugging protocol. The label says
"viewport only". As built, the background worker creates the window, then grows it by the frame it measures
(`tabs.Tab.width`/`height` against the window's size) until the viewport matches; a size the screen cannot hold
ends at the nearest one the browser allows. Since 2026-09-28 (T2), **In this tab** sets the viewport of the tab itself
in Chrome and Edge (`Emulation.setDeviceMetricsOverride`), until **Back to the window's size**; still no touch, pixel
ratio or user agent.

## Permissions

| Feature | Needs | Install warning |
| --- | --- | --- |
| Elements sidebar, Piwi panel, Network tab | `devtools_page` | none |
| Ranking the selected node | the tab's `activeTab` grant or the origin's optional host permission (existing) | none new |
| Playwright view | `activeTab` (existing) | none new |
| Mock this response | nothing beyond DevTools being open | none |
| Save login for tests | `cookies`, optional, requested in the click | shown when requested |
| Slow down or fail a request, throttling | the origin's optional host permission (existing); `debugger` in Chrome and Edge (T2) | `debugger`'s, at install |
| Viewport presets | `windows` API, no permission needed for creating a window; `debugger` for In this tab | `debugger`'s, at install |

## Delivery

| PR | Content | Depends on |
| --- | --- | --- |
| 1 | `devtools_page`, the Elements sidebar with verified locators for `$0`, and its copy actions | the verified-locators work |
| 2 | Playwright view overlay, from the popup | — |
| 3 | The Piwi panel: Record and Replay tabs, the background channel | 1 |
| 4 | The Network tab and Mock this response | 3 |
| 5 | Save login for tests (optional `cookies`) | — |
| 6 | Slow down or fail a request, and replays under a condition | 3, 4 |
| 7 | Viewport presets | the instance knowing the projects' viewports |

Each PR ships its texts in the five catalogs (English, French, and German, Spanish and Brazilian Portuguese as drafts),
its end-to-end tests, and a section on `features/extension.md` within its word budget. The DevTools pieces are tested
by loading the extension in Chromium and opening DevTools through the debugging protocol from the test, which drives
DevTools' own page as Playwright can.

## Risks

- **DevTools extension APIs in Firefox.** `devtools.panels`, `devtools.network` and `inspectedWindow.eval` exist in
  Firefox, but `useContentScriptContext` does not: the sidebar there asks the content script for the element under
  DevTools' selection by a different route (a temporary attribute set on `$0` in the page's world), to be verified.
- **Storage state leaks.** A saved login is a credential. Mitigated by the dialog, the test-account advice, the file
  name under `playwright/.auth/` (commonly gitignored), and a check in the dialog that recommends adding it to
  `.gitignore`.
- **Wrapping `fetch` breaks a page.** A page that replaces `fetch` itself, or checks it is native, may behave
  differently with a condition on. The banner makes the state visible, and turning conditions off reloads the tab.

## Open questions

1. **Viewports from the instance.** Settled: from the instance. The reporter already sends each project's
   `use.viewport` with the run (`htmlReport.projects[].use.viewport`, beside the `testIdAttribute` the locator index
   reads), so no new wire field is needed: the locator index gains an optional `viewports` list, frozen at 1.0 as
   D23 in [`1.0-stabilization.md`](../proposals/1.0-stabilization.md). Reading the Playwright config in the desktop app would need
   the config evaluated by Node, and would leave out anyone without the desktop app. The popup also offers a size
   typed by hand, for anyone not connected.
2. **The panel as the main UI.** Settled: both show. The in-page HUD stays for people without DevTools open, and the
   Piwi panel mirrors the same state.
3. **Mocks as fixtures.** Settled: not now. Mock this response writes plain `page.route` code, as 2.2 describes.
