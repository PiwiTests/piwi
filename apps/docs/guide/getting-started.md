---
title: Getting started
description: "Piwi Dashboard is a self-hosted server plus a Playwright reporter that keeps every test run. Run the dashboard, connect your suite with one command, and open your first run in three steps."
lang: en-US
---

# Getting started

Piwi is a **server plus a Playwright reporter**. The reporter runs inside `npx playwright test` and sends the results
to the server, which keeps every run with its traces and renders the dashboard. Three steps set up both. New to the
vocabulary (*run*, *test case*, *execution*, *cluster*)? [Core concepts](./concepts) defines each term the dashboard
uses.

## 1. Run the dashboard

The dashboard is one Node process. Pick the way to run it that fits:

| Path | Best for | Needs |
|---|---|---|
| [Desktop app](/features/desktop) | One developer running Playwright locally | Nothing; the runtime is bundled. Windows x64, Apple-silicon macOS and Linux x86-64; the installers are not signed yet |
| Docker *(below)* | A shared instance for a team, or anything long-lived | Docker; about 300 MB RAM, 1 vCPU, `linux/amd64` or `linux/arm64` |
| [`npx @piwitests/server`](/operate/deployment#npm-npx-quick-local-run) | A quick local run | Node.js 22 or later |
| [One-click deploy](/operate/deployment#one-click-deploy) | A shared instance with no server of your own | An account on the host |

With Docker:

::: code-group

<<< @/snippets/docker-run.sh [Linux / macOS]

<<< @/snippets/docker-run.ps1 [Windows (PowerShell)]

:::

The dashboard answers at `http://localhost:3000`. On Linux hosts the container runs as the non-root UID 1001, which is
why the snippet creates `.data` with the right owner; see
[Permission issues with volumes](/operate/deployment#permission-issues-with-volumes) if the container cannot write to
it. [Deployment](/operate/deployment) covers Docker Compose, PostgreSQL and Kubernetes.

With the desktop app, keep it running: a reporter with no server configured finds it by itself. Its URL and access
token, for when you need them, are on its **Setup** page under **Send results to this app**.

Your test project is unaffected by these requirements: Node 22 is the dashboard's requirement, not your suite's. Want
to look around first? The [live demo](https://piwitests.dev/demo/) runs in your browser on seeded data.

## 2. Connect your suite

The dashboard's connect wizard, on **Home** while it has no project and on **Setup** after, builds every snippet below
from your project name and its own URL, and offers three ways to the same setup: one command, a prompt for a coding
agent, or the steps by hand.
Each ends in [`wrapConfig`](./reporter#installing-via-wrapconfig) around your config and the
[capture fixtures](./capture-fixtures) in your specs: the reporter entry alone keeps your runs, and those two add the
failure screenshots and traces, the network and console capture, and locator healing.

### Fast path: one command

From your Playwright project, one command installs the reporter, wraps your `playwright.config`, creates the
[capture fixtures](./capture-fixtures) file and records the connection in `.env.example`:

```bash
npx @piwitests/reporter init --server-url http://localhost:3000 --project my-project
```

Every step is idempotent, so it is safe to re-run. When `init` finds a config shape it will not rewrite, or a fixtures
file that already exists, it reports that step as `manual` with the exact change to make instead of touching the file.
Pass `--dry-run` to preview, or `--json` for a machine-readable plan that a coding agent can follow to finish the manual
steps. `init` also adds the [Piwi agent skills](/features/agent-skills) to the project. See
`npx @piwitests/reporter init --help` for all options.

> The package is `@piwitests/reporter` and its command is `piwi`. Invoke it through the package name,
> `npx @piwitests/reporter <command>`, so npx resolves this package: `npx piwi` would fetch an unrelated `piwi`
> package from npm. Once the reporter is a dependency of your project, `npx piwi <command>` works too.

Then import `test` from the fixtures file in your specs, the one change `init` leaves to you:

```typescript
import { test, expect } from './fixtures'
```

A coding agent can do both: the **Coding agent** path on **Setup** gives it a prompt that runs `init --json`, finishes
the steps it reports as `manual` and moves the specs onto the fixtures.

If authentication is on, pass an [API key](/operate/api-keys) as `PIWI_API_KEY`; **Setup** creates one in place. When
developers run the [desktop app](/features/desktop) and CI reports to a shared dashboard, add `--desktop-app prefer`:
[local runs then land in the app](./reporter#local-runs-to-the-desktop-app-ci-to-a-team-server). To wire the reporter
in by hand, or to send one run without editing your config, see [Reporter](./reporter).

## 3. Run your tests

```bash
npx playwright test
```

The run streams into the dashboard while it executes, and the reporter prints a `View run:` link at the end. Open it.

In CI nothing Piwi-specific is needed: the same reporter runs inside `npx playwright test`, pointed at your instance
with `PIWI_DASHBOARD_URL` and `PIWI_API_KEY`. [CI & sharding](./ci) has the pipeline examples.

## Your first failure

When a test fails, its execution page opens on what happened, the most likely cause and the next step, with the
trace, screenshots and logs underneath. [Your first failure, explained](./first-failure) walks through one failing
test from its headline to its evidence.

## Related

- [Core concepts](./concepts): the vocabulary the dashboard and these docs use
- [Reporter](./reporter): manual setup, options, streaming and authentication
- [Capture fixtures](./capture-fixtures): what the fixtures file adds
- [Choose what you use](/operate/capabilities): turn off the capabilities you do not need
- [Deployment](/operate/deployment): running the dashboard for a team
