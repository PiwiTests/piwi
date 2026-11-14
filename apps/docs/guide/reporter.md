---
title: Reporter
description: "Install and configure @piwitests/reporter: wrapConfig, options, live streaming, global setup, multiple reports, authentication and troubleshooting."
lang: en-US
---

# Reporter

The `@piwitests/reporter` package is a Playwright reporter that uploads test results, traces, attachments and reports
to the dashboard while your tests run. [Getting started](./getting-started#fast-path-one-command) sets it up with one
command, `npx @piwitests/reporter init`; this page covers manual setup.

## Installation

```bash
npm install --save-dev @piwitests/reporter
```

It needs `@playwright/test` 1.59 or later and Node.js 20 or later. A feature needing a later Playwright names the
version on its page.

### Try it without editing your config

Playwright's `--add-reporter` (1.63 or later; older versions refuse it) appends this reporter to your config's reporters (unlike `--reporter`, which replaces them), so one run can go to a dashboard without a config edit. Most reporter options have a `PIWI_*` [environment variable](/reference/reporter-options):

::: code-group

```bash [Linux / macOS]
PIWI_DASHBOARD_URL=http://localhost:3000 PIWI_API_KEY=your-api-key PIWI_PROJECT_NAME=my-project npx playwright test --add-reporter @piwitests/reporter
```

```powershell [Windows (PowerShell)]
$env:PIWI_DASHBOARD_URL='http://localhost:3000'; $env:PIWI_API_KEY='your-api-key'; $env:PIWI_PROJECT_NAME='my-project'; npx playwright test --add-reporter @piwitests/reporter
```

:::

This is a trial path: you get results and your configured traces and screenshots, not the [capture fixtures](#capture-fixtures) or [`wrapConfig`](#installing-via-wrapconfig)'s capture defaults. [`piwi run`](/reference/cli#select-run) appends it the same way when the config has no Piwi reporter.

## Installing via wrapConfig

`wrapConfig` wraps your whole config in one call: it injects the reporter, chains Piwi's [global setup](#global-setup-phase), and defaults the failure-evidence capture options. It is the recommended setup, written by `npx @piwitests/reporter init` and the dashboard's **Connect a suite** page.

```typescript
import { defineConfig } from '@playwright/test'
import { wrapConfig } from '@piwitests/reporter'

export default wrapConfig(
  defineConfig({
    testDir: './tests',
    // no `screenshot` / `trace` needed: wrapConfig fills them in
  }),
  {
    serverUrl: process.env.PIWI_DASHBOARD_URL || 'http://localhost:3000',
    projectName: 'my-project',
  },
)
```

The first argument is your Playwright config; the second is the [Piwi options](#configuration-options). An option in
the config wins over its `PIWI_*` variable, so the server URL reads `PIWI_DASHBOARD_URL` first, as `init` writes it: a
CI job that sets the variable reports there. `wrapConfig` also:

- Sets `screenshot: 'only-on-failure'` and `trace: 'retain-on-failure'` on the **top-level** `use` block when unset (a value you set, `'off'` included, and per-project `use` blocks are kept). They unlock the DOM snapshot, full call stack, full network with bodies and the visual diff **without** the capture fixtures. The trace records no ARIA snapshots, which slow each action on a large page: [`defaultCapture`](/reference/reporter-options#defaultcapture) gives their cost and how to record them. Opt out with `defaultCapture: false` (or `PIWI_DEFAULT_CAPTURE=false`); the reporter logs one line at the start of the run naming what it defaulted.
- Forwards `failOnFlakyTests` into Playwright's native config so a flaky-only run exits non-zero locally.
- Forwards the `PIWI_*` variables into the global setup process, so registering the run uses the reporter's server and credentials.

## Basic configuration

When a config cannot be wrapped, add the reporter entry and the capture options `wrapConfig` would set:

```typescript
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [
    ['list'],
    ['@piwitests/reporter', {
      serverUrl: process.env.PIWI_DASHBOARD_URL || 'http://localhost:3000',
      projectName: 'my-project',
    }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure', // optional: wrapConfig does not set it
  },
})
```

The `use` block is Playwright's: the reporter uploads what Playwright records and what a test attaches with `testInfo.attach()`. Videos can be large: pair `retain-on-failure` with [storage cleanup](/operate/storage#storage-management).

::: tip You don't also need Playwright's `html` reporter
The dashboard is complete without it: running it alongside only repeats end-of-run work (and opens a browser on a local failure). Keep it for the standalone report, which Piwi uploads (`uploadReport`).
:::

<a id="performance-metrics-web-vitals"></a>

## Capture fixtures

The reporter works without test-code changes. The **capture fixtures** add network timing, Web Vitals, console
capture, failure-time ARIA snapshots and the locator snapshots behind [locator healing](/features/locator-healing):
[Capture fixtures](./capture-fixtures) covers setup, what each records and its cost.

## Configuration options

Options go in the reporter's entry in `playwright.config.ts` or `wrapConfig`'s second argument. Most can also be
set with a `PIWI_*` environment variable, which an option in the config overrides, except `PIWI_DESKTOP_APP` and,
outside `wrapConfig`, `PIWI_VERBOSE`, which override the option. `PIWI_DASHBOARD_URL`,
`PIWI_API_KEY` and `PIWI_PROJECT_NAME` also come from the config folder's
[`.env`](/reference/reporter-options#values-from-env), below the environment. [Reporter options](/reference/reporter-options)
lists every option with its default and variable, and [Test metadata](/reference/test-metadata) what the reporter
records on its own, [errors outside the tests](/reference/test-metadata#errors-outside-the-tests),
[what each test printed](/reference/test-metadata#test-output) and [hooks](/reference/test-metadata#hooks) included.

### Finding the desktop app automatically

If nothing sets a server (no URL or API key in the config, the environment or that `.env`), the reporter
uploads to the [desktop app](/features/desktop) on the same machine, which publishes its loopback URL and access token
to `~/.piwi/desktop.json` (`%USERPROFILE%\.piwi\desktop.json` on Windows) while it runs. `PIWI_DESKTOP_CONFIG`
overrides the path. A CI job or a project pointed elsewhere is never redirected unless it opts in below.

The token goes only to a server that proves it holds it: before each request that carries it, the reporter
sends a one-time challenge to `/api/health` and checks the answer's proof. With no proof, or the wrong one, no
token is sent, nothing is uploaded and the reporter says so; an app before 0.56 gives none: update it.
A run the app starts itself (a reproduction or flake lab) exports `PIWI_DESKTOP_KEY=1` beside `PIWI_API_KEY`, marking
the key as the app's, as does a `PIWI_API_KEY` equal to the token in `desktop.json`, while that file exists, also after a crash (the app
deletes it on a clean quit). Any other key is sent as before.

### Local runs to the desktop app, CI to a team server

With `desktopApp: 'prefer'`, a run not on CI lands in the desktop app whenever it is running, even with `serverUrl`
set, so local runs stay out of a shared dashboard; CI runs, and local runs with the app closed, go to `serverUrl` with
its credentials. URL and token always move together. A run is on CI when a CI provider's variable is set, or `CI` is
anything but `false` or `0`. `'off'` never uses the app. `PIWI_DESKTOP_APP`
overrides the option: `off` sends one local run to `serverUrl`. `init --desktop-app prefer` writes it.

[Run on my machine](/features/run-on-my-machine#what-leaves-your-machine) runs report to the instance that asked.

## Sharding

Playwright's `--shard` jobs merge into one dashboard run when every shard uses the same
`projectName`. `runLabel` is the manual override when your CI isn't detected. See
[CI & sharding](./ci#sharding).

## Live streaming

The reporter streams results as tests complete: the run appears when the suite starts, each test's trace and
attachments upload when it finishes (`liveFileUploads`), and the run's page shows each running test's step. A
test's final failed attempt prints its headline and a link right away; at the end the reporter prints `View run: <url>`
(see [CI → Getting the run URL back out](./ci#getting-the-run-url-back-out-of-ci)). A server without streaming support
gets the batch upload instead. `streamingBatchSize` and `streamingBatchDelay` set how often results are sent.

### Disabling streaming

`streaming: false` sends all results at the end of the run, then each test's files and each report in their own request.

## Global setup phase

A run appears on the dashboard when the first test starts. If your config has a `globalSetup` step
(seeding, authenticating, building), register the run before it so the dashboard shows an **initializing** state during
setup. `wrapConfig` does this for you; otherwise export `createGlobalSetup` from the `globalSetup` file
(`globalSetup: './global-setup.ts'`); it reads its options from the reporter entry:

```typescript
// global-setup.ts
import { createGlobalSetup } from '@piwitests/reporter'

export default createGlobalSetup({}, async (config) => {
  // your own setup, run after registration
})
```

Registration is best-effort: with the server unreachable, the run is created when tests begin. Playwright's UI mode
(`--ui`) skips registration, since it swaps the reporter out, as does `streaming: false`, whose run the dashboard
receives in one batch at its end; your own setup still runs.

## Multiple reports

Each report attached to a run gets its own dashboard button.

```typescript
export default defineConfig({
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['monocart-reporter', { name: 'My Tests', outputFile: 'monocart-report/index.html' }],
    ['blob'],
    ['@piwitests/reporter', {
      serverUrl: process.env.PIWI_DASHBOARD_URL || 'http://localhost:3000',
      projectName: 'my-project',
      reports: [
        { type: 'html' },
        { type: 'monocart' },
        { type: 'blob', dir: 'blob-report', label: 'Blob archive' },
      ],
    }],
  ],
})
```

`html` (the html reporter's folder, `playwright-report/` by default) and `monocart` (`monocart-report/`) open in a new
tab; `blob` (`blob-report/`) downloads as an archive. Any other type is accepted, read from `dir` or else
`<type>-report/`. Reports upload compressed; one over the dashboard's upload limit
([`PIWI_IMPORT_MAX_BYTES`](/reference/configuration#ingest-limits), 500 MB by default) is left out alone.

## With authentication enabled

With authentication enabled, pass an **API key**: create one ([API keys](/operate/api-keys); **Connect a suite**
creates one in place); keep it in a CI secret (locally, `.env`), and pass it as `PIWI_API_KEY` or the `apiKey` option.

The key is sent as an `Authorization: Bearer` header. `username` (or the account's email) and `password`
(`PIWI_USERNAME`, `PIWI_PASSWORD`) work too, signing in once per run; prefer an API key in CI.

## Troubleshooting

**No traces or screenshots.** Playwright records neither by default. Set `trace` and `screenshot` in `use`, or install
through [`wrapConfig`](#installing-via-wrapconfig).

**No network, Web Vitals, console or locator data.** Every spec must import `test` from your fixtures file, not
`@playwright/test`, and `collectPerformanceMetrics` must not be `false`; see
[Capture fixtures → Troubleshooting](./capture-fixtures#troubleshooting).

**Connection errors.** Check that `serverUrl` answers from where the tests run; `PIWI_VERBOSE=true` logs every
request. A run the reporter could not deliver (dashboard down, no credential, a sign-in page answering in its place)
is saved locally, owner-only, and sent to the same `serverUrl` on the project's next run without traces or
attachments; it never fails the Playwright run. A stream that cannot start while the dashboard is down or busy retries
for the run's life, its events kept within
[`maxStreamBufferBytes`](/reference/reporter-options#maxstreambufferbytes); one starting late says how late. Live events the
dashboard refuses, or has not taken two and a half minutes after they first failed, leave the live view so the later
ones flow; if test results are among them, the run is sent again as a batch at its end.
[`submitTimeout`](/reference/reporter-options#submittimeout) (15 minutes by default) bounds that end-of-run work, so an
unresponsive dashboard cannot hold the CI job.

## Related

- [Reporter options](/reference/reporter-options): every option and its `PIWI_*` variable
- [Test metadata](/reference/test-metadata): what the reporter records on its own
- [Capture fixtures](./capture-fixtures): the evidence the fixtures add
- [CI & sharding](./ci): the reporter in a pipeline
