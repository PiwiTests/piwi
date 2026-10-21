---
title: Test selections
description: "Run only the tests that matter: saved and built-in selections, balanced shards, impact from a diff, and the CI guard that keeps a selection honest."
lang: en-US
---

# Test selections

A **selection** is a named subset of your suite that Piwi resolves from the run history it already keeps, then hands
back as a command you can run. Instead of a `@smoke` tag convention and a grep pattern in a CI file that drift apart,
you describe the subset once ("critical tests, under 15 s each, not quarantined") and `piwi run` turns it into the
tests to run. A selection is resolved on demand, never frozen, so a renamed file or a newly flaky test is reflected
the next time you resolve it.

## Run one

```bash
npx @piwitests/reporter run smoke
```

`piwi run <key>` resolves the selection and runs `playwright test` with exactly those tests. It finds your dashboard
the way the reporter does, through `PIWI_DASHBOARD_URL`, `PIWI_API_KEY` (if auth is on) and `PIWI_PROJECT_NAME`, and
passes anything after `--` straight to Playwright. The run is **stamped** with the selection it came from, so the
[pull-request comment](/features/pr-feedback) names the subset, and a [gate](/guide/ci) can re-resolve the same
definition to check nothing was silently dropped.

If the dashboard is unreachable, `piwi run` falls back to the full suite with a warning (and reuses the last good
resolution from `.piwi/selection-cache.json` when it has one): a reporting problem never breaks the test run. Pass
`--strict` to invert that for CI, where an unresolvable selection should stop the pipeline. Resolving a named selection to
**zero** tests is always an error: a smoke job that silently runs nothing is worse than one that fails loudly.

### Print, shard and reorder

`piwi select <key>` resolves and prints the Playwright arguments instead of running them, for a two-step job. Three
flags shape a resolution:

- `--shard i/n` keeps only shard _i_ of _n_ (up to 1,000 shards), split so each shard's summed test duration is even. The split is
  **lock-aware**: every test that shares a [lock](/reference/test-metadata#test-locks) goes to the same shard, because
  Playwright serializes lock holders only inside one process. Shard with `piwi run --shard` rather than Playwright's
  own `--shard`, which would split the lock; a resolution whose tests share a lock carries a `split-lock` warning.
- `--fail-fast` puts the least-reliable tests first, so a likely failure surfaces early. It reorders and never drops,
  so a `--require-selection` gate still sees the whole set.
- `--budget 5m` caps the total time for this resolution.

`piwi run --shard` jobs merge into one run that still covers the whole selection. Every flag and the output formats are
in the [CLI reference](/reference/cli#select-run).

## Built-in selections

Two selections exist for every project with no setup:

| Key | What it resolves to |
|---|---|
| `failed` | Tests whose most recent execution failed or timed out. |
| `quarantine-free` | The whole suite minus tests under an active [quarantine](/features/flaky-tests). |

## Defining a selection

Save a selection through the dashboard or the [API](https://piwitests.dev/demo/docs). The `definition` is declarative
JSON: OR-ed `include` groups, minus OR-ed `exclude` groups, then pins, a budget and a limit — applied in that order.

```jsonc
{
  "include": [
    { "tags": ["smoke"] },
    { "priority": ["critical", "high"], "maxAvgDurationMs": 15000 }
  ],
  "exclude": [{ "quarantined": true }],
  "budget": { "maxTotalDurationMs": 300000, "rankBy": "failureLikelihood" },
  "limit": 200
}
```

Within a group every predicate must hold (AND); a test matches `include` if it matches any group (OR). An empty or
absent `include` starts from the whole suite. The predicates, all optional:

| Predicate | Matches when |
|---|---|
| `ids` | the test-case id is one of these |
| `tags` / `anyTags` | the test carries all / any of these tags |
| `owner`, `priority`, `feature` | the `piwi:` annotation is one of these |
| `files` | the file path matches one of these globs (`**`, `*`, `?`) |
| `suitePath`, `text` | the describe chain / title (or file) contains this substring |
| `quarantined`, `flaky`, `neverRun` | the test is (or is not) in that state |
| `minPassRate` / `maxPassRate` | pass rate over executed runs is within bounds (0–1) |
| `minAvgDurationMs` / `maxAvgDurationMs` | average duration is within bounds |
| `lastStatus` | the latest execution's status is one of these |
| `failedInLastRuns` | the test failed within its last _N_ executions (N ≤ 25) |

An unknown predicate is a validation error, not a silent no-op — a typo fails loudly rather than resolving to a wider
set than you meant.

### Budgets and pins

`budget` turns a selection into a knapsack: tests are ranked (`failureLikelihood`, `recentFailure`, `priority`,
`slowest` or `fastest`) and taken until their summed average duration hits `maxTotalDurationMs`. "The best five minutes
of this suite" is an empty `include` plus a budget. `pins` force individual tests in (`add`) or out (`remove`) by test-
case id, on top of whatever the predicates matched. `limit` caps the count last.

## From a Playwright config

To run `PIWI_SELECTION=smoke playwright test` instead of `piwi run`, resolve the selection in an ESM config (it needs
top-level `await`):

```ts
import { defineConfig } from '@playwright/test';
import { wrapConfig, resolveSelection } from '@piwitests/reporter';

const selection = await resolveSelection(); // reads PIWI_SELECTION; undefined when unset
export default wrapConfig(defineConfig({ grep: selection?.grep ? new RegExp(selection.grep) : undefined }));
```

It stamps the run like `piwi run`, and returns `undefined` (so everything runs) when no selection is named or the
dashboard cannot be reached.

## Guard it in CI

`piwi gate --require-selection <key>` catches a smoke job that silently shrank: the dashboard re-resolves the
selection's current definition and fails the build if any test it now matches did not run, or ran and failed.

```bash
npx @piwitests/reporter run smoke                 # run the subset, stamping the run
npx @piwitests/reporter gate --require-selection smoke   # then assert it held
```

It composes with the other [gate](/guide/ci) rules (`--max-new-regressions`, `--fail-on-flaky`, …). A quarantined test is
exempt: quarantine already means "don't gate on this test".

## In the dashboard, and for agents

The project's **Selections** tab lists the built-ins and your saved selections, with a builder that previews what a
definition resolves to (the matching tests, the estimated duration, any warnings and the exact command) before you save
it. Agents use the selection tools of the [MCP server](/reference/mcp-tools#workflow) and the `run-the-right-tests`
skill.

## Health and drift

A selection resolves fresh every time, so the set it runs can change under you: a renamed file drops out of a `files`
glob, a test turns flaky and falls below a `minPassRate`, and the job stays green while covering less. The Selections
tab shows a **drifted** badge when what a selection resolves to now differs from what its last `piwi run` recorded
(the run stamped the hash and count it resolved then), and counts the quarantined tests it carries.

Above the list, a **coverage** line counts the tests that *no* stored selection matches: nothing routine runs them as
a named subset. Built-in selections don't count toward coverage (`quarantine-free` matches almost everything). Agents
get the same data from `analyze_selections`.

## Impact-from-diff

`piwi run impact --base <ref>` runs only the tests your change affects. The reporter diffs the working tree against
`<ref>` (`git diff --name-only`), and the dashboard maps the files to tests through observed edges:

- **Direct**: a changed file that _is_ a test file maps to the tests defined in it.
- **Reach**: a changed support file maps to the tests that failed inside it, per their source frames.
- **Code reach**: a changed application file maps to the tests that executed it
  ([code reach](/features/code-reach)).

It fails safe, widening to the full suite with a warning, when a changed file maps to no test (stylesheets too) or
only through source frames, which miss passing tests. A docs-only change runs nothing.

## Suggestions

Piwi can _propose_ selections and tags from the history it keeps, with the evidence attached, never applied. The
**Suggestions** panel on the Selections tab (and the `suggest_selections` MCP tool) surface three kinds:

- **`@slow` tags**: tests whose average duration is above the suite's 95th percentile.
- **`@feature` tags**: the dominant route family a test hits (say `checkout`) when it carries no `feature` annotation.
- **A mined smoke suite**: a greedy set cover over _observed_ route coverage under a time budget, keeping the test
  that adds the most new routes until the budget is spent. Only stable tests qualify. "Save as selection"
  turns the picks into a selection pinned to exactly those tests.

Coverage here means the routes a test was _seen_ to hit on recent runs, not instrumented code coverage.

## What selections are not

- **Not instrumented test-impact analysis.** Predicates read _observed_ history (durations, pass rates, statuses), not
  a build-time dependency graph.
- **Not a way to hide failures.** [Quarantine](/features/flaky-tests) decides a test's verdict; a selection only decides whether
  it runs. The full suite stays your reference; selections are for the fast loops in between.

## Related

- [Piwi CLI](/reference/cli#select-run): every flag of `select` and `run`
- [CI & sharding](/guide/ci): the gate in a CI job
- [Analytics](/features/analytics#test-filter): filter every number by a selection
- [Flaky tests & quarantine](/features/flaky-tests): what decides a test's verdict
