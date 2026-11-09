---
title: Reuse forecast
description: "How much of a project's recent test time ran code identical to an earlier pass, read from recorded coverage, and the tests that failed with their code unchanged."
lang: en-US
---

# Reuse forecast

The reuse forecast answers two questions from the coverage your runs already record: how much of the last month's test
time re-ran code that had already passed unchanged, and which tests failed even though the code they ran had not
changed. It lives on a project's **Selections** tab and in the `get_reuse_forecast`
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
  not their version, so its results are never comparable and count as run.
- **An upper bound.** The comparison sees the application files coverage records. A change to the test code itself,
  to the Playwright configuration or to a dependency is not part of it, and would make more tests run.
- **Runs that do not count**: Flake Lab, probe, bisect, reproduction, `piwi bug` and private runs, and runs flagged
  as an [environment incident](/features/environment-incidents).

## Related

- [Test selections](/features/test-selection): saved subsets, balanced shards and the CI guard
- [Impact from a diff](/features/change-impact): the tests a change affects, down to the changed lines
- [Code reach](/features/code-reach): what each test records about the code it runs
