---
title: Capture fixtures
description: "The optional fixtures file that records network timing, Web Vitals, console output, ARIA snapshots and locator snapshots from inside your tests."
lang: en-US
---

# Capture fixtures

The [reporter](./reporter) uploads complete test results (statuses, errors, traces, HTML reports) without any change to your test code. The **capture fixtures** are an optional, one-file addition that observes your tests from the inside and unlocks the dashboard's richest features: slow-endpoint analysis, Web Vitals, console capture, failure-time ARIA snapshots, and [locator healing](/features/locator-healing).

## Setup

**Option A — extend your existing fixtures:**

<<< @/snippets/fixtures.ts{ts}

**Option B — one-line extend with `extendPiwiFixtures`:**

```typescript
// tests/fixtures.ts
import { test as base } from '@playwright/test'
import { extendPiwiFixtures } from '@piwitests/reporter'

export const test = extendPiwiFixtures(base)
export { expect } from '@playwright/test'
```

Then import `test` from your fixtures file **in every spec**. A spec importing `test` from `@playwright/test` still runs and reports, uncaptured:

```typescript
import { test, expect } from './fixtures'

test('homepage loads', async ({ page }) => {
  await page.goto('/')
  // network, console, Web Vitals, and locator data are captured automatically
})
```

That's the entire setup: nothing to start, wrap, or await inside your tests.

## What gets captured

