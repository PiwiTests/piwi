# Piwi Dashboard Reporter

A custom Playwright reporter that sends your test results to a [Piwi Dashboard](https://piwitests.dev) server — run history, HTML reports, traces and performance metrics, streamed live as tests execute. With the optional capture fixtures it also unlocks locator healing, slow-endpoint analysis, Web Vitals, console capture and failure-time ARIA snapshots.

📖 **[Full documentation](https://piwitests.dev/guide/reporter)** · 🎮 **[Live demo](https://piwitests.dev/demo/)**

## Installation

```bash
npm install --save-dev @piwitests/reporter
```

## Set up in one command

From your Playwright project, `npx @piwitests/reporter init` installs the reporter, wraps your `playwright.config`, creates the capture-fixtures file, and records the connection in `.env.example`:

```bash
npx @piwitests/reporter init --server-url http://localhost:3000 --project my-project
```

Every step is idempotent (safe to re-run); a config shape it will not rewrite is reported as `manual` with the exact change to make, never mangled. Add `--dry-run` to preview or `--json` for a machine-readable plan an agent can act on. It also installs the [Piwi agent skills](https://piwitests.dev/features/agent-skills) so your coding agent can investigate failures, heal locators, and stabilize flaky tests. Run `npx @piwitests/reporter init --help` for all options, or wire it up by hand with the steps below.

> The package is `@piwitests/reporter`; its command is `piwi`. Invoke it through the package name (`npx @piwitests/reporter <command>`) so npx resolves this package — `npx piwi` would fetch an unrelated `piwi` from npm. Once the reporter is a project dependency, `npx piwi <command>` resolves the local binary and works too.

## Quick start

`wrapConfig` is the recommended setup. It injects the reporter **and** a global setup step (so the run shows up as "initializing" while your `globalSetup` runs), and defaults `use.screenshot` / `use.trace` to `'only-on-failure'` / `'retain-on-failure'` when unset so failure evidence is captured (pass `defaultCapture: false` to opt out):

```typescript
import { defineConfig } from '@playwright/test'
import { wrapConfig } from '@piwitests/reporter'

export default wrapConfig(defineConfig({}), {
  serverUrl: 'http://localhost:3000',
  projectName: 'my-project',
})
```

Run `npx playwright test` — results are uploaded automatically.

> Piwi rebuilds the run from the data it collects, so you don't also need Playwright's built-in `html` reporter — running it alongside Piwi just repeats the end-of-run report generation. Keep it only if you want Playwright's standalone report uploaded too.

**Recommended: enable the capture fixtures.** One small file unlocks the dashboard's richest features:

```typescript
// tests/fixtures.ts
import { test as base, expect } from '@playwright/test'
import { piwiFixtures } from '@piwitests/reporter'

export const test = base.extend(piwiFixtures)
export { expect }
```

Import `test` from this file in your specs instead of `@playwright/test`. A spec that imports from `@playwright/test` directly still runs and reports fine — it just isn't captured. `extendPiwiFixtures(base)` is an equivalent one-line spelling. See the [capture fixtures guide](https://piwitests.dev/guide/capture-fixtures) for the full feature matrix and composition patterns.

## What you get

- **Run history, statuses, errors, traces, reports and live streaming** — with no test-code changes.
- **Capture fixtures** add slow-endpoint analysis, Web Vitals, console capture, failure-time ARIA snapshots and locator healing.
- **AI steps** (`page.piwiLocator(...)` / `page.piwiRun(...)`) drive flows in plain English, compiled once and replayed deterministically with zero LLM calls in CI — see [AI steps](https://piwitests.dev/features/ai-steps).
- **CI-aware** — auto-detects the run label, branch and commit, publishes the run URL back to the pipeline, and shards into a single run. See [CI & sharding](https://piwitests.dev/guide/ci).

## Configuration

Most options can also be set via a `PIWI_*` environment variable (config wins over env, except for `PIWI_VERBOSE`). The full option and env-var reference lives in [Reporter options](https://piwitests.dev/reference/reporter-options); authentication for CI is covered under [API keys](https://piwitests.dev/operate/api-keys).

## Requirements

- Node.js 20 or higher (the reporter runs inside your test project — the dashboard *server* itself targets Node 22+, or use its Docker image)
- Playwright Test 1.59 or higher (a few features need a later version, named in their docs)
- A running Piwi Dashboard server

## Contributing

Source layout, the collect-and-submit data flow and the public/internal split are documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md). Build with `npm run reporter:build` (or `reporter:dev` for watch mode) from `packages/reporter/`, or add `-w packages/reporter` to run it from the repository root.

## License

MIT
