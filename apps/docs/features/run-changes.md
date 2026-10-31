---
title: What changed in a run
description: "What changed in a run against its baseline: new failures, fixed tests, new flakes, the largest duration changes and the commits in between."
lang: en-US
---

# What changed in a run

<Needs reporter />

The **Changes** tab on a run compares it against **one baseline** and tells you what moved: which tests newly started failing, which got fixed, and what landed between the two. It's the fastest way to answer "did my push break this, or was it already red?"

## The baseline

Every section reads the **same baseline**, so the "new failures" count is computed once and used throughout. The selector at the top says which run it is, which branch and environment that run is on, and **why it was chosen**.

By default the baseline is the last passing full run chosen by the [baseline rule](/guide/concepts#baseline-last-green-run): same environment first, then same branch, base branch, any branch. The line under the selector spells out the rung that applied, for example _"No passing staging run exists on feature/x; the last passing run on the default branch main in staging."_

<figure>
  <img src="/diagrams/baseline-ladder.svg" alt="The baseline ladder: same branch, base branch, then any branch, first within the run's environment and then in any environment; with no passing run, the same rungs for the last failed run">
  <figcaption>Six rungs, tried in order: the first with an earlier passing run gives the baseline.</figcaption>
</figure>

### When no earlier run passed

A project that has never had a green run still gets a comparison. When no earlier full run passed, the tab walks the same ladder again for the **last failed run** and says so: _"No earlier full run passed; the last failed run on feature/x in staging."_ The sections read the same way against it: **New failures** are the tests that passed in that run and fail here, **Still failing** the ones that failed in both. Timed-out and interrupted runs stopped before the suite ended, so they are never picked automatically.

Only the Changes tab and the MCP `get_run_insights` tool take a failed run. The stored regression signals, the [CI gate](/guide/ci#blocking-a-merge) and [pull-request feedback](/features/pr-feedback) keep comparing with a passing run, so their verdicts never rest on a run that was itself red.

When nothing qualifies (the earlier runs are partial, timed out or interrupted), the tab says so and offers the earlier runs to pick from. On the project's first finished run, it says there is nothing earlier yet.

### Picking another baseline

Two ways to compare against something else:

- **Base branch** — take the baseline from one branch only: its last passing run, else its last failed run, same environment first. The list offers every branch with an earlier full run that passed or failed, so it appears once a branch other than this run's own has one. Deep-linkable as `?baseBranch=<name>`.
- **Run** — compare against one earlier run, whatever its branch, environment or outcome. The list shows the 50 runs before this one, each with its branch, environment, start time and outcome, partial runs marked; type a branch or environment name to filter it. Deep-linkable as `?baseline=<runId>`, so a link to a comparison reopens the same two runs. **Previous run** is the shortcut for the run just before this one.

**Automatic** returns to the default choice. The same options exist on the REST API (see the [API docs](https://piwitests.dev/demo/docs)), where `earlierRuns` lists the runs that can be passed as `baseline`, and on the MCP `get_run_insights` tool (`baseBranch`).

## What it shows

- **New failures** — passed in the baseline, failing here.
- **Fixed** — failed in the baseline, passing here.
- **Still failing** — failing in both.
- **Newly flaky / passed on retry** — passed here but needed a retry.
- **Slower / faster** — the ten largest duration changes each way.
- **Commits since the baseline** — the commit range, a copyable `git log` command and, when the SCM host is known, a link to the commits.
- **Environment changes** — the fields that differ (environment, branch, CI provider, browsers, and the [test order](#shuffled-runs) of a shuffled run), in *This run* / *Baseline* columns.

<figure>
  <img src="/screenshots/run-changes.png" alt="Run Changes tab showing the baseline selector, the tests that newly started failing, the ones that got fixed, and the commits landed since the baseline">
  <figcaption>The Changes tab on a run, read against one baseline — new failures, fixed tests, and the commits landed since.</figcaption>
</figure>

Comparing two runs is also how the [run comparison](./ui-overview#test-run-detail) works: select two runs on the project's Runs tab and the newer one opens on its Changes tab with the older as its baseline.

## Shuffled runs

A test that fails only after another one depends on the order, and a suite run in the same order every time shows the
same neighbor every time, which leaves the flaky test's [**Before** suspect](./flaky-tests#suspects) nothing to
compare. Playwright 1.64's `--shuffle` schedules test files, and the tests of files in parallel mode, in a random
order, and the run keeps its seed: the run's **Details** shows it as **Order**, and clicking the seed copies
`--shuffle <seed>`, which runs the same tests on the same workers in the same order again. Against a baseline that was
not shuffled, or the other way round, the Changes tab lists the **Test order** under Environment changes.

## Try it in the demo

<DemoExamples />

## Related

- [Regression or flake?](/recipes/regression-or-flaky): the Changes tab, used to decide whether one red test is new
- [Branches](./branches#branch-aware-baselines) — why the default baseline is the same-branch run
- [Flaky tests](./flaky-tests) — the per-project flaky, regression and spec-health signals
- [Failure clusters & the inbox](./failure-clusters) — the failures grouped by cause
- [Timeline markers](./timeline-markers) — annotate the trend charts with real-world events
