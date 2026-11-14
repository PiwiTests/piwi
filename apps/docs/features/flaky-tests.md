---
title: Flaky tests & quarantine
description: "How Piwi scores and classifies flaky tests from their history, ranks them by the CI time they waste, and quarantines them with a way out."
lang: en-US
---

# Flaky tests & quarantine

<Needs reporter />

A single run tells you what failed; a few dozen tell you what's *unreliable*. This page covers what Piwi computes
for one project from its history: the flaky score, its ranking and suspects, quarantine and the regression signals.
Testing a suspect by experiment is on [Flake Lab](./flake-lab); the same signals across every project, on
[Analytics](./analytics).

## Flaky test detection

A test is flaky when its result isn't deterministic. Piwi computes a **flakiness score** (1–100) per test from two signals, weighted 60/40:

- **Retry passes** — failed, then passed on retry (each `--repeat-each` repetition on its own).
- **Status alternation** — flips between pass and fail; other outcomes ignored.

The **failure rate** is shown but not scored. Only runs where the test passed or failed count, and a test is listed
once it has 3 of them in the window, with a retry pass or two flips.

<figure>
  <img src="/diagrams/flakiness-score.svg" alt="A test's last 10 runs with 2 retry passes and 4 flips give a score of 30; its impact is 0.7 times 3 wasted CI minutes plus 0.3 times a fixed weight of 30 times 2 retry passes, 20">
  <figcaption>The score and the impact ranking, computed for one test.</figcaption>
</figure>

The project's **Failures** tab has a **Flaky** view with a **lookback window** of 20, 50 or 100 runs. Each flaky test links to its history and, unless already quarantined, offers **Quarantine**.

