---
title: Faster Playwright runs
description: "Make a Playwright suite faster without forking Playwright: sign in once, block third-party requests, trim tracing, and measure each change."
lang: en-US
---

# Faster test runs

`@piwitests/turbo` applies the changes that make a Playwright suite faster to your config, and comes with a
benchmark to check each one on your own suite. It does not fork Playwright: you keep `@playwright/test`, its
browsers and its upgrades, and every test still gets its own fresh browser context. It needs nothing from a Piwi
server and works with or without the [reporter](./reporter).

## Install

```sh
npm install --save-dev @piwitests/turbo
```

Wrap your config with `withOptimizations` and name the changes you want. Every one is off unless named, and a
project's own settings win over it.

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
    signIn: { storageState: '.auth/user.json' },
    blockRequests: ['https://www.googletagmanager.com/**'],
    trace: 'retain-on-failure',
    reducedMotion: true,
  },
);
```

`blockRequests` and the experimental hooks below are fixtures: take `test` from `@piwitests/turbo/test`, in your
tests or as the base of your own fixtures file.

```ts
import { test, expect } from '@piwitests/turbo/test';
```

With the [capture fixtures](./capture-fixtures), extend that `test` instead of `@playwright/test`'s:
`extendPiwiFixtures(test)`.

## What each option does

| Option | Effect | Mind |
|---|---|---|
| `signIn` | Adds a `setup` project that runs your `*.setup.ts` files and saves the signed-in state; every other project loads it into each fresh context. | Tests that change server-side state still need their own account or data. Keep the state file out of Git. |
| `blockRequests` | Aborts the requests that match a glob, a regular expression or a predicate, typically third-party scripts that hold the `load` event. | Any route turns on request interception for the context. Never block a script the app needs. |
| `trace` | Sets the trace mode, such as `retain-on-failure`, or `on-first-retry` when CI retries. | `on-first-retry` records nothing without retries. |
| `reducedMotion` | Emulates `prefers-reduced-motion: reduce`. | It changes what an app that honors the preference does: leave it off for tests of animations. |

On the package's reference suite (43 tests against an app with a slow API, two third-party scripts and animations),
the four together with four workers took a run from 81 s to 16 s and its CPU time from 40 s to 18 s, for 36% more
peak memory, which the extra workers account for. Measure on your own suite before keeping any of them.

## Experimental hooks

**Experimental.** Two options reach into Playwright's internals inside each test worker:

- `fastScreenshots` (Chromium): encodes PNG screenshots for speed. The pixels are the same and the files larger. Runs
  that write snapshots keep the stock encoding.
- `retryIntervals`: the waits between the checks of Playwright's retry loop, which drive web-first assertions and
  actions. Stock is `[20, 50, 100, 100, 500]` ms.

```ts
withOptimizations(config, { experimental: { fastScreenshots: true, retryIntervals: [10, 20, 40, 50] } });
```

They run only on the Playwright versions they were tested with, and throw instead of falling back: on another
version, on an internal they do not recognize, or when the browser runs outside the worker. The package's
[README](https://github.com/PiwiTests/piwi/tree/main/packages/turbo#experimental-hooks) explains how they work and how
to test a new Playwright version. The techniques come from [Flashwright](https://github.com/xcodebeast/flashwright), a
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
