---
title: Slow tests & wasted time
description: "Where the suite's time goes: duration trends, timeout headroom, stale test.slow() marks, wasted wait and retry time, slow endpoints and Web Vitals."
lang: en-US
---

# Slow tests & wasted time

<Needs reporter fixtures />

The test list tells you what failed; it doesn't tell you where the **minutes** go. This page covers the project's
**Performance** tab (duration trends, the slowest tests, timeout opportunities, slow endpoints) and the time Piwi
counts as **wasted**. What the run cost the machine is on [CPU, memory & disk](./cpu-memory-disk); flaky tests ranked
by the time their retries cost, on [Flaky tests](./flaky-tests#impact-ranking).

## Duration trends

Average and **P90** duration over time, so a few slow outliers don't hide a real regression (a rising P90 with a flat
average is a tail getting worse). Read the percentile, not the average: a handful of slow outliers move it and barely
move the mean, and the outliers decide how long a shard takes. **Slowest tests** ranks the top offenders by duration.

<figure>
  <img src="/screenshots/performance-trends.png" alt="Performance tab showing the duration trend chart and slowest-tests table">
  <figcaption>The Performance view — average and P90 duration trends over time, followed by a ranked table of the slowest tests.</figcaption>
</figure>

## Timeout opportunities

Tests whose configured per-test timeout dwarfs their real p95 duration — so a hang or failure waits far longer than it needs to — plus tests still carrying a stale `test.slow()` mark they no longer need. Each row suggests a tighter timeout (or removing the mark) and the time reclaimable per failing run, ranked by impact.

An oversized timeout costs nothing while the test passes and its whole budget each time it fails: a thirty-second
timeout on a three-second test burns twenty-seven seconds on every failure before anyone learns anything.

This reads the per-test timeout the [reporter captures](/reference/test-metadata#per-test-timeout); runs reported before that shipped still surface stale `test.slow()` marks from annotations and durations alone. The thresholds are set in **Settings → Performance**.

## Wasted time

**Wasted time** is time that produced no signal. Piwi counts two kinds:

- **Waits**: the time inside wait steps that match the wasted-wait patterns. By default only explicit sleeps count
  (`waitForTimeout` and friends), since framework-injected waits (load-state, wait-for-function) are usually
  unavoidable. Tune the patterns in **Settings → Performance**, or lock them with
  [`PIWI_WASTED_WAIT_PATTERNS`](/reference/configuration#wasted-time); `*` counts every wait, which shows once how
  much of the suite is waiting. They are applied when a run is viewed, so a change re-classifies the whole history
  with no re-run.
- **Failed attempts**: the time spent running attempts that ended failed or timed out.

A run's test list and an execution's **Details** popover show each test's fixed-wait time, and the run's **Timeline**
tab draws the sleeps as bars with **Show waits**. The **Wasted CI time** [Analytics](./analytics) widget adds waits and
failed attempts over time and per project, beside **CI time**, the minutes the runs consumed, and states how much is
**reclaimable** by tightening timeouts and dropping stale `test.slow()` marks. With a
[cost per CI minute](/reference/configuration#wasted-time) set, each wasted-time number carries its cost.

The flaky list's **wasted CI minutes** are a narrower number, a test's retries times its average failed attempt:
see [Impact ranking](./flaky-tests#impact-ranking).

## Network and Web Vitals

- **Slow endpoints** — slow API calls grouped by method and normalized route (e.g. `/users/:id`), for a run picked from the tab.
- **Browser Web Vitals** — TTFB, DOMContentLoaded, FCP and more, with color-coded thresholds, shown per execution in the **Performance** tab of the execution page's evidence rather than on the project.

Both require the [capture fixtures](/guide/capture-fixtures) in your test setup — without them the reporter has no network timings or Web Vitals to aggregate.

## Try it in the demo

<DemoExamples />

## Related

- [Cut the time it costs](/recipes/faster-suite): the slowest tests and wasted time, cut in order of cost
- [Capture fixtures](/guide/capture-fixtures) — the test-side setup behind network analysis and Web Vitals
- [Flaky tests](./flaky-tests): the time a flaky test's retries cost
- [Analytics](./analytics): wasted time and slow endpoints across every project
- [Reporter](/reference/test-metadata#per-test-timeout) — how the per-test timeout is captured
