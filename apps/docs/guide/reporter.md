---
title: Reporter
description: "Install and configure @piwitests/reporter: wrapConfig, options, live streaming, global setup, multiple reports, authentication and troubleshooting."
lang: en-US
---

# Reporter

The `@piwitests/reporter` package is a Playwright reporter that uploads test results, traces, attachments and reports
to the dashboard while your tests run. [Getting started](./getting-started#fast-path-one-command) sets it up with one
command, `npx @piwitests/reporter init`; this page is the manual setup and the switches that matter.

## Installation

```bash
npm install --save-dev @piwitests/reporter
```

### Try it without editing your config

On **Playwright 1.63 or later**, `--add-reporter` appends this reporter to whatever your config already uses (unlike `--reporter`, which replaces them), so you can send one run to a dashboard with no config edit. Most reporter options have a `PIWI_*` [environment variable](/reference/reporter-options), so point it at your dashboard that way:

::: code-group

```bash [Linux / macOS]
PIWI_DASHBOARD_URL=http://localhost:3000 PIWI_API_KEY=your-api-key PIWI_PROJECT_NAME=my-project npx playwright test --add-reporter @piwitests/reporter
```

```powershell [Windows (PowerShell)]
$env:PIWI_DASHBOARD_URL='http://localhost:3000'; $env:PIWI_API_KEY='your-api-key'; $env:PIWI_PROJECT_NAME='my-project'; npx playwright test --add-reporter @piwitests/reporter
```

:::

This is a trial path: you get results and your configured traces and screenshots, but not the [capture fixtures](#capture-fixtures) or [`wrapConfig`](#installing-via-wrapconfig)'s capture defaults. On Playwright before 1.63 the flag does not exist; configure the reporter normally instead. [`piwi run`](/reference/cli#select-run) makes the same append automatically when the config has no Piwi reporter.

## Basic configuration

Add the reporter to your `playwright.config.ts`:

```typescript
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [
    ['list'],
    ['@piwitests/reporter', {
      serverUrl: 'http://localhost:3000',
      projectName: 'my-project',
    }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})
```

The `use` block is Playwright's, not Piwi's: `trace`, `screenshot` and `video` decide what Playwright records, and the reporter uploads whatever exists, including what a test attaches itself with `testInfo.attach()`. Leave `screenshot` at its default (`'off'`) and the failure evidence has no screenshot to show. Videos can be large, so pair `retain-on-failure` with [storage cleanup](/operate/storage#storage-management).

::: tip You don't also need Playwright's `html` reporter
The dashboard rebuilds the run from the data this reporter collects, so it is complete without Playwright's `html` reporter. Running `html` alongside only repeats end-of-run work (and, run locally, opens a browser on failure). If you still want Playwright's standalone report, keep it and Piwi uploads it with the run (`uploadReport`).
:::

## Installing via wrapConfig

`wrapConfig` wraps your whole Playwright config in one call: it injects the reporter, chains Piwi's [global setup](#global-setup-phase), and defaults the failure-evidence capture options. It is what `npx @piwitests/reporter init` writes for you.

```typescript
import { defineConfig } from '@playwright/test'
import { wrapConfig } from '@piwitests/reporter'

export default defineConfig(
  wrapConfig(
    {
      testDir: './tests',
      // no `screenshot` / `trace` needed: wrapConfig fills them in
    },
    { serverUrl: 'http://localhost:3000', projectName: 'my-project' },
  ),
)
```

The first argument is your Playwright config; the second is the [Piwi options](#configuration-options). On top of injecting the reporter, `wrapConfig`:

- Sets `screenshot: 'only-on-failure'` and `trace: 'retain-on-failure'` on the **top-level** `use` block when each is unset. A value you set yourself is kept, including `'off'`, and per-project `use` blocks are left alone. These two options unlock the DOM snapshot, full call stack, full network with bodies and the visual diff **without** the capture fixtures. On Playwright 1.63 or later `trace` becomes `{ mode: 'retain-on-failure', snapshots: { dom: true, aria: true } }`, adding the per-action aria tree for the [Screen tab and the page diff](/features/evidence#aria-and-screen-snapshots). The `screen` snapshot kind stays opt-in; see [what `screen` adds per action](/operate/storage#trace-snapshots). Opt out with `defaultCapture: false` (or `PIWI_DEFAULT_CAPTURE=false`); the reporter logs one line at the start of the run naming whatever it defaulted.
- Forwards the CI-gate option `failOnFlakyTests` into Playwright's native config so a flaky-only run exits non-zero locally.
- Forwards the `PIWI_*` variables into the global setup process, so registering the run uses the reporter's server and credentials.

<a id="performance-metrics-web-vitals"></a>

## Capture fixtures

The reporter works without test-code changes. The **capture fixtures** add network timing, Web Vitals, console
capture, failure-time ARIA snapshots and the locator snapshots behind [locator healing](/features/locator-healing):
[Capture fixtures](./capture-fixtures) covers the setup, what each fixture records and what it costs.

## Configuration options

Options go in the reporter's entry in `playwright.config.ts`, or in `wrapConfig`'s second argument. Most options can
also be set with a `PIWI_*` environment variable, which fills in an option you left unset: an option in the config
wins, except `PIWI_VERBOSE`, which overrides even an explicit `verbose` outside `wrapConfig`. [Reporter options](/reference/reporter-options)
lists every option with its default and its variable, and [Test metadata](/reference/test-metadata) what the reporter
records on its own.

### Finding the desktop app automatically

If nothing sets a server at all (no `serverUrl`, no `apiKey`, and neither `PIWI_DASHBOARD_URL` nor `PIWI_API_KEY` in
the environment), the reporter looks for a running [desktop app](/features/desktop) on the same machine and uploads
there. The app publishes its loopback URL and access token to `~/.piwi/desktop.json`
(`%USERPROFILE%\.piwi\desktop.json` on Windows) while it runs, and deletes the file on quit. This is the lowest
precedence step, so a CI job or a project pointed at a hosted dashboard is never redirected. Set `enabled: false` to
opt out; `PIWI_DESKTOP_CONFIG` overrides the path.

## Sharding

Playwright's `--shard` jobs are merged back into a single dashboard run automatically, as long as every shard uses the
same `projectName`. `runLabel` is the manual override when your CI isn't detected. See
[CI & sharding](./ci#sharding).

## Live streaming

By default, the reporter streams results as tests complete: the run appears when the suite starts, each test's trace and
attachments upload when it finishes (`liveFileUploads`), and while the run is open on the dashboard, its page shows the
step each running test is on. When a test's final attempt fails, the reporter prints its headline and a link right away;
at the end it prints `View run: <url>` (see [CI → Getting the run URL back out](./ci#getting-the-run-url-back-out-of-ci)).
A server that does not support streaming gets the batch upload instead.

### Disabling streaming

To send all results at the end of the run:

```typescript
['@piwitests/reporter', {
  serverUrl: 'http://localhost:3000',
  projectName: 'my-project',
  streaming: false,
}]
```

### Tuning batch parameters

Control how frequently results are sent during streaming:

```typescript
['@piwitests/reporter', {
  serverUrl: 'http://localhost:3000',
  projectName: 'my-project',
  streamingBatchSize: 10,     // send every 10 queued events (test begin/end and live steps)
  streamingBatchDelay: 5000,  // or every 5 seconds
}]
```

## Global setup phase

By default a run appears on the dashboard when the first test starts. If your config has a `globalSetup` step
(seeding a database, authenticating, building the app), register the run before it so the dashboard shows an
**initializing** state during setup. `wrapConfig` does this for you; otherwise export `createGlobalSetup` from the
file `globalSetup` points to; it reads its options from the reporter entry:

```typescript
// global-setup.ts
import { createGlobalSetup } from '@piwitests/reporter'

export default createGlobalSetup({}, async (config) => {
  // your own setup, run after registration
})
```

```typescript
// playwright.config.ts
export default defineConfig({
  globalSetup: './global-setup.ts',
  reporter: [['list'], ['@piwitests/reporter', { serverUrl: 'http://localhost:3000', projectName: 'my-project' }]],
})
```

Registration is best-effort: if the server is unreachable, the run is created when tests begin. Playwright's UI mode
(`--ui`) skips registration, since it swaps the reporter out; your own setup still runs.

## Multiple reports

Attach multiple report types to a single test run. Each report appears as a separate button in the dashboard UI.

```typescript
export default defineConfig({
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['monocart-reporter', { name: 'My Tests', outputFile: 'monocart-report/index.html' }],
    ['blob'],
    ['@piwitests/reporter', {
      serverUrl: 'http://localhost:3000',
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

`html` (`playwright-report/`) and `monocart` (`monocart-report/`) open in a new tab; `blob` (`blob-report/`) downloads
as an archive. Any other type is accepted too, read from `dir` or else `<type>-report/`.

## With authentication enabled

When the dashboard has authentication enabled, pass an **API key**: create one in the dashboard (see
[API keys](/operate/api-keys)), store it in a CI secret, and give it to the reporter as `apiKey` or
`PIWI_API_KEY`:

```typescript
['@piwitests/reporter', {
  serverUrl: 'https://piwi.example.com',
  projectName: 'my-project',
  apiKey: process.env.PIWI_API_KEY,
}]
```

The key is sent as an `Authorization: Bearer` header. `username` and `password` (`PIWI_USERNAME`, `PIWI_PASSWORD`)
work too (the reporter logs in once and reuses the session); prefer an API key in CI.

## Troubleshooting

**No traces or screenshots.** Playwright records neither by default. Set `trace` and `screenshot` in `use`, or install
through [`wrapConfig`](#installing-via-wrapconfig).

**No network, Web Vitals, console or locator data.** Every spec must import `test` from your fixtures file, not from
`@playwright/test`, and `collectPerformanceMetrics` must not be `false`. See
[Capture fixtures → Troubleshooting](./capture-fixtures#troubleshooting).

**Connection errors.** Check that `serverUrl` answers from where the tests run, and run with `PIWI_VERBOSE=true` for
the full request trace. A run the reporter could not deliver (dashboard down, or a 401 because no credential was set)
is saved locally and submitted on the project's next run, without traces or attachments; the Playwright run keeps its
own result either way. An interrupted stream is retried, then sent as a batch. Every attempt to deliver a run carries
the same key, so a run sent again after a slow upload, or from the saved copy, is stored once.
[`submitTimeout`](/reference/reporter-options#submittimeout) (15 minutes by default) bounds that end-of-run work, so
an unresponsive dashboard does not hold the CI job.

## Related

- [Reporter options](/reference/reporter-options): every option and its `PIWI_*` variable
- [Test metadata](/reference/test-metadata): what the reporter records on its own
- [Capture fixtures](./capture-fixtures): the evidence the fixtures add
- [CI & sharding](./ci): the reporter in a pipeline
