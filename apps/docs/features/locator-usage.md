---
title: Who uses a locator
description: "Before changing an element, see which tests reach it and from which lines, from the locator chains Playwright records on every step."
lang: en-US
---

# Who uses a locator

Before you change an element — rename a label, remove a `data-testid`, replace a `<select>` with an autocomplete — you can see which tests reach it and from which lines. After the change, [Locator preflight](./preflight) reads your diff and lists the locators it breaks.

Playwright reports the full locator chain on every locator step: `getByRole('form', { name: 'Shipping' }).getByLabel('Country')`, not only the last call. Piwi already stores those steps for every execution, passing ones included, so it indexes each chain with the action that used it (`Select option`, `Expect toHaveValue`, …) and the call site (`file:line:col`, often a page-object method). Nothing extra is captured while tests run: the index works with the reporter alone, and with [locator healing](./locator-healing) turned off.

## The Locators tab

An execution's evidence card has a **Locators** tab listing every locator the test used, in order, with the action and the call site. The count beside each one is how many tests in the project use the same chain. A test case's page shows the same list for its latest execution.

<figure>
  <img src="/screenshots/execution-locators.png" alt="The Locators tab of an execution: each locator the test used, numbered in step order, with its action above it and a button giving how many tests use the same chain">
  <figcaption>Every locator an execution used, in step order.</figcaption>
</figure>

Opening a count answers **Who uses this?** in three ways:

- **This locator** — tests whose steps used this exact chain.
- **Same target** — chains ending on the same call inside any container, so `getByLabel('Country')` on its own and inside the shipping form both count.
- **Inside its container** — every chain that searches inside one of the chain's containers. Changing the container itself (removing a wrapper, renaming a form) reaches all of them, even when no test targets the container directly.

Call sites shared by the most tests come first: a page-object line used by five tests is one fix for all five. **Run these tests** turns the list into a `npx playwright test` command through the same materialization as [test selection](/features/test-selection).

## The Locators page

A project's page links to **Locators** from its **More actions** menu, and an execution's
**Locators** tab links to it too. It answers the question from the other side: not "what does
this test use?" but "does any test use this?".

**Check locators** takes locators pasted one per line, as the
[Piwi Picker extension](./extension)'s **Copy all** copies them for an element, or lines of test
code (`await page.getByLabel('Card number').fill('4242…')`: the locator is read out of each
line). Each locator gets a verdict, from the closest match found:

- **Used by N tests** — the exact chain is in the index.
- **Same target in N tests** — the same last call, inside other containers.
- **A similar locator in N tests** — the same method with a looser argument that finds the same
  element: a test's `getByRole('button', { name: /pay/i })` or `getByText('Pay')` finds the
  pasted `getByRole('button', { name: 'Pay now' })` or `getByText('Pay now')`, following
  Playwright's case-insensitive substring matching when `exact` is not set.
- **A container in N tests** — the locator is a container that other chains search inside.

Below the verdicts, the tests reaching any of the pasted locators are listed once, with how many
of the locators each one reaches. Paste every locator the extension gives for an element, and
that list answers whether the element is tested, whichever way the tests wrote its locator.
The page keeps what you paste in its URL (`?q=`), so a check can be shared as a link; the
extension's **Find these locators in Piwi ↗** opens it that way.

**Locators your tests use** lists every chain of the index, the ones shared by the most tests
first, with a filter. Each count opens **Who uses this?**. A chain the
[locator stability rules](/reference/locator-stability) flag says why: *brittle* when it breaks on changes unrelated
to what its test checks, such as a position or a styling class, *watch* when it is only worth a look. The
**Stability** select lists only those; the extension's [Tested elements](./tested-elements#brittle-locators) offers
a replacement for them on a live page.

The index behind this page is also what the extension's [Tested elements](./tested-elements)
overlay evaluates on a live page.

## Branches

Each use is stored with the branch of the run that recorded it. A run on the project's
default branch, or with no branch, records the default branch's uses; a run on any other
branch records that branch's own. A feature branch that renames a label never hides the old
label's tests on `main`, and `main` only loses a use once its own runs stop making it. The default branch is the one Piwi knows for the project, the most common
branch among its runs otherwise, as for [branch baselines](./branches).

The **Locators** page, **Who uses this?** and the extension's
[Tested elements](./tested-elements) read one branch at a time:

- **The default branch**, unless another is chosen.
- **A branch**: the tests that ran on it count with what they did there, and the others with
  what they do on the default branch, since a test that did not run on a branch is taken to be
  unchanged on it. This is per Playwright project: a test that ran only in `chromium` on the
  branch keeps its default-branch uses in `firefox`.
- **All branches**: every use recorded on any branch, which answers "does any run of the
  project still use this locator?".

An execution's **Locators** tab counts in the branch of its own run. The index lists at most
the 50 branches seen most recently; the uses of a branch stay until the index is rebuilt.

## Pages

With the [capture fixtures](/guide/capture-fixtures), each use also records the
[page](/guide/concepts#page-key) its call ran on, `/checkout` or `/orders/:id`, and whether it ran as the page loaded,
before any locator interaction there. The Locators page says where each chain is used and filters by page, **Who
uses this?** gives the pages of each call site, and the extension's [Tested elements](./tested-elements#this-page)
shows only what tests do on the page you are on. Without the fixtures a use has no page, and counts on every page.

## Requirements and limits

- **Step collection on** (`collectPerformanceMetrics`, the default). Playwright 1.63 puts the chain in each step's parameters; an older one prints it in the step title, which Piwi reads the same way.
- **Getter calls are not reported.** Playwright hides `textContent()`, `inputValue()`, `isVisible()` and similar calls from reporters, so a locator used only through them is not in the index.
- **Long and described chains.** Piwi keeps 500 steps of an execution (`PIWI_INGEST_MAX_STEPS`, the steps that failed first) and the first 200 characters of each step parameter (`PIWI_INGEST_MAX_STEP_PARAM_VALUE_CHARS`), and `locator.describe()` replaces the chain with its description. Chains cut short or described are skipped.
- **Matching is by chain text.** Two different chains that happen to resolve to the same element count separately. The counts tell you where to look, not that a test will break. To match on the element itself, open the page and use the extension's [Tested elements](./tested-elements), which evaluates every chain there.
- **The index fills itself.** New runs are indexed as they arrive. When the server starts, it indexes each project's stored history once: for every test, Playwright project and branch, the latest passed execution, or the latest one when none passed. The rebuild endpoint empties a project's index and indexes its stored history again, which also splits by branch the uses indexed before branches were recorded (until then they count as the default branch's): see the [API docs](https://piwitests.dev/demo/docs), or `/docs` on your own instance.

## Related

- [Tested elements](./tested-elements): the elements your tests reach, on the page itself
- [Locator preflight](./preflight): the locators a change breaks, before you push it
- [Locator healing](./locator-healing): the replacement when a locator breaks anyway
- [Locator stability rules](/reference/locator-stability): what makes a locator brittle
