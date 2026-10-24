---
# https://vitepress.dev/reference/default-theme-home-page
layout: home
title: Piwi Dashboard — Your Playwright results, kept and explained
titleTemplate: false

hero:
  name: "Piwi Dashboard"
  text: "Your Playwright results, kept and explained"
  tagline: "CI throws away every report it makes. Piwi keeps them, then groups the failures by root cause, scores the flaky tests, and finds the locator you should have used. Self-hosted, zero telemetry."

  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: Live demo
      link: https://piwitests.dev/demo/
    - theme: alt
      text: GitHub
      link: https://github.com/PiwiTests/piwi

# The cards under the hero are the feature catalog's groups, one card each,
# filled in by transformPageData in .vitepress/config.mts.
---

<div class="home-start">

## Start in three steps

### 1. Run the dashboard

With Docker:

::: code-group

<<< @/snippets/docker-run.sh [Linux / macOS]

<<< @/snippets/docker-run.ps1 [Windows (PowerShell)]

:::

The same dashboard also runs as the [desktop app](/features/desktop), with no Docker and no Node, or with
`npx @piwitests/server` on Node 22 or later. It answers at `http://localhost:3000`.

### 2. Connect your suite

From your Playwright project:

```bash
npx @piwitests/reporter init --server-url http://localhost:3000 --project my-project
```

`init` installs the reporter, wraps your `playwright.config`, adds the capture fixtures and records the
connection in `.env.example`; every step is safe to re-run. [Getting started](/guide/getting-started) covers
the other ways to run the dashboard, and [Reporter](/guide/reporter) the manual setup.

### 3. Run your tests

```bash
npx playwright test
```

The run streams into the dashboard while it executes, and the reporter prints a `View run:` link at the end.
[Your first failure, explained](/guide/first-failure) walks through reading a failing test.

Piwi is deliberately **Playwright-only**: that is what makes traces, step timing and locator healing
first-class. It is also pre-1.0, so a minor release can carry breaking changes. If you need one place for
JUnit, pytest and Cypress results, or you only ever debug on your own machine,
[Why Piwi?](/guide/comparison) says which tool fits better.

</div>

<div class="screenshots">

## See it in action

<div class="demo-video">
  <video src="/demo-live-run.mp4" autoplay loop muted playsinline controls poster="/screenshots/demo-live-run-poster.png"></video>
  <p class="screenshot-caption">A run streaming in: each test lands as it finishes, failures first.</p>
</div>

<div class="screenshot-grid">
  <div class="screenshot-item screenshot-featured">
    <img src="/screenshots/home.png" alt="Dashboard overview, light and dark: portfolio stats, per-project health and recent activity" />
    <p class="screenshot-caption">Home: every project's pass rate and latest runs, the failing ones first, and the live activity across them.</p>
  </div>
  <div class="screenshot-item">
    <img src="/screenshots/failure-clusters-tab.png" alt="Failure clusters: one row per group of tests that failed for the same reason" />
    <p class="screenshot-caption">Failure clusters: forty red tests become the three causes behind them, each triaged once.</p>
  </div>
  <div class="screenshot-item">
    <img src="/screenshots/flaky-tests.png" alt="Flaky tests: each intermittent test scored and ranked by the CI time it wastes" />
    <p class="screenshot-caption">Flaky tests: a score, a root-cause class and the CI minutes each one wastes, the expensive ones first.</p>
  </div>
  <div class="screenshot-item">
    <img src="/screenshots/picker-pick.png" alt="Piwi Picker ranking the locators of a button on a live shop page, the unique one first" />
    <p class="screenshot-caption"><a href="/features/extension">Piwi Picker</a>, in your browser: ranked, stable locators picked from the live page, standalone.</p>
  </div>
  <div class="screenshot-item">
    <img src="/screenshots/vscode-heal.png" alt="VS Code with a CI failure at its line and the heal offered as a quick fix" />
    <p class="screenshot-caption"><a href="/features/editors">VS Code and the JetBrains IDEs</a>: the latest CI failures at their lines, the heal one quick fix away.</p>
  </div>
</div>

</div>

<div class="next-steps">

## Where to go next

### I write Playwright tests

- [Your first failure, explained](/guide/first-failure): one failing test, from its headline to its evidence
- [Core concepts](/guide/concepts): run, test case, execution, failure cluster, baseline
- [Capture fixtures](/guide/capture-fixtures): the one file behind locator healing, network timing and console capture
- [CI & sharding](/guide/ci): two environment variables, and every shard merged into one run
- [Browser extension](/features/extension) and [Editor extensions](/features/editors): Piwi where you write the tests

### Something is red right now

- [Is this test failing because of my change, or is it flaky?](/recipes/regression-or-flaky)
- [Forty tests are red: where do I start?](/recipes/mass-failure)
- [A locator broke after a UI change: what should I use instead?](/recipes/broken-locator)
- [Our suite is unreliable and I have one afternoon](/recipes/flaky-cleanup)
- [Our suite takes too long: where is the time actually going?](/recipes/faster-suite)

### I run Piwi for a team

- [Deployment](/operate/deployment): Docker, Compose, Kubernetes and one-click hosts
- [Production checklist](/operate/production-checklist): what to set before anyone else can reach it
- [Authentication](/operate/authentication): sign-in and OAuth, with [access, roles and groups](/operate/project-access) and [API keys](/operate/api-keys)
- [Upgrading](/operate/upgrading): what a version bump does, and why there is no downgrade

### I report to people who don't open Piwi

- [Quality reports](/features/quality-reports): the Analytics page as a document, sent on a schedule
- [Dashboards](/features/dashboards): saved analytics dashboards, shared with a team or shown on a wall screen
- [Notifications & alerts](/features/notifications): email, Slack, Microsoft Teams and webhooks
- [Share links](/features/share-links): a read-only link for someone without an account

### I connect an agent or automate

- [MCP server](/features/mcp): your test history as tools a coding agent can call
- [Agent skills](/features/agent-skills): the failure-fixing workflow, installed into your project
- [Piwi CLI](/reference/cli): `init`, `gate`, `select`, `probe` and `report`
- [API docs](https://piwitests.dev/demo/docs): every endpoint, rendered from the dashboard's own OpenAPI spec

Everything Piwi does, with what each feature needs, is on [All features](/reference/features).

</div>
