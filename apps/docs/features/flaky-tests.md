---
title: Flaky tests & quarantine
description: "How Piwi scores and classifies flaky tests from their history, ranks them by the CI time they waste, and quarantines them with a way out."
lang: en-US
---

# Flaky tests & quarantine

<Needs reporter />

A single run tells you what failed; a few dozen tell you what's *unreliable*. This page covers what Piwi computes
for one project from its history.

For the same signals aggregated across every project, see [Analytics](./analytics).

## Flaky test detection

A test is flaky when its result isn't deterministic. Piwi computes a **flakiness score** (0–100) per test from two signals, weighted 60/40:

- **Retry passes** — failed on the first attempt, passed on retry.
- **Status alternation** — flips between pass and fail across runs.

The **failure rate** is shown but not scored.

The project's **Failures** tab has a **Flaky** view with a **configurable lookback window**. Each flaky test links to its history and carries a **Quarantine** action.

**Scoping**: only runs within the project's **Filters** count: environment (the [reporter](/guide/reporter)'s `environment` option), branch (the [default branch](./branches#the-default-branch) unless picked) and full runs only.

<figure>
  <img src="/screenshots/flaky-detection.png" alt="Flaky tests tab listing tests with composite score, failure rate, retry passes, and flip counts">
  <figcaption>The Flaky view of a project's Failures tab — each intermittent test scored, ranked by impact, filterable by root-cause category, with its top suspect.</figcaption>
</figure>

### Root-cause classification

Every flaky test is automatically tagged with one of six categories, using keyword and distribution heuristics over its errors, steps, and browser spread, sharpened by the failed requests actually captured and by the [attempt diff](./evidence#attempts). It reads the test's last 100 failed attempts and its last 100 passes from any run, green or red, so the failed attempt of a test that passed on retry counts, and a rare flake keeps its failures however many passes came since:

| Category | Typical signals |
|----------|-----------------|
| `timing` | Timeouts, "to be visible", `waitFor`, element-not-found-within |
| `network` | `net::` / `ERR_` errors, 5xx responses, `ECONNREFUSED`, `waitForResponse` — plus the count of failed and 5xx requests captured on the failing attempts, and any request that failed on the failing attempt but not the passing one |
| `assertion` | `expect(...)`, "Expected:", snapshot/screenshot comparison — with no timing/network noise |
| `environment` | Fails at least 3 times on exactly one browser while another browser passed at least 3 times without failing |
| `order` | Its code path changes with whether another test ran before it in the run, and its failures follow that change ([coverage insights](./coverage-insights#a-path-that-depends-on-the-tests-before-it)) |
| `other` | No clear signal |

A test is classified when it passes on retry in a finished run, and a listed test still without a category when the
list opens.

Filter the flaky table by category to triage a class of failures at once.

### Suspects

A flaky test's page has a **Flakiness** tab listing its **suspects**: what its failures share and its passes do not,
over its last 30 days (at most 200 attempts, from the runs the flaky list reads).

| Factor | Measured per attempt | Condition a lab would apply |
|--------|----------------------|-----------------------------|
| Slow route | a request's slowest duration, over the threshold that best separates failures from passes | delay it to the failures' median |
| Failed route | a request answering 5xx, or with no response | fail it the same way, or abort it |
| Load | other tests of the same shard running at once, over a threshold | CPU ×4 |
| Alongside | another test overlapping it in time | run both together |
| Before | the test that ran just before on its worker | run that test first |
| Browser | its Playwright project | pin the project |

Each suspect shows its raw counts: `GET /api/cart slower (≥1.6 s)`, 7 of 8 failures, 3 of 44 passes. It needs 3
failures and a lift of at least 2, `(fw + 1)/(f + 2) ÷ (pw + 1)/(p + 2)`; at most 5 are listed, ranked by lift ×
those failures. A neighbor names the paths both tests write, marked approximate when the overlap crosses shards,
whose clocks agree only roughly. First attempts, the UTC hour and other runs on the same environment are context,
without a condition. Nothing is stored.

The flaky list names each test's top suspect (a reproduced one first), the [Attempts](./evidence#attempts) tab links
requests to suspects, the clue `known-flake-suspect` marks failures showing one, and MCP's `get_flake_profile`
returns it. The [Flake Lab](./flake-lab) tests each suspect against a control run.

### Verified fixed

When a [`piwi flake verify`](./flake-lab#verify-a-fix) experiment holds, the test reads **verified fixed on
`<commit>`** on its Flakiness tab and leaves the ranking, and with it the MCP `list_flaky_tests` tool, quarantine
candidates and the analytics leaderboard. The Flaky view lists it apart, under **Verified fixed**. The first
retry-pass in a run that started after the verification brings it back. A `still-fails` verify, or a later
reproduction, removes the mark; an `inconclusive` one changes nothing.

### Impact ranking

Piwi ranks flaky tests by **impact** — derived from wasted CI minutes (retries × average failed duration) and pipeline-block effect — so you fix the ones that hurt most first. A color-coded dot makes it scannable:

- 🟢 green — under 5 wasted minutes
- 🟡 amber — under 30 minutes
- 🔴 red — 30 minutes or more

### Per-test stability trend

The **Trend** tab of a test's page draws its pass rate, flaky rate and average duration over the last
30, 90 or 365 days, one point per UTC day, week or month, with the project's timeline markers, so you can
see whether a fix actually stuck. The same series is the MCP `get_test_stability_trend` tool.

## Quarantine, with a way out

Detecting a flaky test doesn't stop it blocking merges. Quarantine does — without hiding it.

The usual approach is `--grep-invert @quarantine`: the test stops running, nothing ever proves it's fixed, and the
list only grows.

**A quarantined test in Piwi keeps running and reporting.** It is excluded from the [CI gate](/guide/ci#blocking-a-merge)'s
`--max-failed`, `--max-new-regressions`, `--max-new-flaky`, `--require-tag` and `--require-selection` checks and the
[commit status](./pr-feedback#what-gets-posted), nothing else. That makes the exit possible:

- Passing executions after quarantine (one per attempt per browser project) accumulate as a **streak**; one failure
  resets it.
- After five consecutive passes the test is flagged **ready to release** — the dashboard tells you, rather than waiting
  to be asked.
- A fix [verified](#verified-fixed) after the quarantine flags it at once, while it holds. Release stays yours to
  click.
- **Candidates** (**Proposed for quarantine** in the Flaky view) are flaky tests wasting 2+ CI minutes with a score
  of 40+, ranked by impact; a high-confidence AI diagnosis calling the test flaky adds a reason. A 200 ms flake
  costs nothing; one burning a four-minute timeout weekly hurts.
- **Debt** is reported in aggregate: how many are quarantined, how many are ready to release, how long the oldest has
  been in, and how many still have no passing streak at all.

**Dismiss** turns down either proposal, with an optional reason, and changes nothing else; a dismissed candidate
returns after a newer run. Agents call [`dismiss_quarantine_proposal`](/reference/mcp-tools#dismiss_quarantine_proposal)
and [`set_test_quarantine`](/reference/mcp-tools#set_test_quarantine).

The gate always states how many failures quarantine excluded — a green gate that silently ignored failures would be
worthless — and `--max-quarantined` sets a ceiling so the list can't grow unbounded.

Manage it from the **Quarantine** view of the project's **Failures** tab, or over the REST API (see the [API docs](https://piwitests.dev/demo/docs)).

## Regression signals

Individual test cases in a run carry at-a-glance badges:

- **New regression** (red) — failing here but passing in the baseline (the last passing run)
- **Newly flaky** (fuchsia) — the first run in which the test was flaky
- **Passed on retry** (fuchsia) — failed at least once in this run, then passed

Filters on the run's test-case list show only new regressions or new flaky tests.

An [execution](./evidence#one-execution-diagnosis-first) shows them in its status chip and the line under its headline.

## Spec health by file

The project's **Tests** tab has a **Group by File** view that groups tests by their first two path segments (`tests/admin` for `tests/admin/users.spec.ts`) and carries that group's pass rate, flaky rate, failure count, execution count and average time over the last 90 days in its header, so an unhealthy area of the suite jumps out.

## Across every project

Everything above is scoped to one project; [Analytics](./analytics) lifts the same signals across every project.

## Related
- [Regression or flake?](/recipes/regression-or-flaky): is one red test flaky?
- [Cut costly flakiness](/recipes/flaky-cleanup): fix the costliest flaky tests first
- [What changed in a run](./run-changes) — the Changes tab: new failures, fixed tests, commits since a baseline
- [Slow tests & wasted time](./slow-tests) — duration trends, slowest tests, and timeout opportunities
- [Analytics](./analytics) — the same signals across every project
- [UI overview](./ui-overview) — where each of these views lives in the dashboard
- [Reporter](/guide/reporter) — how retries, traces, and run metadata get captured
- [Capture fixtures](/guide/capture-fixtures) — the test-side setup behind network analysis and Web Vitals
- [Failure clusters & the inbox](./failure-clusters): the failures grouped by cause
