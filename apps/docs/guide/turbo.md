---
title: Faster Playwright runs
description: "Make a Playwright suite faster without forking Playwright: pick a preset, sign in once, block third-party requests, and measure each change."
lang: en-US
---

# Faster test runs

`@piwitests/turbo` applies the changes that make a Playwright suite faster to your config, and comes with a
benchmark to check them on your own suite. It does not fork Playwright: you keep `@playwright/test`, its browsers and
its upgrades. It needs nothing from a Piwi server and works with or without the [reporter](./reporter). Its
[`piwi-turbo` command](./piwi-turbo) also shortens the start of each run.

## Install

```sh
npm install --save-dev @piwitests/turbo
```

Wrap your config with `withOptimizations`, pick a preset, and add your sign-in and the third-party URLs to block:

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';
import { withOptimizations } from '@piwitests/turbo';

export default withOptimizations(
  defineConfig({
    testDir: './tests',
    fullyParallel: true,
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  }),
  {
    preset: 'fast',
    signIn: { storageState: '.auth/user.json' },
    blockRequests: ['https://www.googletagmanager.com/**'],
  },
);
```

Then take `test` from `@piwitests/turbo/test`, in your tests or as the base of your own fixtures file.

```ts
import { test, expect } from '@piwitests/turbo/test';
```

With Piwi's reporter, wrap the config `wrapConfig` returns, so a preset sees the trace and screenshot settings it
fills in, and extend turbo's `test` with the [capture fixtures](./capture-fixtures):

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { wrapConfig } from '@piwitests/reporter';
import { withOptimizations } from '@piwitests/turbo';

export default withOptimizations(wrapConfig(defineConfig({ testDir: './tests' })), { preset: 'fast' });
```

```ts
// fixtures.ts
import { extendPiwiFixtures } from '@piwitests/reporter';
import { test as base, expect } from '@piwitests/turbo/test';

export const test = extendPiwiFixtures(base);
export { expect };
```

`failureScreenshots`, in every preset, turns Playwright's `screenshot` option off for the tests on turbo's `test`, and
the capture fixtures over it follow it: the run keeps screenshots of a failed test's pages, but not Piwi's screenshot of
the page it last acted on. Name `failureScreenshots: false` to keep that one.

## Presets

