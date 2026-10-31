---
title: Regression or flake?
description: "Decide in a minute whether a red test is your regression or a known flake, from the run's changes and the test's own history."
lang: en-US
---

# Is this test failing because of my change, or is it flaky?

The most common question in a red CI run, and the most expensive one to answer wrong: re-run a real
regression and you ship the bug; chase a flake and you lose an afternoon. Piwi answers it from history
you already have, in about a minute.

## 1. Open the run's Changes tab

A run compares itself against **one baseline** — the last passing run on the same branch by default —
and sorts the failures for you. The distinction you want is right there in the headings:

- **New failures** — this test was passing on the baseline and is failing now.
- **Still failing** — it was already failing before your change.
- **Newly flaky / passed on retry** — it passed but needed a retry.

<figure>
  <img src="/screenshots/run-changes.png" alt="Run Changes tab showing the baseline selector, new failures, newly flaky tests, slower and faster tests, and the commits landed since the baseline">
  <figcaption>The Changes tab — read against one baseline, with new failures separated from tests that only passed on retry.</figcaption>
</figure>

If your test is under **Newly flaky / passed on retry**, stop here: it isn't your change. Jump to
[cutting flakiness](./flaky-cleanup) when you have time to spend on it.

## 2. Check the test's own history

A single run can lie — a flaky test lands in "new regressions" whenever the baseline happened to be
green. Open the test case and read its **status history** and **stability trend**: pass rate, flaky
rate, and duration bucketed over time.

<figure>
  <img src="/screenshots/tour-test-history.png" alt="A test case page: run stats, the duration trend with a status strip under it, and the recent executions">
  <figcaption>Test case history: the status strip is what separates "this has always been shaky" from "this broke on Tuesday".</figcaption>
</figure>

Read it like this:

| History looks like | Verdict |
|---|---|
| Solid green, then red from one run onward | A regression. Find the commit in that gap. |
| Red/green alternating for weeks | A flake that happened to fail on your run. |
| Green, then red, and the failing execution **passed on retry** | A flake: its status reads *Passed on retry*, and its headline is the failed attempt's error. |
| Newly red *and* the failure is shared with other tests | Probably neither — see [triaging a mass failure](./mass-failure). |

## 3. Find what changed around it

Once you know it's a real regression, narrow the window:

- The failing execution's **History** section links back to the **last green run** ("Last passed in run
  #N"), so you have two commits to diff between.
- If the drop lines up with a deploy or an infrastructure change, a
  [timeline marker](/features/timeline-markers) draws it as a vertical line on the trend chart — "it started
  the day we switched CI runners" is a much faster answer than a bisect.
- With [AI diagnosis](/features/ai-diagnosis) configured, the cluster's explanation is read against your actual
  git diff since the last green run, and any suggested patch is checked against your source before you
  see it. Optional, off by default.

## Other ways to get the same answer

Not everyone wants to click through a dashboard mid-review.

**Ask your coding agent.** The [MCP server](/features/mcp) is built into the running instance — nothing to
install. `get_run_insights` returns the same regression / recovery / new-flaky split this page walks
through, and `get_test_stability_trend` answers "is this getting flakier?" for one test.

**Wire it into CI.** The [CI gate](/guide/ci#blocking-a-merge) already knows the difference: a test in
[quarantine](/features/flaky-tests#quarantine-with-a-way-out) keeps running and keeps reporting, but doesn't
block the merge — and the gate reports how many failures it excluded.

**Get told instead of looking.** [Notifications](/features/notifications) let you subscribe to
`run.failed.default_branch` rather than `run.failed`, so you hear about main going red instead of every
red branch build — the difference between an alert people read and one people mute. `flakiness.spike`
fires separately for any run with flaky tests; a subscription's flakiness threshold (set through the API)
narrows it.

## Related
- [Flaky tests](/features/flaky-tests) — how the composite score and root-cause categories are computed
- [Core concepts](/guide/concepts) — *test case* vs *execution*, the distinction this recipe leans on
- [Timeline markers](/features/timeline-markers) — correlating a drop with a deploy