**Scoping**: only runs within the project's **Filters** count: environment (the [reporter](/guide/reporter)'s `environment` option), branch (the [default branch](./branches#the-default-branch) unless picked) and full runs only.

<figure>
  <img src="/screenshots/flaky-detection.png" alt="Flaky tests tab listing tests with composite score, failure rate, retry passes, and flip counts">
  <figcaption>The Flaky view: each intermittent test scored and ranked by impact, with its top suspect.</figcaption>
</figure>

### Root-cause classification

Every flaky test is tagged with one of six categories, using keyword and distribution heuristics over its errors, steps, and browser spread, sharpened by the failed requests actually captured and by the [attempt diff](./evidence#attempts). It reads the test's last 100 failed attempts and its last 100 passes from any run, green or red, so the failed attempt of a test that passed on retry counts, and a rare flake keeps its failures however many passes came since:

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

A flaky test's **Flakiness** tab lists its **suspects**: what its failures share and its passes do not,
over its last 30 days (at most 200 attempts, from the runs the flaky list reads).

| Factor | Measured per attempt |
|--------|----------------------|
| Slow route | a request's slowest duration, over the threshold that best separates failures from passes |
| Failed route | a request answering 5xx, or with no response |
| Load | other tests of the same shard running at once, over a threshold |
| Time zone, locale | the runner's, when it varied |
| Alongside | another test overlapping it |
| Before | the test just before on its worker |
| Browser | its Playwright project |

Each factor becomes a [lab condition](./flake-lab#the-conditions).

Each shows its raw counts: `GET /api/cart slower (≥1.6 s)`, 7 of 8 failures, 3 of 44 passes. It needs 3
failures and a lift of at least 2, `(fw+1)/(f+2) ÷ (pw+1)/(p+2)`; at most 5 are listed, ranked by lift ×
those failures. A neighbor names the paths both tests write, marked approximate when the overlap crosses shards,
whose clocks agree only roughly. First attempts, the UTC hour, other runs on the same environment, the runner image and
the browser version are context, without a condition. Nothing is stored.

The flaky list names each test's top suspect (a reproduced one first), the [Attempts](./evidence#attempts) tab links
requests to suspects, the clue `known-flake-suspect` marks failures showing one, and MCP's `get_flake_profile`
returns it. The [Flake Lab](./flake-lab) tests each suspect against a control run.

<figure>
  <img src="/screenshots/flakiness-tab.png" alt="A flaky test's Flakiness tab: two suspects with their counts among failures and passes, the lab condition and result of each, the context a lab cannot apply, and the experiment that reproduced the flake">
  <figcaption>A flaky test's suspects, and the experiments run on them.</figcaption>
</figure>

### Verified fixed

When a [`piwi flake verify`](./flake-lab#verify-a-fix) experiment holds, the test reads **verified fixed on
`<commit>`** on its Flakiness tab and leaves the ranking, and with it the MCP `list_flaky_tests` tool, quarantine
candidates and the analytics leaderboard. The Flaky view lists it apart, under **Verified fixed**. The first
retry-pass in a run that started after the verification brings it back. A `still-fails` verify, or a later
reproduction, removes the mark; an `inconclusive` one changes nothing.

### Impact ranking

The list is ranked by **impact**, `wasted CI minutes × 0.7 + retry passes × 30 × 0.3`, so the tests that cost the most
come first. Here **wasted CI minutes** are the test's retry-pass runs times the average duration of its failed
attempts in the window: what its retries cost, not the [wasted time](./slow-tests#wasted-time) of Analytics. Ties go
to the higher score, then more retry passes, and the top 50 are listed. A dot colors the wasted minutes:

- 🟢 green — under 5 wasted minutes
- 🟡 amber — under 30 minutes
- 🔴 red — 30 minutes or more

### Per-test stability trend

The **Trend** tab of a test's page draws its pass rate, [flaky rate](/guide/concepts#flaky-rate) and average duration over its
[runs](/guide/concepts#test-case) of the last 30, 90 or 365 days, one point per UTC day, week or month, with the project's timeline markers, to
see whether a fix stuck. The same series is the MCP `get_test_stability_trend` tool.

## Quarantine, with a way out

Detecting a flaky test doesn't stop it blocking merges. Quarantine does — without hiding it.

The usual approach is `--grep-invert @quarantine`: the test stops running, nothing ever proves it's fixed, and the
list only grows.

**A quarantined test in Piwi keeps running and reporting.** It is excluded from the [gate](./merge-gate#what-it-leaves-out)'s
`--max-failed`, `--max-new-regressions`, `--max-new-flaky`, `--require-tag` and `--require-selection` checks and the
[commit status](./pr-feedback#what-gets-posted). That makes the exit possible:

- Each run started after the quarantine counts once toward a **streak**: a pass adds one, a failure or a pass on retry
  resets it, a skip does neither.
- After five consecutive passes the test is flagged **ready to release**: you're told, not asked.
- A fix [verified](#verified-fixed) after the quarantine flags it at once, until the test fails again. Release stays
  yours to click.
- **Candidates** (**Proposed for quarantine** in the Flaky view) are flaky tests wasting 2+ CI minutes with a score
  of 40+, ranked by impact; a high-confidence AI diagnosis calling the test flaky adds a reason. A 200 ms flake
  costs nothing; one burning a four-minute timeout weekly hurts.
- **Debt** is reported in aggregate: how many are quarantined, ready to release or failing in their latest run, and how
  long the oldest has been in.

**Dismiss** turns down either proposal, with an optional reason, and moves no test: a dismissed release stops counting
as ready, and a dismissed candidate returns once the flaky analysis reads a newer run. Agents call [`dismiss_quarantine_proposal`](/reference/mcp-tools#dismiss_quarantine_proposal)
and [`set_test_quarantine`](/reference/mcp-tools#set_test_quarantine).

The gate always states how many failures quarantine excluded, and `--max-quarantined` sets a ceiling on the list.

Manage it from the **Quarantine** view of the project's **Failures** tab, or over the REST API (see the [API docs](https://piwitests.dev/demo/settings/api)).

## Regression signals

A run's tests carry badges:

- **New regression** (red): failing here, passing in the [baseline](/guide/concepts#baseline-last-green-run), the same
  Playwright project in the last complete passing run
- **Newly flaky** (fuchsia): flaky here, passed with no failed attempt in the baseline
- **Passed on retry** (fuchsia): failed at least once in this run, then passed

Filters on the run's test-case list show only the **New regression** or the **Newly flaky** tests.

An [execution](./evidence#one-execution-diagnosis-first) shows them in its status chip and the line under its headline.

## Spec health by file

With **Group by: File** on the project's **Tests** tab, each spec file's header carries its tests' pass rate, flaky rate, failure count, run count and average time over the list's window (the last 30 days by default), so an unhealthy file jumps out. The **Spec health** [Analytics](./analytics) widget gives them per spec directory.

## Across every project

[Analytics](./analytics) lifts these signals across every project.

## Try it in the demo

<DemoExamples />

## Related
- [Regression or flake?](/recipes/regression-or-flaky): is one red test flaky?
- [Cut costly flakiness](/recipes/flaky-cleanup): the costliest flaky tests first
- [What changed in a run](./run-changes): the Changes tab against a baseline
- [Slow tests & wasted time](./slow-tests): where the suite's time goes
- [Failure clusters & the inbox](./failure-clusters): the failures grouped by cause
