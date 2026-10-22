---
title: Developer tools
description: "Piwi Picker's tools for writing a test from the page: the ranked locators of the element selected in DevTools, and more."
lang: en-US
---

# Developer tools

<Needs extension />

The [Piwi Picker extension](./extension) answers one question beside the browser's own DevTools: what will a test see
on this page, and how does the test get there? Its developer tools live here rather than in the toolbar popup, which
keeps the tools that act on the page. In Chrome and Edge, the
[request conditions](./mock-requests#slow-down-or-fail-a-request) and a viewport set in the tab itself go through the
browser's debugging protocol, and Chrome shows its debugging bar while one is on.

## The Elements sidebar

Open DevTools, go to **Elements**, and choose the **Piwi** tab beside Styles and Computed. Select a node and the pane
lists its locators, ranked and checked against the page as it is, the same list [Pick an element](./pick-an-element)
shows:

```
getByRole('button', { name: 'Apply coupon' })     ✓ unique · stable
getByTestId('apply-coupon')                        ✓ unique · stable
locator('.btn').nth(2)                             ⚠ unique by position · brittle: position, CSS class
```

<figure>
  <img src="/screenshots/picker-devtools.png" alt="The Piwi pane in the Elements sidebar: the selected button's three locators, ranked, the test id first">
  <figcaption>The pane for a selected button: each locator checked against the page, copied as a locator, an action or an assertion.</figcaption>
</figure>

A locator that finds the node among others says how many it finds. Under each one, **Locator**, **Action** and
**Assertion** copy it as `page.…`, as the action the element calls for (`fill`, `check`, `selectOption` or `click`)
or as its first assertion (`toHaveValue`, `toHaveText`…, `toHaveCount` for a locator finding several), as in
[Pick an element](./pick-an-element); each button names what it writes. **Add to session** puts it
in the session under a name (the panel's Session tab, below). With an editor
[paired](./editor-recording#send-from-piwi-picker), **Send to editor** under the top locator inserts it at the
editor's cursor, in the copy form you chose last. The pane ranks again when the selection changes and after
the page navigates; **Refresh** ranks the same node on the page as it is now. DevTools' own element picker
(`Ctrl+Shift+C`, `Cmd+Shift+C` on macOS) selects what the pointer is on.

The first time on a site, the pane asks for access to it with **Allow on this site**, as recording does. It is not
needed on a tab where you have just used the toolbar popup.

Elements inside an iframe are not ranked: their locator would need the frame's prefix. Use Pick an element there.

## The Piwi panel

DevTools also gets a **Piwi** panel of its own, with five tabs. It shows what runs on the page and stays up while the
page navigates; the recording and replay panels on the page stay too, for when DevTools is closed.

- **Record** lists a recording's steps as they are captured, each with the locator it was recorded with. **Stop
  recording** stops it as the popup does; then **Copy as TypeScript**, **Download steps** and **Discard** do what the
  review panel does. A bug report is finished from its panel on the page, which collects the evidence.
- **Replay** lists a replay's steps with their results and the verdict once it ends. **Pause**, **Continue**, **Next
  step** and **Stop** act on the replay running in the page.
- **Network** lists the page's `fetch` and XHR requests, from DevTools' own log while it is open; **Other sites too**
  adds the requests to other origins. Select one to mock it, slow it down or make it fail: [Mock and slow down requests](./mock-requests).
- **Locators** is the locator console: type a locator and the elements it finds are listed, as Playwright finds
  them, with the strict-mode verdict. It reads the expression, never runs it: every `getBy*`, `locator()`, chains,
  `filter()`, `and()`/`or()`, `.nth()` and same-origin frames. Hovering one outlines it on the page, and **Reveal**
  selects it in the Elements panel. **Enter** tries the locator at once and keeps it in a history that the up and down
  arrows go through, as in a shell; the history lasts until the browser closes, so the panel opened again shows the
  last locator. Under the field, **Copy as** writes the locator as a locator, an action or an assertion, as the
  Elements sidebar does, and **Add to session** names it for the Session tab. With an editor paired,
  [**Send to editor**](./editor-recording#send-from-piwi-picker) inserts it at the editor's cursor in the copy form
  chosen last. A `page.` typed in front is left out of what is copied or sent.
- **Session** lists the elements named with **Add to session**, and copies them as a page object, a Markdown table or
  JSON.

The toolbar starts the popup's tools on the inspected page without leaving DevTools: **Pick** is
[Pick an element](./pick-an-element), **Lint** the [lint overlay](./lint-overlay), and **Tested
elements** shows what your tests reach, once Piwi Picker is connected to your instance and the site is mapped to a
project (the button says what is missing until then). The first time on a site, the click asks for access to it, as
recording does. Then **Viewport**, **Playwright view** and **Save login for tests** set the page up for a test (below).

## Save login for tests

**Save login for tests**, in the Piwi panel's toolbar, saves the site's login as the
file Playwright's `storageState` reads: the site's cookies, `httpOnly` ones included, which a page's scripts cannot
read, and its `localStorage`. IndexedDB is left out. **Save login file** asks, the first time, for permission to read
that one site's cookies, on any of its ports and on its parent domains, where a login cookie is often set, then
downloads `user.json`:

```ts
test.use({ storageState: 'playwright/.auth/user.json' });
```

The file logs anyone in as you until the session expires: save it with a test account, as
`playwright/.auth/user.json`, and add `playwright/.auth` to `.gitignore`. The page offers both lines, and a setup test
that refreshes the file.

## Open this page at a viewport

**Viewport**, in the Piwi panel's toolbar, shows a bar that opens the inspected page in a new window whose viewport,
not its outer frame, has the size of one of your Playwright projects: **Mobile Safari (390×664)**. With a connection, the sizes come from the `use.viewport`
the [reporter](/guide/reporter) sends with each run, per project; without one, or for another size, choose **Size typed
by hand**. In Chrome and Edge, **In this tab** gives the tab itself that viewport instead, as DevTools' device toolbar
does, until **Back to the window's size**. Either way it sizes the viewport only, without touch, device pixel ratio or
user agent.

## Playwright view

**Playwright view**, in the Piwi panel's toolbar, labels the page as a test sees it: each button, link, field, heading and
landmark with the role and name `getByRole` finds it by, such as `button · Apply coupon` or `link · Cart (2)`, and its
test id beside it when it has one. Two marks point at the elements a test will struggle with:

- **Red**: no stable locator reaches it. A `<div>` with a click handler, a `tabindex` or a pointer cursor but no role,
  or a button or link with no name, and no test id either.
- **Amber**: its `getByRole` finds other elements too, two buttons both named "Show popup", or "Save" beside "Save
  draft". A test needs `exact: true`, a scope or `.nth()`.

The labels follow scrolling and come back after the page changes. Labels of elements side by side never cover one
another: each sits above its element, or a row or a few lower or higher when that place is taken. Where elements crowd
too closely for that, the labels left over are not drawn and the panel says how many. The panel in the corner counts
each kind, and **Role** shows the labels of one role only. Hidden elements get no label, as `getByRole` does not find them. Press
**Esc** or `V` again to turn it off. The [lint overlay](./lint-overlay) stays for suggesting the test ids to
add.
