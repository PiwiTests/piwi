---
title: Cut the time it costs
titleTemplate: "Slow Playwright suite: :title | Piwi"
description: "Find where your suite's CI time goes, from waits and timeouts to flaky retries and slow endpoints, and what to cut first."
lang: en-US
---

# Our suite takes too long — where is the time actually going?

The instinct is to look for slow tests. That is usually the smallest part of the bill. A suite's wall
clock is mostly made of four things, and only one of them is "the app is slow":

1. **Waits somebody wrote** — `waitForTimeout` sleeps that were a workaround once.
2. **Timeouts nobody revisited** — a thirty-second budget on a three-second test costs twenty-seven seconds *every time it fails*.
3. **Retries of flaky tests** — paid on every run, and they buy no signal.
4. **The application itself** — the only part that needs a real fix.

Piwi measures all four separately, so you can spend effort where the minutes are. It does not make your
app faster; it tells you whether that is even the problem.

## 1. Split the bill before optimizing anything

[Analytics](/features/analytics) has two widgets that belong side by side: **CI time**, the minutes your runs
consumed, and **Wasted CI time**, the part that produced no signal ([what counts as wasted](/features/slow-tests#wasted-time)).

If wasted time is a small slice, your suite is just big: look at [the application](#_5-ask-whether-the-app-is-slow-not-the-test) and
[parallelism](#_6-spend-the-parallelism-you-already-have). If it is a large slice, start with [the waits](#_2-reclaim-the-waits-you-wrote),
[the timeouts](#_3-tighten-the-timeouts-that-only-bill-you-on-failure) and [the flaky retries](#_4-stop-paying-for-flaky-retries).

## 2. Reclaim the waits you wrote

The sleeps somebody wrote are wasted time Piwi totals per execution and per run, and which waits count is yours
to tune ([wasted time](/features/slow-tests#wasted-time)). Turn on **Show waits** on a run's **Timeline** tab and each
sleep is a bar that opens its test.

<figure>
  <img src="/screenshots/run-timeline.png" alt="A run's Timeline tab: one horizontal lane per worker, tests as bars with their setup and teardown hooks hatched at each end, the fixed-wait sleeps highlighted as wasted-wait spans, and the Show hooks and Show waits switches above">
  <figcaption>The Timeline tab: one lane per worker, hook time hatched at each end of a test, and the fixed-wait sleeps highlighted as their own span.</figcaption>
</figure>

Count every wait once to see how much of the suite is waiting on something, then set the patterns back.

## 3. Tighten the timeouts that only bill you on failure

An oversized per-test timeout bills you only when the test fails. The **Performance** tab's
[**Timeout opportunities**](/features/slow-tests#timeout-opportunities) lists the tests whose timeout dwarfs their real
duration, and the outgrown `test.slow()` marks, each with a tighter value and the time it reclaims.

<figure>
  <img src="/screenshots/performance-trends.png" alt="Project Performance tab showing the duration trend chart with total, average and percentile series and timeline markers, above the slowest-tests table">
  <figcaption>The Performance tab: average and percentile duration over time, then the ranked slowest tests.</figcaption>
</figure>

Read the [percentile line](/features/slow-tests#duration-trends), not the average.

## 4. Stop paying for flaky retries

A flaky test bills you twice, for the failed attempt and for the retry, on every run where it misbehaves. That is
why Piwi ranks flaky tests by what their retries cost ([impact](/features/flaky-tests#impact-ranking)) rather than by
flakiness score.

[Cutting the flakiness that costs the most](./flaky-cleanup) is the whole recipe for this. The short
version: work down the impact order, fix the red dots, and
[quarantine](/features/flaky-tests#quarantine-with-a-way-out) the rest so they stop blocking merges while
still running.

## 5. Ask whether the app is slow, not the test

Everything above shaves time off the harness; this step finds a real performance bug.

- **[Slow endpoints](/features/slow-tests)**: on a run, network requests grouped by normalized route with their
  duration and error rate; [Analytics](/features/analytics) lifts the same view across every project.
- **Web Vitals**: TTFB, FCP, LCP, CLS and the rest per execution. LCP, CLS and INP are Chromium-only.

Both require the [capture fixtures](/guide/capture-fixtures): the reporter alone cannot see the network.
Without them you still have the trace: its network waterfall shows the same requests for one execution,
just not aggregated across the suite.

## 6. Spend the parallelism you already have

- **Worker imbalance** is called out in a run's [Timeline](/features/ui-overview#test-run-detail) tab, under the worker
  distribution: if one worker finishes long after the others, the suite is as slow as its unluckiest shard, and no
  amount of per-test tuning fixes that.
- **Sharding** is Playwright's own `--shard`; Piwi merges the shards back into [one
  run](/guide/concepts#test-run), so you can raise the shard count without turning your history into
  fragments. See [CI & sharding](/guide/ci#sharding).

## Other ways in

**Ask your agent.** Over the [MCP server](/features/mcp), `get_slow_tests` returns the ranked slowest tests,
`get_performance_trend` the duration history, and `get_run_insights` the worker imbalance of one run.

**Script it.** The same numbers are on the REST API: see the [API docs](https://piwitests.dev/demo/settings/api).

**Watch it drift.** Rather than auditing periodically, subscribe to the `perf.regression`
[notification](/features/notifications) event and let it tell you when a duration trend breaks.

## Related
- [Slow tests & wasted time](/features/slow-tests) — the full reference for trends, slowest
  tests and timeout hygiene
- [Cut the flakiness that costs the most](./flaky-cleanup) — the flaky-retries step in full
- [Analytics](/features/analytics) — CI time and wasted CI time across every project
- [Capture fixtures](/guide/capture-fixtures) — what unlocks the network and Web Vitals views
