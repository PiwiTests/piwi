---
title: Faster Playwright runs
description: "Make a Playwright suite faster without forking Playwright: pick a preset, sign in once, block third-party requests, and measure each change."
lang: en-US
---

# Faster test runs

`@piwitests/turbo` applies the changes that make a Playwright suite faster to your config, and comes with a
benchmark to check them on your own suite. It does not fork Playwright: you keep `@playwright/test`, its browsers and
its upgrades. It needs nothing from a Piwi server and works with or without the [reporter](./reporter).

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

Then take `test` from `@piwitests/turbo/test`, in your tests or as the base of your own fixtures file. With the
[capture fixtures](./capture-fixtures), extend it: `extendPiwiFixtures(test)`.

```ts
import { test, expect } from '@piwitests/turbo/test';
```

## Presets

| Preset | Turns on |
|---|---|
| `safe` | Nothing a test observes changes: traces the config records are kept for failures (on the first retry when it retries), screenshots are taken of failed tests only, video on the first retry. Node's compile cache shortens the start of each test worker. |
| `fast` | `safe`, plus reduced motion and instant animations, which change what the page does, and one browser context per worker, reset between tests. |
| `max` | `fast`, plus the [experimental hooks](#experimental-hooks). |

A preset only lowers costs your config has: it never turns on traces, screenshots or video the config leaves off.
An option you name beside the preset wins over it. On the package's reference suite, against a typical unoptimized
setup, `safe` took 5% off a run's wall time and 19% off its CPU time, and `fast` 8% and 50%.

## Sign-in and third-party requests

These need your paths and URLs, so no preset sets them.

- `signIn: { storageState }` adds a `setup` project that runs your `*.setup.ts` files and saves the signed-in state;
  every other project loads it. Tests that change server-side state still need their own account or data, and the
  state file stays out of Git.
- `blockRequests` aborts the requests that match a glob, a regular expression or a predicate, typically third-party
  scripts that hold the `load` event. Routes a test adds with `page.route` run first; never block a script the app
  needs.

On the reference suite, these two took a run from 81 s to 48 s each. All the public levers together, with four
workers, took it to 16 s.

## Context reuse

`fast` keeps one browser context per worker and resets it between tests, instead of creating a context for each test:
Playwright's own `reuseContext`, plus turbo's reset of offline mode, extra HTTP headers, permissions, geolocation and,
on Chromium, Cache Storage, which Playwright's reset leaves behind. The package's tests check each kind of state a
test can leave. It needs video off, and `reuseContext: false` turns it off. On Flashwright's benchmark suites it took
5–25% off the app suites; on a suite whose time is mostly waiting on its API it changes little.

## Advanced: the levers one by one

Every preset is a set of these options; name one to override it.

| Option | Effect |
|---|---|
| `trace` | The trace mode, such as `retain-on-failure`, or `on-first-retry` when CI retries. |
| `lightTraces` | Keeps each action's DOM snapshot and leaves out the ARIA and screenshot snapshots and the screencast; `'actions'` leaves out the DOM snapshots too. |
| `failureScreenshots` | Screenshots a test's pages only when it fails. With `only-on-failure`, Playwright captures every test and keeps the failed ones. |
| `videoOnRetry` | With retries, records video on the first retry instead of `retain-on-failure`, which records every test. |
| `reducedMotion` | Emulates `prefers-reduced-motion: reduce`. Leave it off for tests of animations. |
| `instantAnimations` | Chromium runs CSS and Web Animations 1000 times faster, whether or not the app honors reduced motion. |
| `reuseContext` | One browser context per worker, reset between tests. |
| `compileCache` | Node's compile cache for the test workers, in `node_modules/.cache/piwi-turbo-compile` or the folder given. The runner loads Playwright before the config: set `NODE_COMPILE_CACHE` in the environment to cache its start too. Skipped when coverage is collected or a compile cache is already set. |

`lightTraces` halved the CPU time of a suite that traces every test. On Piwi's own suite, one CI shard of 242 tests,
`trace: 'on-first-retry'` and `reducedMotion` took 13% off the wall time and 28% off the CPU time, and
`failureScreenshots` another 5% of each. A faster suite can surface races that slower runs hid: measure on your own
suite before keeping any of these.

## Experimental hooks

**Experimental.** Six options reach into Playwright's internals inside each test worker. `max` turns them all on;
name them under `experimental` to pick some.

- `fastScreenshots` (Chromium): encodes PNG screenshots for speed. The pixels are the same and the files larger. Runs
  that write snapshots keep the stock encoding.
- `retryIntervals`: the waits between the checks of Playwright's retry loop. Stock is `[20, 50, 100, 100, 500]` ms.
- `failFast`: a failing assertion ends once nothing can change the page before its timeout. It shortens red runs on
  pages that go idle, does nothing on a page that polls, and must stay off for a test that changes the page from its
  own Node code while an assertion waits.
- `skipStabilityWait`: clicks, hovers, taps and drags stop waiting for the element to keep still. The visible, enabled
  and hit-target checks stay. Leave it off for apps that ignore input while they animate.
- `fastReset` (Chromium, with context reuse): between tests, the storage of the origins the test visited is cleared
  from the frames still on them and through CDP, where Playwright's reset loads each origin again. After a test that
  left an origin it visited, Playwright's reset runs as it is.
- `fastStackTraces`: Playwright captures a stack for every API call, and looks up a source map for each of its
  frames. The frames of Node and of `node_modules`, which have none, skip the lookup; stack traces read the same.

```ts
withOptimizations(config, {
  experimental: {
    fastScreenshots: true,
    retryIntervals: [10, 20, 40, 50],
    failFast: true,
    skipStabilityWait: true,
    fastReset: true,
    fastStackTraces: true,
  },
});
```

They run only on the Playwright versions they were tested with, and throw instead of falling back: on another
version, on an internal they do not recognize, or when the browser runs outside the worker. The package's
[README](https://github.com/PiwiTests/piwi/tree/main/packages/turbo#experimental-hooks) explains how to test a new
Playwright version. Several levers follow techniques from [Flashwright](https://github.com/xcodebeast/flashwright), a
fork of Playwright; `@piwitests/turbo` applies them to stock Playwright instead.

## Measure on your suite

The benchmark in the repository runs whole commands of a suite, interleaves the configurations in rotating rounds and
compares each with a baseline round by round. It reports wall time, CPU time of every process (Chromium included),
peak memory, artifact size, failures, and where the test time went. Its
[README](https://github.com/PiwiTests/piwi/tree/main/packages/turbo/bench) shows how to point it at your own suite.

## Related
- [Our suite takes too long: where is the time going?](/recipes/faster-suite) — find the time before cutting it
- [CI & sharding](./ci) — the parallelism you already have
- [Capture fixtures](./capture-fixtures) — the fixtures that extend `@piwitests/turbo/test`
- [License](./license) — `@piwitests/turbo` is MIT
