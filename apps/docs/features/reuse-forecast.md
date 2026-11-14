---
title: Reuse forecast
description: "How much of a project's recent test time ran code identical to an earlier pass, read from recorded coverage, and the tests that failed with their code unchanged."
lang: en-US
---

# Reuse forecast

The reuse forecast answers two questions from the coverage your runs already record: how much of the last month's test
time re-ran code that had already passed unchanged, and which tests failed even though the code they ran had not
changed. It lives on a project's **Selections** page and in the `get_reuse_forecast`
[MCP tool](/reference/mcp-tools#workflow).

<Needs reporter fixtures />

<figure>
  <img src="/screenshots/reuse-forecast.png" alt="Pass reuse forecast card: 15% of the test time ran code identical to an earlier pass, and one test that needed a retry with its code unchanged in two browsers">
  <figcaption>The pass reuse forecast: the test time a run could have skipped, and the tests that failed or retried anyway.</figcaption>
</figure>

## What counts as reusable

The forecast reads the 30 days before the project's latest run. A result is **reusable** when an earlier result of
the same test, in the same Playwright project and another run, passed on its first attempt, is at most 14 days older,
and either:

- recorded file versions (runtime, path and git blob) that are all among the versions the result itself ran;
- or ran at the same commit, both runs on CI, which also counts a failure that stopped before reaching code the pass
  ran.

The code that pass ran had not changed, so a run could have skipped the result and kept the pass. The card gives the
share of test time that was reusable, split between the [default branch](/features/branches) and the other branches
when both have results: a branch's results may match a pass recorded on the default branch, since the comparison is
by content, not by branch.

## Failed with the code unchanged

A reusable result that failed, or passed only on a retry, ran code identical to an earlier pass. Its failure came
from the test, its data or its environment, not from a change to the application. The card lists those tests, each
with the failing execution and the pass it matched, which is strong evidence when you investigate a
[flaky test](/features/flaky-tests).

## What it needs, and its limits

- **Coverage with file versions**: [code reach](/features/code-reach) at `coverage.browser: 'functions'` or
  `'lines'`, or [server coverage](/features/server-coverage). With `'files'` a test records which files it ran but
  not their version. A pass stands in for a later result only when it recorded file versions; a result that recorded
  none is reusable only at the same CI commit as such a pass.
- **An upper bound.** The comparison sees the application files coverage records. A change to the test code itself,
  to the Playwright configuration or to a dependency is not part of it, and would make more tests run.
- **Runs that do not count**: Flake Lab, probe, bisect, reproduction, `piwi bug` and private runs, and runs flagged
  as an [environment incident](/features/environment-incidents).

## Skipping reusable tests

**Experimental.** With the pass reuse capability on, `piwi plan` and `piwi run --reuse` skip the tests the forecast
would count as reusable, with a stricter rule. A test's pass stands in for it only when that pass came from a clean
checkout of a commit, with the same Playwright version, and every result of the test in that run passed on its first
attempt with coverage naming its file versions. The working tree is diffed against that commit: the test runs when
[impact from that diff](/features/change-impact) selects it, when a changed file maps to no test, or when a file the
pass ran changed. A test that is quarantined, in an open failure cluster, failed or was retried in its last 20
executions, tagged `@no-reuse`, or in a spec file holding a serial group always runs. A run skips only the tests the plan names, in the Playwright projects
their pass ran them in, so a new or renamed test runs. The run records the tests it skipped and did not execute as its
reused results: the run page's header counts them and lists them with the pass each one reuses, the pull-request
comment counts them, and the `get_run` MCP tool returns their count. The run's own status, pass rate, flaky scores,
durations and fix verification read executions only. In a run that passed with no run error, the
[CI gate](/reference/cli#gate) counts a reused test as passed for its tag and selection rules, and `--max-reused` and
`--require-executed` limit reuse. A run that claimed a plan it was not made for (another commit, a dirty checkout,
another Playwright version, an expired plan) records no reuse and fails those two rules. A run whose shards' blob
reports are merged by `merge-reports` claims no plan, so its reuse is not recorded.

<figure>
  <img src="/screenshots/run-reused-tests.png" alt="Reused tests of a run: each test with its file and Playwright project, and a link to the earlier pass at its commit">
  <figcaption>A run whose plan skipped every test: each reused test with the pass that stood in for it.</figcaption>
</figure>

Commands: [`plan`](/reference/cli#plan). Design record: [pass reuse](https://github.com/PiwiTests/piwi/blob/main/proposals/pass-reuse.md).

## Related

- [Test selections](/features/test-selection): saved subsets, balanced shards and the CI guard
- [Impact from a diff](/features/change-impact): the tests a change affects, down to the changed lines
- [Code reach](/features/code-reach): what each test records about the code it runs
