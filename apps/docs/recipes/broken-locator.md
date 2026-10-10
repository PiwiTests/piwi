---
title: Fix a broken locator
description: "A UI change broke a Playwright locator. Piwi proposes ranked replacements captured from the last run where the test passed, and points at the line to change."
lang: en-US
---

# A locator broke after a UI change — what should I use instead?

Someone renamed a button, moved a `data-testid`, or wrapped a row in one more `div`, and a handful of
tests now fail on `locator.click: Timeout … waiting for getByRole('button', { name: 'Save' })`. The fix
is rarely hard; finding a replacement that won't break again next sprint is the actual work.

Piwi captures what the element looked like **on the last run where the test passed**, so the
replacement is proposed from a page that worked rather than from the broken one in front of you.

## 1. Open the failing execution's alternative locators

On a failing execution, the **Locator fix** panel (under *More ways to fix*) lists candidate replacements
ranked by stability, with one marked as the recommended fix.

<figure>
  <img src="/screenshots/locator-healing.png" alt="Locator fix panel with ranked replacement locators and a recommended fix">
  <figcaption>Ranked replacements captured from the last passing run — the recommendation favours locators that match the conventions already in your suite.</figcaption>
</figure>

The ranking prefers what Playwright itself prefers — role and test-id over structural CSS — and leans
toward the style your existing specs already use, so the suggestion doesn't drag a second convention
into the codebase.

## 2. Jump to the line and change it

Every source path in the dashboard is clickable, including the failing call stack. Hover the path and
use **open in IDE** to land on the exact line. That mapping is configured
[per browser](/features/ide-integration) and stored locally — your checkout path is never sent to the server.

No IDE integration set up? The path and line number are plain text on the page; the fastest route is
usually copying them.

## Shortcut: if it broke on your machine, fix it before the browser closes

Everything above assumes the failure is already in the dashboard. When you're running locally, there's
a faster path — pause on the failing page and pick the replacement from the live DOM, while the app is
still in the state that broke it.

Two reporter options, both off by default, do it: `pickLocatorOnFailure` opens Piwi's picker aimed at the locator
that just broke, and `inspectOnFailure` opens the same overlay free to inspect any element. The run pauses with the
failing page still open, you click the element you meant, and the candidate you confirm comes back in the dashboard
with a **Your pick** badge as the recommended fix. It never rewrites your test.

Both need a headed browser and never run under CI; [Pick a replacement locator on the failing
page](/features/locator-healing#pick-a-replacement-locator-on-the-failing-page-local-runs) has the options, the gates
and the commands.

## Requirements, honestly

Locator healing needs the [capture fixtures](/guide/capture-fixtures) in your test setup. The reporter alone
uploads results without touching your test code, but it cannot see the DOM — the ranked alternatives
come from [locator snapshots](/guide/concepts#locator-snapshot) the fixtures record while the test runs.

It is one file:

```typescript
// tests/fixtures.ts
import { test as base } from '@playwright/test'
import { extendPiwiFixtures } from '@piwitests/reporter'

export const test = extendPiwiFixtures(base)
export { expect } from '@playwright/test'
```

Import `test` from that file in your specs. A spec that still imports from `@playwright/test` directly
runs and reports fine — it just isn't captured.

Snapshots are only recorded going forward, so the first healing suggestions appear once a passing run
has been captured with the fixtures in place.

## If you can't add the fixtures

Some suites can't take the code change — a vendored test pack, a repo you don't own, a migration you
don't want mid-release. Four routes that don't need it:

**Pick from the trace, after the fact.** When the failing execution has an uploaded trace, the
alternative-locators panel offers **Pick from trace**: it opens the trace in the dashboard's bundled
[trace viewer](/features/evidence#trace-viewer), whose *Pick locator* tool works on the recorded page
snapshots. So a CI failure nobody watched live can still be picked visually, days later, from the page
as it actually was.

**Pick against the live page.** The [browser extension](/features/extension) scores locators with the same
engine the dashboard uses, directly on the page you're looking at. Picking and recording are fully
standalone — nothing is sent anywhere, and it works without a Piwi instance at all. The cost: one
click from the [Chrome Web Store](https://chromewebstore.google.com/detail/piwi-picker/pakhnokpjboejcghgcmkjlpnogfjihhe),
which is also how you install it in Edge, or from [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/piwi-picker/).

**Read the failure evidence you already have.** Without fixtures you still get the trace, the
screenshot, and the failing call stack. Playwright's trace viewer is bundled and served by your own
instance — the DOM snapshot at the moment of failure usually shows what the element became.

**Ask your agent.** `get_locator_healing` over the [MCP server](/features/mcp) returns the recommended fix and
the full alternatives list for a failing case, so a coding agent can apply it without you opening the
dashboard. This one does still depend on captured snapshots — it reads the same data the panel does.

## Related
- [Capture fixtures](/guide/capture-fixtures) — everything else the fixtures unlock
- [Locator healing](/features/locator-healing): how the replacements are ranked, and the pause-on-failure options
- [Browser extension](/features/extension) — picking and recording locators against a live page
