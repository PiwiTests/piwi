---
title: Pick an element
description: "Pick an element on the live page with Piwi Picker: its ranked locators, each checked against the page, with the action, the assertion and the context a test or an agent needs."
lang: en-US
---

# Pick an element

<Needs extension />

**Pick an element**, in the [Piwi Picker](./extension) popup or with its shortcut, ranks the Playwright locators of one
element of the page you are looking at, checks each against the page, and writes what a test needs around it.

<figure>
  <img src="/screenshots/picker-pick.png" alt="The ranked locators of a Checkout button, the unique one first">
  <figcaption>Pick an element: the locator that finds exactly one element comes first.</figcaption>
</figure>

## How a pick works

Hover highlights, a click picks. The pick snaps to the nearest actionable ancestor (the text inside a button picks
the button), and ↑/↓ walk the DOM tree, showing the locator each step would produce. When a locator that is not
brittle already finds the element alone, the results open at once, and **Scope to a parent…** in them opens the
**anchors** step: stable parents to scope the locator to, with a live match count, after which the results show again
with the scoped locators. When none finds it alone, the anchors step comes first.

**Enter** picks too: the highlighted element when the pointer is on one, otherwise the element that has the keyboard
focus, so a control reached with Tab is picked without the mouse. **Esc** cancels the pick.

Elements inside a web component's open shadow root are picked like any other: ↑ walks out of the shadow root through
its host element, and the anchors step lists the host and its parents and counts the matches inside open shadow roots,
as Playwright's locators do.

Every candidate uses the names Playwright computes (a tab with a count badge is `{ name: 'Regressions 5' }`), is
scored as the dashboard scores locators, and run against the page. Those that find only the picked element come
first. One that also finds others is narrowed, trying in order:

- the exact name or text, then the element's own text as a filter;
- a parent whose test id is unique on the page;
- the repeated row, list item or card the element sits in, picked by a short text it shows and its siblings do not
  (a cell, a heading, a visible text before a hidden one), or by its own `aria-label`:
  `getByTestId('product-card').filter({ hasText: 'Blue mug' }).getByRole('button', { name: 'Add to cart' })`;
- its landmark, a named dialog or a named row.

Only when none of these finds it alone is it offered with `.first()` or `.nth()`, and a warning.

While the results are open, the picked element stays outlined on the page, and the results move to the other side of
the page when they would cover it. **Pick another** closes them and starts picking the next element, without going
back to the popup or the shortcut.

Each locator leads with a word: `stable`, `could break` or `brittle` for one that finds the element alone, by what the
stability rules say of it, and `unique by position`, `3 matches` or `not checked` otherwise, the words the DevTools
sidebar uses. Its **Details** give the reasons (`unique · brittle: CSS class`) and the stability score.

Copy the result as the bare locator, an action line or an assertion; **Copy all** copies every ranked locator for a
project's [Locators page](./locator-usage#the-locators-page). The action is the one the element calls for: `fill` with
what a field holds (`'value'` for an empty field or a password), `check` for a checkbox or a radio, `selectOption` for
a select, `click` for anything else. The assertion is the element's first
[suggestion](#assertion-suggester), and `toHaveCount` for a locator that finds several elements. Each button names
what it writes, such as **Action (fill)** or **Assertion (toHaveText)**. **Add to session** names a
locator for the session that the DevTools Piwi panel's Session tab lists and copies as a page object, as the Elements
sidebar does (see [Developer tools](./devtools)).

## Multi-pick

Pick two or three similar items (rows, cards) to get the pattern they share, such as
`getByRole('row').filter({ hasText: … })`. Pick the same button in two rows or cards (Delete, Add to cart) and the
pattern is the button inside the repeated row or card, with how many elements it finds on the page:
`getByTestId('product-card').getByRole('button', { name: 'Add to cart' })`, then each pick as its card filtered by a
text only that card shows, such as its heading. It warns when only `.nth()` could tell them apart.

## Assertion suggester

Pick an element to get the `expect(...)` candidates that apply to it, most telling first (`toHaveValue`,
`toBeChecked`, `toContainText` with the start of a long text, `toHaveText`, `toHaveAccessibleName`, `toBeVisible`),
built on its top-ranked locator. `toHaveAccessibleName` is offered only for an
element that has a name, as Playwright computes it: a paragraph takes none from its text, a field takes its label's.

## Copy context for agent

Pick an element to copy one block for a coding agent: the page URL, the element and every ranked locator.

## Related

- [Browser extension](./extension): the other tools, the permissions and the limits
- [Developer tools](./devtools): the same ranking for the element selected in DevTools
- [Lint overlay](./lint-overlay): the elements no stable locator finds alone
- [Locator stability](/reference/locator-stability): the rules behind the words
- [Fix a broken locator](/recipes/broken-locator): from a failing locator to the one to use instead
