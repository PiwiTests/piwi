---
title: Locator stability rules
description: "Every rule Piwi uses to call a locator your tests use brittle or worth watching, what it catches and why that breaks."
lang: en-US
---

# Locator stability rules

A **brittle locator** breaks on a change unrelated to what its test checks: a restyle, a wrapper added around an
element, an item added to a list, a copy edit, other data. `locator('.btn-primary').nth(1)` breaks when the button is
restyled or another button appears before it. This page holds the rules Piwi judges a locator by, the levels they
give, and how a replacement for a brittle one is chosen; the pages that show a level link here.

## Levels

Piwi judges every locator of the [locator index](/features/locator-usage), and every locator
[Piwi Picker](/features/pick-an-element) offers, with the rules below, from the locator's text alone, and gives it one
of three levels:

- **Brittle**: at least one rule gives it that level. The [Tested elements](/features/tested-elements#brittle-locators)
  overlay lists it under **At risk**, and offers a replacement; the Locators page says why.
- **Watch**, which Piwi Picker writes **could break** (in its pick results, the DevTools sidebar and the Tested
  elements cards): a rule has something to say, but the locator does not break on its own. Shown on the element's card
  and on the Locators page, never listed under **At risk**.
- **Stable**: no rule has anything to say.

A locator takes the level of its worst part: a stable container cannot save a brittle target, and a brittle container
breaks every locator searching inside it. Locators nested in `filter({ has })`, `and()` and `or()` count as parts.

## Rules

| Rule | Level | Catches | Example |
|---|---|---|---|
| Position<br>`position` | brittle for `nth(1)` and beyond; watch for `first()`, `last()` and `nth(0)` | An element picked by its order. An element added above it, or a list sorted another way, moves it. | `getByRole('listitem').nth(2)` |
| CSS class<br>`css-class` | brittle for a utility, hashed or CSS-in-JS class; watch for a named class | An element found by a class. Classes change with the styling. | `locator('.bg-blue-500')`, `locator('.css-1q2w3e')` |
| CSS structure<br>`css-structure` | brittle | A child or sibling combinator, `:nth-child()` and its kind, three or more selectors deep, or a descendant chain of tags only. A wrapper added or moved breaks it. | `locator('form > div:nth-child(2) input')` |
| XPath<br>`xpath` | brittle when absolute or indexed; watch otherwise | XPath follows the document structure. | `locator('//main/div[2]//button')` |
| Generated id<br>`generated-id` | brittle | An id a framework or a build generates, which changes from one render or build to the next. | `locator('#radix-:r4:')`, `locator('#input-1748291')` |
| Style attribute<br>`style-attribute` | brittle | The `style` or `class` attribute matched as a string, which any styling edit changes. | `locator('[style*="display: block"]')` |
| Long text<br>`long-text` | watch | An exact string over 40 characters in `getByText`, a `name` or `hasText`: copy changes long before behavior does. | Marketing copy |
| Number in text<br>`data-text` | watch | A count, price, date, time or percentage inside an exact string, which changes with the data. | `getByRole('button', { name: 'Cart (3)' })` |
| Long chain<br>`deep-chain` | watch | More than three locating calls: each container is one more thing a change can break. | Four chained `getBy…` calls |

Not flagged: `getByTestId`, `getByRole` with a name, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, an
id that is not generated, `[name=…]` and `[data-testid=…]`, a single tag inside a container, a regular expression, and
a short text. A locator matching several elements is not a stability problem: the overlay shows it as ambiguous.

## Replacements

On a live page, the [Tested elements](/features/tested-elements#brittle-locators) overlay offers a replacement for a
brittle locator that finds exactly one element of the top-level document. It ranks the locators for that element the
way [Pick an element](/features/pick-an-element) does, a candidate that finds the element among others
[narrowed](/features/pick-an-element#narrowing-a-locator-that-finds-several) first (an element of a list, a grid or a
table gets `getByTestId('product-card').filter({ hasText: 'Blue mug' }).getByRole('button', { name: 'Add to cart' })`
rather than `getByRole('button', { name: 'Add to cart' }).nth(1)`). It keeps those these rules call stable and that
find only that element on the page, and picks one as
[locator healing picks its recommended fix](/features/locator-healing#the-recommended-fix): the brittle locator's own
method, then its family, when one of those is stable enough; otherwise the most stable one, which the row then also
shows as **Most stable** when it differs. When no stable locator finds only that element, the overlay says to give it
a test id.

A replacement is checked against the page as it is now. A test that uses the locator in another state of the page
may need a different one.

## Related

- [Tested elements](/features/tested-elements)
- [Who uses a locator](/features/locator-usage)
- [Locator healing](/features/locator-healing)
