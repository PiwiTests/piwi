---
title: Locator healing
description: "When a locator breaks, ranked replacements captured from the last passing run, a recommended fix in your suite's style, and pickers for local runs."
lang: en-US
---

# Locator healing

<Needs reporter fixtures />

When a locator stops matching (a button was renamed, an element moved, a hashed class changed), Piwi suggests
ranked replacements, captured from the last run where the test passed.
Healing is read-only: it never rewrites your test. [Auto-heal PRs](./auto-heal) is the separate, opt-in feature that
opens the fix as a pull request.

## What it does

While tests run, the [capture fixtures](/guide/capture-fixtures) record a [locator snapshot](/guide/concepts#locator-snapshot)
after each successful action **or passing web-first assertion** (a passing `expect(locator).toBeVisible()` proves the
element resolved just as a click does): the target element's attributes, plus alternative locators ranked by a
stability score (`data-testid` = 100, role + accessible name ≈ 90, semantic CSS ≈ 35–40, hash-suffixed ≈ 10). Capture
also generates **rename-proof** alternatives: locators scoped to a stable ancestor
(`getByTestId('signup-form').getByRole('textbox')` ≈ 72, a unique landmark ≈ 55) and a name-free `getByRole` when the
element is the only one of its role. Each candidate is checked against the live page: an ambiguous test id, id, `name`
or class is dropped, and an ambiguous role, text, placeholder, alt or title candidate ranks below every unique one.
Input values are never captured.

<figure>
  <img src="/diagrams/locator-healing-capture.svg" alt="Diagram of the capture flow: a successful action or passing assertion goes through the capture proxy to an in-page element probe, which produces ranked alternative locators stored as one row per call site">
  <figcaption>Capture runs while tests pass: every locator that proves it resolves leaves behind ranked, uniqueness-checked replacements for the day it breaks.</figcaption>
</figure>

When a locator later fails, the server looks for replacements, most trustworthy first:

1. **Diff rename**: the run's own diff renamed the string the locator finds its element by, at this call site, as
   [Locator preflight](./preflight) predicts it with a _likely_ break. The replacement is the same locator with the new string, and the
   panel says where: "“Pay now” became “Pay” in CheckoutButton.vue:14". It needs a run with a diff (a pull request,
   or a commit after a passing run) and a source-control token. Its edit replaces the string inside your quotes, and
   an [auto-heal PR](./auto-heal) can use it.
2. **Prior run**: the same call site (`file:line:col`, or `file:line` when only the column moved) had a passing
   snapshot.
3. **Fingerprint**: the call site moved lines, but the locator matches a prior snapshot.
4. **Cross-test**: another test in the project captured the same locator.
5. **ARIA fallback**: no snapshot exists, so limited suggestions come from the failure-time ARIA snapshot: elements
   sharing a word or the role with the failing locator.

A snapshot found by rungs 2 to 4 is then checked against the failing page's ARIA snapshot. When the element is gone
under its old name and a confident match exists, fresh locators for the element it most likely became replace the
stored ones (an **element match**), matched by role, heading level and, on a total rename, its position among
elements of the same role.

<figure>
  <img src="/diagrams/locator-healing-resolution.svg" alt="Diagram of the healing resolution flow: the failing error is parsed into a locator signature and call site, matched through the stored history, checked against the failing page's ARIA snapshot, and shown in the Locator fix panel">
  <figcaption>Every stored match is checked against the failing page before anything is recommended.</figcaption>
</figure>

A single **recommended fix** is highlighted. It keeps your locator *style* where that style is stable enough, and only
otherwise escalates to the sturdiest alternative or advises adding a `data-testid`. When the stored accessible name is
provably gone from the failing page, name-based alternatives, the failing locator included, stay listed but are never
recommended.

When a strict-mode violation matched several elements and only **one is visible**, the panel also suggests adding
Playwright's `.visible()` (1.63 and later), the right fix when the duplicates are hidden copies rather than a naming
problem.

## Where it is

The **Locator fix** section of **More ways to fix**, on the [execution](./evidence#one-execution-diagnosis-first) and
failure cluster pages; a cluster whose next step replaces the locator shows it under the situation block. The same result goes into the [AI diagnosis](./ai-diagnosis#locator-healing) context and the
[fix plan](./fix-plans), and reaches agents through the `get_locator_healing` [MCP tool](/features/mcp).

<figure>
  <img src="/screenshots/locator-healing.png" alt="Locator fix panel showing ranked replacement locators with stability scores and a recommended fix">
  <figcaption>The Locator fix panel: replacements ranked by stability score, with a recommended fix and a copy button for each.</figcaption>
</figure>

## Use it

Copy the recommended fix, or another alternative, and change the line the panel names. With an uploaded trace,
**Pick from trace** opens the failure in the dashboard's [trace viewer](./evidence#trace-viewer), whose *Pick locator*
tool works on the recorded page snapshots, so a CI failure nobody watched can still be picked visually. A replacement
you confirmed with a picker shows a **Your pick** badge and becomes the recommended fix.

The first later run whose code at that call site uses the recommended locator shows as **healed in run #N**, whoever
made the edit.

## Inspect the failing page live (local runs)

With `inspectOnFailure: true` (or `PIWI_INSPECT_ON_FAIL=true`), a failing test opens **Piwi's own inspector overlay**
on its still-open page right before the browser closes. Click any element to get ranked, uniqueness-checked locators
for it; one you confirm is recorded like a pick. It is not Playwright's inspector, so what you confirm flows back into
the healing data when the failure names a locator to replace.

```bash
# Linux / macOS
PIWI_INSPECT_ON_FAIL=true npx playwright test --headed

# Windows (PowerShell)
$env:PIWI_INSPECT_ON_FAIL='true'; npx playwright test --headed
```

Both local options need a **headed** browser (`--headed` or `headless: false`), never activate under CI (`CI` set to
anything but empty or `false`), skip expected failures (`test.fail()`), and with retries configured open only on the
final attempt. The run waits while the overlay is open (the test timeout is lifted), so prefer `--workers=1`.

## Pick a replacement locator on the failing page (local runs)

With `pickLocatorOnFailure: true` (or `PIWI_PICK_LOCATOR_ON_FAIL=true`), a test that failed on a locator, in an action
(`.click()`, `.fill()`) or an assertion (`expect(locator).toBeVisible()`), gets the same overlay aimed at the locator
that broke:

1. **Pick the element.** The pick snaps to the nearest actionable ancestor, and <kbd>↑</kbd>/<kbd>↓</kbd> walk the DOM
   tree before you click, showing the locator each step would produce. <kbd>Enter</kbd> picks the highlighted element,
   or with none the element that has the keyboard focus.
2. **Choose stable parents (optional).** The element's ancestors are listed with their strongest hook (`data-testid`,
   `#id`, labeled landmark, role); selecting one scopes the locator to it, with a live **"matches N"** count.
3. **Confirm** one of the ranked candidates.

```bash
# Linux / macOS
PIWI_PICK_LOCATOR_ON_FAIL=true npx playwright test --headed

# Windows (PowerShell)
$env:PIWI_PICK_LOCATOR_ON_FAIL='true'; npx playwright test --headed
```

The pick is recorded in the run's locator snapshots, so the **Locator fix** panel shows it first once the run uploads,
as a `piwi-user-pick` attachment and annotation in the Playwright report, and in the terminal with the call site and
the replacement. The picker blocks the page's own click handlers while active, so picking can't navigate away. The
same picker ships as the [Piwi Picker browser extension](/features/extension), for any live page with no test run.

## Pause at a breakpoint (local runs)

With `PIWI_PAUSE_AT=tests/login.spec.ts:42` (semicolon-separated `file:line`, relative to the working directory or
absolute: `tests/login.spec.ts:42;tests/pages/checkout.page.ts:9`; an entry without a line is skipped, and the output
says so), a locator action or assertion on a listed line waits before it runs: its element is highlighted and a bar at
the top of the page offers **Resume**, **Step** (pause at the next action), **Pick a locator** (the picker above) and
**Finish** (no more pauses in this test); <kbd>Esc</kbd> resumes. A pick is recorded and printed like the failure-time
one, and posted to `PIWI_EDITOR_SEND`, an editor's pairing address, with its line. Headed and never under CI, like the
options above; every attempt pauses. The editor extensions set both from your
[breakpoints](./editor-breakpoints).

## Limits

- Healing runs only when the locator **never resolved**, matched nothing, or matched several elements. When it resolved
  and the step failed afterwards (`element is not enabled`, a wrong count, a hidden element) or the page failed to
  load, the panel says *The locator resolved; this is not a locator problem* (for a page that failed to load, *The page
  failed to navigate before any locator ran*), because rewriting a locator that found its element would be a harmful
  edit.
- Suggestions need a passing run captured with the fixtures in place; until then only the ARIA fallback applies.
- Capture costs one DOM read per call site, at most once per call site per test. Negated assertions, absence checks
  (`toBeHidden`, `toBeDetached`) and multi-element checks (`toHaveCount`) are never probed. Turn it off with
  `captureLocators: false` or `PIWI_CAPTURE_LOCATORS=false`; it is also off whenever `collectPerformanceMetrics` is
  `false`.

## Related

- [Fix a broken locator](/recipes/broken-locator): healing, used end to end on one broken locator
- [Capture fixtures](/guide/capture-fixtures): the one-file setup that records the locator snapshots
- [Auto-heal PRs](./auto-heal): when Piwi opens the recommended locator fix as a pull request itself
- [Who uses a locator](./locator-usage): the tests that reach an element, before you change it
- [Browser extension](/features/extension): the same picker on any live page, no run needed