| Data | Captured | Powers |
|------|----------|--------|
| **Network requests**: method, URL, status, duration, start time, content type, for fetch, XHR, document and `other` traffic only (static assets are skipped); one that failed without a response keeps the browser's error (`net::ERR_CONNECTION_RESET`) | per request | [Slow endpoints](/features/slow-tests); [backend log correlation](./backend-logs) via the `X-Piwi-Logs` response header; the [failure timeline](/features/evidence#one-execution-diagnosis-first) |
| **Console entries**: `warning`, `error` and `assert` messages with source location and a timestamp (not `console.log`) | as they happen | The console card and the failure timeline on the [execution page](/features/evidence#one-execution-diagnosis-first); [AI diagnosis](/features/ai-diagnosis) evidence |
| **Web Vitals**: TTFB, DOM Interactive, DOMContentLoaded, Load Complete, First Paint, First Contentful Paint, plus LCP, CLS and INP (Chromium-only) | at test teardown | Web vitals card with color-coded thresholds; [performance trends](/features/slow-tests) |
| **ARIA snapshot** of the final page state: the YAML dump, plus the JSON aria tree on Playwright 1.63 or later | on failure | Failure evidence on the [execution](/features/evidence#one-execution-diagnosis-first) and cluster pages; [AI diagnosis](/features/ai-diagnosis) context; the JSON tree feeds [locator healing](/features/locator-healing)'s rename matching and the page diff |
| **Failure-page screenshot**: a PNG of the page the test last acted on, taken when Playwright's `screenshot` option keeps failure screenshots (`'off'` takes none) | on failure | The screenshot at the failing step on the [execution page](/features/evidence#one-execution-diagnosis-first), the first one [AI diagnosis](/features/ai-diagnosis) receives, and the one the MCP `get_case_screenshots` tool flags `atFailure` |
| **Browser dialogs**: an `alert`/`confirm`/`prompt`/`beforeunload` dialog's type, message and close time, through Playwright 1.63's `dialogclosed` event | as each dialog closes | A *dialogs* lane on the [failure timeline](/features/evidence#one-execution-diagnosis-first) and a *a dialog was open when the action failed* [clue](/features/evidence#clues) |
| **Locator snapshots**: element attributes, stable-ancestor anchors, same-role position and ranked alternative locators for each element a test proves resolvable, stamped with the call site | after each successful action and each passing web-first assertion (`toBeVisible()`, `toHaveText()`, …) | [Locator healing](/features/locator-healing); when a failing name-based locator (`getByRole`, `getByText`, `getByLabel`, …) matches nothing, a fresh suggestion is attached to the test as a Playwright annotation |
| **Locator pages**: the [page key](/guide/concepts#page-key) each locator call ran on, never a query or raw id | at each locator action and assertion | [Locator pages](/features/locator-usage#pages); **This page** in [Tested elements](/features/tested-elements) |
| **Code reach** (opt-in): executed files | teardown | [Code reach](/features/code-reach) |

::: tip Test source is captured without any fixture
On a failure the reporter also reads the **call stack's in-project source**: the line that threw plus the helpers and page objects above it, as line-numbered snippets. It needs no fixture, and renders as the **Test source** call stack on the [execution](/features/evidence#one-execution-diagnosis-first) and cluster pages.
:::

## With and without the fixtures

Nothing breaks without the fixtures. This is what you give up:

| Dashboard feature | Reporter only | Reporter + fixtures |
|-------------------|:-:|:-:|
| Run history, statuses, errors, traces, HTML reports | ✅ | ✅ |
| Live streaming, sharding, CI/SCM metadata | ✅ | ✅ |
| Failure clustering & flaky-test analytics | ✅ | ✅ |
| AI failure diagnosis | ✅ error + code-diff grounding | ✅ richer evidence: ARIA snapshot, console, network |
| Slow API endpoints table | — | ✅ |
| Web Vitals & performance trends | — | ✅ |
| Console warnings/errors card | — | ✅ |
| Failure-time ARIA snapshot + locator suggestion | — | ✅ |
| Dialogs lane on the failure timeline (Playwright 1.63+) | — | ✅ |
| Locator healing (ranked alternatives panel) | — | ✅ |
| The page each locator was used on | — | ✅ |
| Backend log correlation | — | ✅ with a [backend integration](./backend-logs) |

## Where capture works

The fixtures wire capture at the **browser** level, so it works however your tests create pages:

- the standard `page` fixture,
- `browser.newPage()` and `browser.newContext().newPage()` — including inside your own custom fixtures,
- popups (`window.open`) and pages a context opens on its own.

Semantics worth knowing:

- **`beforeAll` / `afterAll` activity is not captured**: only a test's own activity is attributed to it.
- **Multi-page tests** attribute Web Vitals, the failure ARIA snapshot and the failure-page screenshot to the most recently active page.
- **Repeated call sites** (actions in a loop, a page-object method called several times) probe the element once per call site per test. If a probe fails, the next run of that line tries again.
- **Assertion capture is positive-presence only** — negated (`.not.…`), absence (`toBeHidden`), multi-element (`toHaveCount`) and page-level (`toHaveURL`) assertions never probe.

## Composing with your own fixtures

`piwiFixtures` is a plain Playwright fixtures object, so it composes with your own fixtures in any order:

```typescript
import { test as base, mergeTests } from '@playwright/test'
import { piwiFixtures, extendPiwiFixtures } from '@piwitests/reporter'

// Your fixtures first, capture second
export const test = base.extend<MyFixtures>({ /* ... */ }).extend(piwiFixtures)

// Capture first, your fixtures second
export const test = extendPiwiFixtures(base).extend<MyFixtures>({ /* ... */ })

// Or merge two independent test objects
export const test = mergeTests(myTest, extendPiwiFixtures(base))
```

Two rules:

- The fixture names **`piwiCapture`** and **`piwiResources`** (the [resource ledger](/features/resource-leaks)) are reserved: a fixture of your own with either name replaces Piwi's.
- If you **override `browser` or `page` yourself**, extend with `piwiFixtures` *after* your override so the capture wrapping still applies.

## Cost & opt-outs

Capture is designed to never fail or noticeably slow down a test:

- Per call site: one DOM read, and a bounded ARIA snapshot (500 ms deadline) only when the element's attributes don't
  already settle its accessible name.
- At teardown: draining in-flight captures is capped at 2 seconds.
- A capture that can't complete (mid-navigation, detached element) is dropped silently; it never throws into your test.
- Capture adds no steps to the report or trace, and errors, step locations and stacks name your own call.

`collectPerformanceMetrics: false` discards all fixture data; `captureLocators: false` turns off only the locator
snapshots and pages, and `capturePageState: false` only the test-end app state (URL, storage key names, cookie flags, never
values). Two opt-in aids for headed local runs, `inspectOnFailure` and `pickLocatorOnFailure`, open
[the failing page for inspection](/features/locator-healing#inspect-the-failing-page-live-local-runs) or
[let you pick a replacement locator](/features/locator-healing#pick-a-replacement-locator-on-the-failing-page-local-runs);
a third, `PIWI_PAUSE_AT` (semicolon-separated `file:line`: `tests/login.spec.ts:42;tests/pages/checkout.page.ts:9`),
is set by an editor on a run it starts, to [pause at its breakpoints](/features/editor-breakpoints).
Set all but `collectPerformanceMetrics` through [`wrapConfig`](./reporter#installing-via-wrapconfig) or their `PIWI_*`
variable: the test workers never see a plain reporter entry's options.

## Green page sampling on pass

To power the [page diff](/features/evidence#page-diff), the fixtures also sample the ARIA snapshot at the end of a *passing* test, a "last known good" of the page to diff a later failure against. The server decides what to capture:

- At the start of every run the global setup makes **one extra request** for the tests whose newest green snapshot is older than 24 hours (or missing), and the reporter caches that set for the run's workers.
- A passing test is sampled only when it is in that set, so in steady state nothing is captured.
- The server keeps at most one green snapshot per test per day.

If that request fails, the set stays empty and **nothing is sampled**. Turn it off with `sampleAriaOnPass: false` (or `PIWI_SAMPLE_ARIA_ON_PASS=false`). With the fixtures off, no snapshot is taken regardless.

## Troubleshooting

- **Data missing for some specs only** — those specs import `test` from `@playwright/test` instead of your fixtures file.
- **No fixture data at all**: check that `collectPerformanceMetrics` is not `false`, and that tests leave `about:blank`.
- **ARIA snapshot or locator healing missing**: the same causes, or `captureLocators` is off.
- **An evidence card says "not captured"**: that project has never had the fixtures active; the in-app `/setup` checklist, which each empty card links, says what to switch on. A card that reads *nothing happened* means the fixtures ran and this execution produced nothing. With an uploaded trace, the console, network and ARIA cards are recovered from it and marked *derived from the trace*.

## Try it

A runnable example project exercising every capture path, a failing test included, lives in [`examples/playwright-fixtures`](https://github.com/PiwiTests/platform/tree/main/examples/playwright-fixtures).

## Related

- [Reporter](./reporter): the setup the fixtures build on
- [Reporter options](/reference/reporter-options#what-gets-captured): every capture option
- [Core concepts](./concepts#locator-snapshot): what a locator snapshot stores, and what it doesn't
- [Locator healing](/features/locator-healing): the feature the locator snapshots power