| Preset | Turns on |
|---|---|
| `safe` | Nothing a test observes changes: traces the config records are kept for failures (on the first retry when it retries), screenshots are taken of failed tests only, video on the first retry. Node's compile cache shortens the start of each test worker. |
| `fast` | `safe`, plus reduced motion and instant animations, which change what the page does, and one browser context per worker, reset between tests. |
| `max` | `fast`, plus the [experimental hooks](#experimental-hooks) but `keepStaticCache`. |

A preset only lowers costs your config has: it never turns on traces, screenshots or video the config leaves off. An
option you name beside the preset wins over it. On the package's reference suite, against a typical unoptimized setup,
`safe` took 4% off a run's wall time and 7% off its CPU time, and `fast` 6% and 53%. On a CI shard of Piwi's own
suite, `fast` took 10% off the wall time and the CPU time, and raised peak memory by 36%; `max` measured the same
there. Its hooks pay on suites dense in short calls: on a suite whose time is the app's, start from `fast`.

## Sign-in and third-party requests

These need your paths and URLs, so no preset sets them.

- `signIn: { storageState }` adds a `setup` project that runs your `*.setup.ts` files, which sign in and save the
  state to `storageState`; every other project loads it. Tests that change server-side state still need their own account or data, and the
  state file stays out of Git.
- `blockRequests` aborts the requests that match a glob, a regular expression or a predicate, typically third-party
  scripts that hold the `load` event. Routes a test adds with `page.route` run first; never block a script the app
  needs. Like any route, it turns off Chromium's HTTP cache for the context.

On the reference suite, these two took a run from 81 s to 48 s each. With reduced motion, retained traces and four
workers, they took it to 16 s.

## Context reuse

`fast` keeps one browser context per worker and resets it between tests, instead of creating a context for each test:
Playwright's own `reuseContext`, plus turbo's reset of offline mode, extra HTTP headers, permissions, geolocation, HTTP
credentials, the CDP sessions a test opened and, on Chromium, Cache Storage, which Playwright's reset leaves behind. The
browser keeps the HTTP credentials it sent to an origin for the context's life. The package's tests check each kind of
state a test can leave. Each worker keeps one page, and so one renderer, for the whole run: on Piwi's own suite each
grew to about 1.6 GB. It needs video off, and `reuseContext: false` turns it off. On Flashwright's benchmark suites it
took 15% and 4% off two app suites, changed nothing on one of very large pages, and added 4% to a suite of trivial
tests, where Playwright's reset of a context takes longer than a new context: turn it off for such a suite. On a suite
whose time is mostly waiting on its API it changes little.

## Advanced: the levers one by one

Every preset is a set of these options; name one to override it.

| Option | Effect |
|---|---|
| `trace` | The trace mode, such as `retain-on-failure`, or `on-first-retry` when CI retries. |
| `lightTraces` | Keeps each action's DOM snapshot and leaves out the ARIA and screenshot snapshots and the screencast; `'actions'` leaves out the DOM snapshots too. |
| `failureScreenshots` | Screenshots a test's pages, and those of contexts it opened, only when it fails. With `only-on-failure`, Playwright captures every test and keeps the failed ones. A spec on `@playwright/test`'s `test` keeps Playwright's capture. |
| `videoOnRetry` | With retries, records video on the first retry instead of `retain-on-failure`, which records every test. |
| `reducedMotion` | Emulates `prefers-reduced-motion: reduce`. Leave it off for tests of animations. |
| `instantAnimations` | Chromium runs CSS and Web Animations 1000 times faster, whether or not the app honors reduced motion. |
| `reuseContext` | One browser context per worker, reset between tests. |
| `compileCache` | Node's compile cache for the test workers, in `node_modules/.cache/piwi-turbo-compile` (the temporary folder without `node_modules`) or the folder given. The runner loads Playwright before the config: [`piwi-turbo`](./piwi-turbo) caches its start too. Skipped when coverage is collected or a compile cache is already set. |

`lightTraces` cut the CPU time of a suite that traces every test by 46%, and its artifacts by 97%. A faster suite can
surface races that slower runs hid: measure on your own suite before keeping any of these.

## Experimental hooks

**Experimental.** Eleven options reach into Playwright's internals inside each test worker. `max` turns on all but
`keepStaticCache`; name them under `experimental` to pick some. The [package
README](https://github.com/PiwiTests/piwi/tree/main/packages/turbo#experimental-hooks) describes each one and its limits:

- `fastScreenshots` (Chromium) encodes PNG screenshots for speed, and `screenshotMatches` passes a screenshot
  assertion whose capture is known to match without decoding the images.
- `retryIntervals` shortens the waits of Playwright's retry loop, and `skipStabilityWait` stops pointer actions waiting
  for the element to keep still: keep it off for apps that ignore input while animating.
- `fastActions` cuts the round trips an action makes with the browser: one to find its element in place of three, and
  on Chromium the click point asked for with the scroll.
- `failFast` ends a failing assertion once nothing can change the page; keep it off for a test changing the page
  from its Node code while an assertion waits.
- `fastReset` and `keepStaticCache` lighten the reset of a reused context: storage cleared through CDP, the tab's
  second reset skipped when the test changed nothing it resets, and on Chromium the HTTP cache kept while it holds only
  static assets. Keep `keepStaticCache` off for an app that changes a file at the same URL between tests with no
  lifetime of its own, or fetches a cacheable response as a page unloads.
- `earlyInjection` (Chromium) creates the script Playwright's actions run through while each page loads, rather than
  at its first action, and `fastTraces` makes traces cheaper: no request for the script bodies they leave out, and on
  Chromium fewer waits for DOM snapshots.
- `fastStackTraces` skips source map lookups for Node and `node_modules` frames and, with other hooks, the stacks
  the server captures for each evaluation, call and command.

```ts
withOptimizations(config, {
  experimental: {
    fastScreenshots: true,
    retryIntervals: [10, 20, 40, 50],
    failFast: true,
    skipStabilityWait: true,
    fastReset: true,
    fastStackTraces: true,
    screenshotMatches: true,
    keepStaticCache: true,
    earlyInjection: true,
    fastTraces: true,
    fastActions: true,
  },
});
```

They run only on the Playwright versions they were tested with, and throw instead of falling back: on another version,
on an internal they do not recognize, or when the browser runs outside the worker. `PIWI_TURBO_ALLOW_UNTESTED=1` runs
them on another version, at your own risk. What each hook was measured to save is in the package's [decision
record](https://github.com/PiwiTests/piwi/blob/main/adr/turbo.md). Several levers follow techniques from
[Flashwright](https://github.com/xcodebeast/flashwright), a fork of Playwright; `@piwitests/turbo` applies them to stock
Playwright instead.

## Measure on your suite

The benchmark in the repository runs whole commands of a suite, interleaves the configurations in rotating rounds and
compares each with a baseline round by round. It reports wall time, CPU time of every process (Chromium included),
peak memory, artifact size, failures, and where the test time went. Its
[README](https://github.com/PiwiTests/piwi/tree/main/packages/turbo/bench) shows how to point it at your own suite.

## Related
- [The piwi-turbo command](./piwi-turbo) — a shorter start for each run
- [Our suite takes too long: where is the time going?](/recipes/faster-suite) — find the time before cutting it
- [CI & sharding](./ci) — the parallelism you already have
- [Capture fixtures](./capture-fixtures) — the fixtures that extend `@piwitests/turbo/test`
- [License](./license) — `@piwitests/turbo` is MIT
