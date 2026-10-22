---
title: Lint overlay
description: "Piwi Picker's lint overlay: the interactive elements of a page no stable locator finds alone, each with the test id or the scope to add."
lang: en-US
---

# Lint overlay

<Needs extension />

The **Lint overlay**, under **More tools** in the [Piwi Picker](./extension) popup, checks every button, link and
field of the page with the ranking [Pick an element](./pick-an-element) uses.

One click outlines every interactive element no stable locator finds alone and says what to add, with a **Copy**
button for each and **Copy as a Markdown checklist** for all of them:

- **A test id named after the element**: its accessible name, label or placeholder, else the nearest heading with the
  role (`data-testid="submit-order"` for a button named "Submit order", `shipping-address-button`), else the role. A
  value the page already uses, or another suggestion took, gets `-2`, `-3`.
- **A test id on the repeated container** when the element sits in a row, a card or a list item whose copies hold the
  same element: named after the text that tells this copy apart (`data-testid="blue-mug"`), with the locator a test
  then uses, `getByTestId('blue-mug').getByRole('button', { name: 'Add to cart' })`. The container and the text are
  the ones [Pick an element](./pick-an-element) narrows by: the nearest container whose copies hold the other
  elements, and a text no other copy contains, a heading first, then a name rather than a price or a count, a
  visible text before a hidden one. The container is outlined in amber.
- **A scope** when those copies already share a test id: no attribute to add, the locator filters by the copy's text,
  `getByTestId('product-card').filter({ hasText: 'Blue mug' }).getByRole('button', { name: 'Add to cart' })`.

<figure>
  <img src="/screenshots/picker-lint.png" alt="Four unnamed wishlist icon buttons outlined in their product cards, each with a test id named after its card's heading">
  <figcaption>Lint overlay: four icon buttons without a name; each gets a test id named after its card's heading. The Add
  to cart buttons beside them are not listed: the ranking finds each one through its card.</figcaption>
</figure>

## Related

- [Pick an element](./pick-an-element): the ranked locators of one element
- [Locator stability](/reference/locator-stability): what makes a locator stable
- [Browser extension](./extension): the other tools and the permissions
