---
title: Why Piwi?
description: "How Piwi compares with the Playwright HTML report, Allure, ReportPortal, Currents and Fault0, and when another tool fits better."
lang: en-US
---

# Why Piwi?

Piwi Dashboard gives your Playwright results a permanent, self-hosted home — with live streaming, failure clustering, flaky-test analytics, and optional AI diagnosis on top. This page explains how it relates to tools you may already use, and answers the questions we hear most.

## The landscape

Every tool below is good at what it targets. The honest differences:

- **Playwright HTML report** — excellent for debugging a single run locally. But it's per-run and ephemeral: once the next CI build uploads its artifact, yesterday's context is gone, and there's no cross-run view (trends, flakiness, clustering) at all. Piwi doesn't replace it for local work — it replaces the *"download the artifact zip from CI"* workflow.
- **Allure Report** — a mature, multi-framework report generator producing a rich static report. History across builds requires wiring previous results into each build, and there's no server, live view, or cross-run analytics in the open-source generator (that's the commercial TestOps product).
- **ReportPortal** — a mature, framework-agnostic, self-hosted test-ops platform with ML-based failure triage. It's built for organizations aggregating many frameworks, and its self-hosted footprint matches that ambition: a multi-service stack (API services, PostgreSQL, RabbitMQ, OpenSearch). Piwi trades that breadth for Playwright-native depth in a single container.
- **Currents** — a polished commercial SaaS for Playwright and Cypress: run history, flake detection, CI orchestration. It's managed and maintained for you; in exchange it's paid and your test data lives on their infrastructure.
- **Fault0** — the closest peer to Piwi: a newer, free, self-hosted, Playwright-only results dashboard with a one-line reporter, centralized run history, trace/screenshot/video debugging, notifications, and flaky-test trends. It targets the same "give your Playwright results a home" job. Where Piwi differs today is the depth of the analysis layer on top of that shared core — failure clustering, flaky **scoring** with CI-cost impact, locator healing, an MCP server for AI agents, and optional git-grounded AI diagnosis — so the honest split is *seeing* failures (both) versus *resolving* them (Piwi's focus). We've based this on Fault0's public docs and homepage; corrections welcome.

## Feature comparison

| | **Piwi** | Playwright HTML report | Allure Report | ReportPortal | Currents | Fault0 |
|---|---|---|---|---|---|---|
| Run history across builds | ✅ | ❌ per-run | ➖ manual wiring | ✅ | ✅ | ✅ |
| Self-hosted | ✅ single container | — | ➖ static files | ✅ multi-service stack | ❌ SaaS | ✅ |
| Live run streaming | ✅ SSE, per-test | ❌ | ❌ | ➖ | ✅ | ➖ real-time status |
| Playwright traces, first-class | ✅ stored + viewer links | ✅ | ➖ attachments | ➖ attachments | ✅ | ✅ |
| Flaky detection & scoring | ✅ composite score, root-cause classes, CI-cost impact | ❌ | ❌ | ✅ | ✅ | ➖ detection |
| Failure clustering | ✅ error fingerprinting | ❌ | ❌ | ✅ ML-based | ✅ | ➖ |
| AI failure diagnosis | ✅ optional, grounded in your git diff, patches validated server-side | ❌ | ❌ | ➖ ML triage | ➖ | ➖ |
| Locator healing suggestions | ✅ from prior passing runs | ❌ | ❌ | ❌ | ❌ | ➖ |
| Plain-English steps, compiled | ✅ [AI steps](/features/ai-steps) — resolved once, replayed with zero model calls | ❌ | ❌ | ❌ | ❌ | ❌ |
| Web vitals & network capture | ✅ | ➖ in traces | ❌ | ❌ | ✅ | ➖ |
| MCP server for AI agents | ✅ | ❌ | ❌ | ❌ | ✅ | ➖ |
| Framework support | Playwright only (by design) | Playwright | Many | Many | Playwright, Cypress, Jest… | Playwright only |
| Price | Free, [fair source](/guide/license) | Free | Free | Free (self-host) / paid SaaS | Paid | Free, OSS |

In the **Fault0** column, ➖ marks a capability we did not find in its public docs at the time of writing (not necessarily a confirmed absence) — the two products share the core results-dashboard experience and differ mainly in Piwi's analysis depth. Corrections welcome.

## When Piwi is *not* the right choice

- **You aggregate many test frameworks** (JUnit, pytest, Cypress, …) into one place → ReportPortal or Allure fit better. Piwi is deliberately Playwright-only: the ingest API, trace handling, step analytics and locator healing are built around Playwright's model.
- **You want a managed service with CI orchestration** and someone else on the pager → Currents.
- **You only debug locally** and never look back at CI history → the built-in HTML report is already great.
- **You need a stable 1.0.** Piwi is pre-1.0: a minor release can carry breaking changes, and the database schema moves with it. Pin a version tag, keep backups, and read [Upgrading](/operate/upgrading) before you bump it.
- **You want an "ask AI" button.** Diagnosis is optional, grounded in your diff and evidence, and never in the write path.

## FAQ

### Is my data safe? Does Piwi phone home?

**Zero telemetry.** Piwi makes no outbound calls except the ones you configure, plus two that need no setting: anonymous public-API reads of the repository your runs report (its default branch and CODEOWNERS), and fetching the title of a link you attach. [Privacy & data flow](./privacy) lists each one.

### Does AI diagnosis send my code to a third party?

Only if you turn it on, and only to the [AI provider](./ai-provider) you configure, which can be a local model. [Privacy & data flow](./privacy) says what a diagnosis sends.

### SQLite or PostgreSQL?

Start with SQLite; switch to PostgreSQL when you want concurrent write headroom or your ops standard is Postgres. See [Database](/operate/database).

### Which Node version does the dashboard need?

Node 22 or newer, and only for `npx @piwitests/server`: the Docker image and the desktop app bundle their own runtime. The reporter in your test project needs Node 20 or later.

### Can I use it with Cypress / Jest / other frameworks?

No: Piwi is Playwright-only by design. See [when Piwi is not the right choice](#when-piwi-is-not-the-right-choice).

### Is it production-ready?

It is pre-1.0, tested across SQLite and PostgreSQL with local and S3 storage, and migrates its database on upgrade. See the [production checklist](/operate/production-checklist).

### How much disk/RAM does it need?

Modest; see [resource requirements](/operate/deployment#resource-requirements). Traces and reports take most of the disk.

### Where do I ask questions or propose features?

[GitHub Discussions](https://github.com/PiwiTests/piwi/discussions) for questions and ideas, [issues](https://github.com/PiwiTests/piwi/issues) for bugs, and [ROADMAP.md](https://github.com/PiwiTests/piwi/blob/main/ROADMAP.md) for direction.

---

<sub>Product names are used for identification only. Piwi Dashboard is an independent project, not affiliated with, endorsed by, or connected to Microsoft Corporation (Playwright), Qameta Software (Allure), EPAM Systems (ReportPortal), Currents Software, or Fault0. Details about third-party products reflect their publicly documented open-source/free tiers and may change — corrections welcome.</sub>
