---
title: Cut costly flakiness
description: "One afternoon to make an unreliable suite trustworthy: fix the flaky tests that cost the most, one root cause at a time, and quarantine the rest."
lang: en-US
---

# Our suite is unreliable and I have one afternoon

Flaky-test cleanup usually stalls for the same reason: the list is long, every entry looks equally
annoying, and there's no obvious first move. Ranking by flakiness score doesn't help much either — a
test that flakes constantly but finishes in 200 ms costs almost nothing.

Rank by what it *costs* instead, fix three, and leave the rest running.

## 1. Work by impact, not by score

The **Flaky** view of the project's **Failures** tab scores each test from two signals — retry passes
and status alternation, weighted 60/40 — shows its overall failure rate alongside, and lists the tests
by **impact**: wasted CI minutes (retry passes × average failed duration) plus a per-retry penalty.

<figure>
  <img src="/screenshots/flaky-detection.png" alt="The Flaky view listing intermittent tests with wasted CI minutes, score, failure rate, top suspect, root cause, retry passes or flips and last flake, under root-cause filter chips and a runs-window selector">
  <figcaption>The Flaky view — ranked by impact, filterable by root cause, over the last 20, 50 or 100 runs.</figcaption>
</figure>

Start at the top and work down. Each row carries a color-coded dot for wasted CI minutes — green under
5, amber under 30, red at 30 or more — and in a suite carrying real flake debt a few red rows usually
account for most of the total.

## 2. Filter by root cause and fix a class at once

Every flaky test carries one of six root-cause categories, `timing`, `network`, `assertion`, `environment`,
`order` or `other`; [Flaky tests](/features/flaky-tests#root-cause-classification) explains the signals behind each.

Filtering by category is the trick that makes an afternoon enough, because a class usually shares one fix: eight
`timing` flakes usually share one bad wait helper to replace with a real wait condition, a `network` class wants a
stub or a retry on the fixture rather than the test, and an `environment` class is a browser-specific guard or a real
compatibility bug.

## 3. Narrow the window before you conclude anything

Two filters change the answer, and both are worth setting deliberately:

- **Runs window** — the last 20, 50 or 100 runs: recent behavior or a longer baseline. A test fixed last
  week still looks awful over the last 100.
- **Environment** — pick an environment in the project's **Filters** block and the analysis reads only
  its runs, so `staging` noise doesn't inflate a test that's stable in `production`. Set it via the
  reporter's `environment` option or `PIWI_ENVIRONMENT`.

## 4. Quarantine the rest — with an exit

You will not fix them all today, and disabling them is how suites rot. The usual
`--grep-invert @quarantine` approach stops the test running, so nothing ever proves it recovered and the
list only grows.

[Quarantine in Piwi](/features/flaky-tests#quarantine-with-a-way-out) keeps the test running and reporting. It
is excluded from the [CI gate](/guide/ci#blocking-a-merge)'s verdict and the run's commit status, and nothing else:

- Passing runs accumulate as a **streak**; one failure resets it.
- After five consecutive passes the test is flagged **ready to release** — you're told, not asked.
- **Candidates** (over the API) are flaky tests wasting 2+ CI minutes with a score of 40+, ranked by impact.
- **Debt** is reported in aggregate: how many are in, how many are ready to leave, how long the oldest
  has been there.

The gate reports how many failures quarantine excluded, and `--max-quarantined <n>` fails it
when more than *n* tests are quarantined, so the list can't grow unbounded.

## 5. Check the fix held

A flaky fix is easy to believe and hard to confirm. Each test case has a **stability trend** — pass
rate, flaky rate, and average duration bucketed over time — which is the honest answer to "did that
help?". If the suite-wide picture is what you need, [Analytics](/features/analytics) lifts the same signals
across every project, including wasted CI minutes and a global flaky leaderboard.

## Other ways in

**Ask your agent.** `list_flaky_tests` over the [MCP server](/features/mcp) returns each test's score, impact,
wasted CI minutes and root-cause category, highest score first; `get_test_stability_trend` answers whether one test is getting worse. Useful
for "what should I fix this sprint?" without opening a browser.

**Script it.** Quarantine is a REST resource, so promoting candidates or releasing ready tests can
be a scheduled job. Shapes are in the [API docs](https://piwitests.dev/demo/docs).

**No server at all.** If this is your own laptop suite rather than a team's, the
[desktop app](/features/desktop) runs the same analysis with no Docker and no Node — Windows x64,
Apple-silicon macOS and Linux x86-64, and the installers aren't signed yet.

## Related
- [Flaky tests](/features/flaky-tests) — the full scoring, quarantine, and performance reference
- [Analytics](/features/analytics) — the same signals across every project
- [Regression or flake?](./regression-or-flaky) — deciding whether one red test belongs on this list
