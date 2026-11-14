---
title: Pick an element
description: "Pick an element on the live page with Piwi Picker: its ranked locators, each checked against the page, with the action, the assertion and the context a test or an agent needs."
lang: en-US
---

# Pick an element

<Needs extension />

**Pick an element**, in the [Piwi Picker](./extension) popup or with its shortcut, ranks the Playwright locators of one
element of the page you are looking at, checks each against the page, and writes what a test needs around it. This
page is where the pick itself, the narrowing of a locator that finds several elements and the copy forms are
explained; the [DevTools sidebar](./devtools#the-elements-sidebar), the [lint overlay](./lint-overlay) and the
[Tested elements](./tested-elements) replacements reuse them.

<figure>
  <img src="/screenshots/picker-pick.png" alt="The ranked locators of a Checkout button, the unique one first">
  <figcaption>Pick an element: the locator that finds exactly one element comes first.</figcaption>
</figure>

## How a pick works

Hover highlights, a click picks. The pick snaps to the nearest actionable ancestor (the text inside a button picks
the button), and ↑/↓ walk the DOM tree, showing the locator each step would produce. When a locator that is not
brittle already finds the element alone, the results open at once, and **Scope to a parent…** in them opens the
**anchors** step: stable parents to scope the locator to, each listed with its strongest hook (a test id, an `id`, a
labeled landmark, a role), with a live match count, after which the results show again
with the scoped locators. When none finds it alone, the anchors step comes first.

<figure>
  <video src="/videos/picker-pick-loop.mp4" autoplay loop muted playsinline controls aria-label="Picking on a shop page: the outline and the locator follow the pointer, the arrow keys walk up to the parents and back, and a click on Checkout opens its ranked locators"></video>
  <figcaption>Hover, walk the tree with ↑ and ↓, click: the ranked locators open.</figcaption>
</figure>

**Enter** picks too: the highlighted element when the pointer is on one, otherwise the element that has the keyboard
focus, so a control reached with Tab is picked without the mouse. **Esc** cancels the pick.

Elements inside a web component's open shadow root are picked like any other: ↑ walks out of the shadow root through
its host element, and the anchors step lists the host and its parents and counts the matches inside open shadow roots,
as Playwright's locators do.

Every candidate uses the names Playwright computes (a tab with a count badge is `{ name: 'Regressions 5' }`), is
scored as the dashboard scores locators, and run against the page. Those that find only the picked element come
first; a narrowed one ranks just under the candidate it was built from.

## Narrowing a locator that finds several

A candidate that finds the picked element among others is narrowed, trying in this order and keeping the first that
finds the element alone:

1. **Exact**: the name or text matched exactly (`exact: true`).
2. **The element's own text**: `.filter({ hasText })` with its text, when that text is short. Controls that share a
   name often still say different things.
3. **A parent with a test id unique on the page**, the author's own hook.
4. **The repeated row, list item or card** the element sits in: the nearest ancestor whose copies hold the other
   elements the candidate finds. The copies are recognized by a shared test id, else a shared tag and role, else a
   shared readable class. The container is picked by its own accessible name when its author gave it one
   (`aria-label`, `aria-labelledby`), else by a short text it shows and no other copy contains: a heading first, then
   a text that names rather than counts (a name before a price or a quantity), the shorter first, and a visible text
   before a hidden one:
   `getByTestId('product-card').filter({ hasText: 'Blue mug' }).getByRole('button', { name: 'Add to cart' })`.
5. **The nearest landmark**, or a named dialog, region, form, row, list item or other named group around it.

Only when none of these finds it alone is it offered with `.first()` or `.nth()`, and a warning, which the
[stability rules](/reference/locator-stability) mark as a position.

## The results

While the results are open, the picked element stays outlined on the page, and the results move to the other side of
the page when they would cover it. **Pick another** closes them and starts picking the next element, without going
back to the popup or the shortcut.

Each locator leads with a word: `stable`, `could break` or `brittle` for one that finds the element alone, by what the
[stability rules](/reference/locator-stability#levels) say of it, and `unique by position`, `3 matches` or
`not checked` otherwise, the words the DevTools sidebar uses. Its **Details** give the reasons
(`unique · brittle: CSS class`) and the stability score.

## Copy as a locator, an action or an assertion

Every locator Piwi Picker offers, here, in the DevTools sidebar and in the Locators console, copies three ways, and
each button names what it writes, such as **Action (fill)** or **Assertion (toHaveText)**:

- **Locator**: `page.` and the locator.
- **Action**: the call the element calls for, `fill` with what a field holds (`'value'` for an empty field or a
  password), `check` for a checkbox or a radio, `selectOption` for a select (an array for several options), `click` for
  anything else.
- **Assertion**: the element's first [suggestion](#assertion-suggester) (`not.toBeChecked` for an unchecked box), and
  `toHaveCount` for a locator that finds several elements.

Where the element is not known, the action is a `click` and the assertion `toBeVisible`. **Copy all** copies every
ranked locator, one per line, for a project's [Locators page](./locator-usage#the-locators-page). **Add to session**
names a locator for the session that the DevTools Piwi panel's Session tab lists and copies as a page object, as the
Elements sidebar does (see [Developer tools](./devtools)).

## Multi-pick

Pick two or three similar items (rows, cards) to get the pattern they share, such as
`getByRole('row').filter({ hasText: … })`. Pick the same button in two rows or cards (Delete, Add to cart) and the
pattern is the button inside the repeated row or card, with how many elements it finds on the page:
`getByTestId('product-card').getByRole('button', { name: 'Add to cart' })`, then each pick as its card filtered by a
text only that card shows, such as its heading. It warns when only `.nth()` could tell them apart.

## Assertion suggester

With the popup's **Assertions** tile, pick an element to get the `expect(...)` candidates that apply to it, most telling first (`toHaveValue`,
`toBeChecked`, `toContainText` with the start of a long text, `toHaveText`, `toHaveAccessibleName`, `toBeVisible`),
built on its top-ranked locator. `toHaveAccessibleName` is offered only for an
element that has a name, as Playwright computes it: a paragraph takes none from its text, a field takes its label's.

## Copy context for agent

With the popup's **Agent context** tile, pick an element to copy one block for a coding agent: the page URL, the element and every ranked locator.

## Related

- [Browser extension](./extension): the other tools, the permissions and the limits
- [Developer tools](./devtools): the same ranking for the element selected in DevTools
- [Lint overlay](./lint-overlay): the elements no stable locator finds alone
- [Locator stability](/reference/locator-stability): the rules behind the words
- [Fix a broken locator](/recipes/broken-locator): from a failing locator to the one to use instead
