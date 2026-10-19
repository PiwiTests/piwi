---
title: CI & sharding
description: "Run the reporter in CI: GitHub Actions, GitLab and others, shards merged into one run, the run URL for later steps and the merge gate."
lang: en-US
---

# CI & sharding

There is no Piwi-specific step to add to CI: the reporter runs inside `npx playwright test` and pushes results as they
happen. You set two environment variables.

```yaml
env:
  PIWI_DASHBOARD_URL: https://piwi.example.com
  PIWI_API_KEY: ${{ secrets.PIWI_API_KEY }}   # only if authentication is enabled
```

Everything else — branch, commit, author, workflow, build URL, shard index — is
[detected automatically](#what-gets-detected).

## GitHub Actions

```yaml
name: e2e
on: [push]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test
        env:
          PIWI_DASHBOARD_URL: https://piwi.example.com
          PIWI_API_KEY: ${{ secrets.PIWI_API_KEY }}
```

The shallow clone `actions/checkout` makes is fine: Piwi reads diffs from your Git host's API
([Source control](./source-control)), not from the checkout.

## GitLab CI

```yaml
e2e:
  image: mcr.microsoft.com/playwright:v1.61.1-noble   # at or above the reporter's peer range
  script:
    - npm ci
    - npx playwright test
  variables:
    PIWI_DASHBOARD_URL: https://piwi.example.com
    PIWI_API_KEY: $PIWI_API_KEY
```

## Other systems

Jenkins, CircleCI, Azure DevOps, Travis, Buildkite, TeamCity, Bitbucket, Semaphore, AppVeyor and Drone
are recognized too; set the same two variables. An unrecognized CI means less auto-filled metadata.

## What gets detected

Unconfigured, the reporter records:

- **Source control**: commit SHA, message, author, branch, pull-request number, the pull request's target branch,
  and the repository URL. On a pull-request build the target branch is recorded as the run's **base branch**, which
  [baselines](/guide/concepts#baseline-last-green-run) fall back to when the branch has no history of its own.
- **CI**: provider, workflow or job name, build number, and a link back to the CI build.
- **Origin**: [what launched it](/reference/test-metadata#run-origin).
- **Environment**: the Playwright version, and each test's browser and viewport.
- **Shard index**: from Playwright's own `--shard` config.

[Test metadata](/reference/test-metadata#scm-information-git) lists the variables each field comes from.
`PIWI_BRANCH` and `PIWI_BASE_BRANCH` override the resolved branches; `collectScmInfo: false` or
`collectCiInfo: false` turns a collector off.

## Sharding

Playwright's `--shard=1/3` splits a suite across parallel jobs. Piwi merges them back into **one run**.

```yaml
strategy:
  matrix:
    shard: [1, 2, 3]
steps:
  - run: npx playwright test --shard=${{ matrix.shard }}/3
    env:
      PIWI_DASHBOARD_URL: https://piwi.example.com
      PIWI_API_KEY: ${{ secrets.PIWI_API_KEY }}
```

How the merge works:

1. Each shard derives a **run label**, a stable identifier for the CI pipeline, from the provider's build id
   (`GITHUB_RUN_ID` with `GITHUB_RUN_ATTEMPT`, `CI_PIPELINE_ID`, `CIRCLE_WORKFLOW_ID` and their equivalents on the
   systems listed above). A re-run of a GitHub Actions workflow is a new attempt, so it starts a new run.
2. Shards sharing a run label **and** a `projectName` resolve to the same run, streamed or batched.
3. The run stays `running` until the **last** shard reports; batched shards may arrive an hour apart.
4. Counters accumulate across shards. The run is `failed` if any shard reported a failure, and the run page shows a
   shard progress badge (`2/3`) while shards are arriving.

**All shards must use the same `projectName`.** That's the one requirement.

Jobs sharded with `piwi run --shard` merge the same way ([details](/features/test-selection#print-shard-and-reorder)).

If your CI isn't detected, set the label yourself to anything common to all shards:

```typescript
['@piwitests/reporter', {
  serverUrl: 'https://piwi.example.com',
  projectName: 'my-project',
  runLabel: process.env.BUILD_TAG || 'my-custom-label',
}]
```

### Parallel jobs in one pipeline

A job that is not sharded adds the CI job's id (`GITHUB_JOB`, `CI_JOB_ID`, …) to its run label, so a GitLab
`e2e:chrome` and `e2e:firefox` reporting to one `projectName` stay two runs. The legs of a GitHub Actions matrix
share one job id, and Jenkins, TeamCity and Drone expose none: give each leg its own label, or its own `projectName`.
A configured label is used as it is, so the shards of a leg still merge:

```yaml
PIWI_RUN_LABEL: ${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.browser }}
```

## Watching a run while CI is still going

Streaming is on by default: the run fills in test by test, so a failure's trace is readable before the pipeline
ends ([Live streaming](./reporter#live-streaming)).

## Getting the run URL back out of CI

Later pipeline steps can pick up the run URL. Every channel is best-effort: a failure is logged and never fails
your run.

**Always** — one line per failed test, printed the moment its final attempt fails, then a
`View run: <url>` line once the run lands:

```
[Piwi Dashboard] ✗ applies the discount code — getByRole('button', { name: 'Pay' }) never became enabled — click timed out after 30 s → https://piwi.example.com/test-runs/42/locate?file=tests%2Fcheckout.spec.ts&title=applies%20the%20discount%20code&retry=1&browser=chromium
[Piwi Dashboard] View run: https://piwi.example.com/test-runs/42
```

Between the title and the link is the failure's one-line [headline](./first-failure). The per-test link opens the
failing execution's page, even while the run is still going.

**GitHub Actions (automatic)** — step outputs, a job summary listing the failed tests with their links
(20 at most, the rest counted as "+N more"), and a `::notice::` annotation:

```yaml
- run: npx playwright test
  id: e2e
  env:
    PIWI_DASHBOARD_URL: https://piwi.example.com
- run: echo "Results: ${{ steps.e2e.outputs.piwi_run_url }}"
  if: always()
```

Available outputs: `piwi_run_url`, `piwi_run_id`, `piwi_run_status`, `piwi_failed_count`, `piwi_project_id`.

**GitLab CI (automatic)** — a dotenv report (`piwi.env` by default, override with `PIWI_DOTENV_FILE`)
carrying `PIWI_RUN_URL`, `PIWI_RUN_ID`, `PIWI_RUN_STATUS`, `PIWI_FAILED_COUNT`, `PIWI_PROJECT_ID` and
`PIWI_CI_BUILD_URL`.
Declare it so later jobs inherit the variables:

```yaml
e2e:
  script:
    - npx playwright test
  artifacts:
    reports:
      dotenv: piwi.env
```

**Any other system** — set `outputFile` (or `PIWI_OUTPUT_FILE`) and read the JSON:

```yaml
- run: npx playwright test
  env:
    PIWI_OUTPUT_FILE: piwi-run.json
- run: cat piwi-run.json   # { runUrl, runId, projectId, projectName, status, ciBuildUrl, failedCount, failures }
```

`failures` lists every test whose final attempt failed as `{ title, file, retry, browser, headline, url }`, with
`url` the same per-test link the log prints.

## Pull-request feedback

Piwi can post a summary comment and a commit status on the pull request, and re-run a failure cluster's tests in CI:
see [Pull-request feedback & re-run](/features/pr-feedback).

## Blocking a merge

`npx playwright test` exits non-zero when anything failed. *Did this change break something that was working* needs
the run history, so the dashboard evaluates it.

```yaml
- run: npx playwright test
  env:
    PIWI_DASHBOARD_URL: https://piwi.example.com
    PIWI_OUTPUT_FILE: piwi-run.json      # records which run to gate on

- run: npx @piwitests/reporter gate --require-tag @critical --max-new-regressions 0
  if: always()
  env:
    PIWI_DASHBOARD_URL: https://piwi.example.com
    PIWI_API_KEY: ${{ secrets.PIWI_API_KEY }}
```

The command reads the run id from `PIWI_OUTPUT_FILE` (or `--run-id`, or `./piwi-run.json`) and prints each violation.

| Rule | Fails the build when |
|---|---|
| `--require-tag <tags>` | Any test carrying one of these tags failed |
| `--max-failed <n>` | More than `n` tests failed |
| `--max-new-regressions <n>` | More than `n` tests newly started failing versus the last green run |
| `--max-new-flaky <n>` | More than `n` tests newly started passing only on retry |
| `--max-quarantined <n>` | More than `n` tests are [quarantined](/features/flaky-tests#quarantine-with-a-way-out) — a ceiling on quarantine debt |
| `--fail-on-new-cluster` | This run introduced a failure cluster never seen before |
| `--fail-on-flaky` | Any test passed only after a retry — stricter than `--max-new-flaky`, which counts tests *newly* flaky |
| `--max-leaks <n>`, `--max-new-leaks <n>` | More than `n` [leaks](/features/resource-leaks#in-ci), or new leaks |

At least one rule is required. Exit codes are part of the contract:
**0** satisfied, **1** violated, **2** could not evaluate, so a misconfigured pipeline never passes,
**3** [inconclusive](/features/environment-incidents).

Four behaviors worth knowing:

- **A quarantined test does not count** toward `--max-failed`, `--max-new-regressions`, `--max-new-flaky`,
  `--require-tag` or `--require-selection`, and the gate reports how many failures it excluded.

- **A test that passed on retry satisfies `--require-tag`.** `--max-new-flaky` covers flakiness.
- **A required tag that matches no test is a violation**, so a typo cannot pass.
- **The CI key's evaluations are stored**, so [merges overriding a failed gate](/features/pr-feedback#the-gate-verdict)
  are counted; a read-only key gets the verdict only.

`npx @piwitests/reporter gate --help` lists every option; `--json` prints the raw result for a pipeline to parse.

## Notifying people instead

To tell the team when main goes red, use a [notification subscription](/features/notifications): the rules live
in one place, not in every pipeline.

## Troubleshooting

**Results don't appear.** Check the CI log for the reporter's own output; run with `PIWI_VERBOSE=true`
for the full request trace. The usual causes are a `PIWI_DASHBOARD_URL` the runner cannot
reach, or a missing API key while authentication is on.

**Shards create several runs instead of one.** The run label wasn't detected, the shards disagree on
`projectName`, or streaming is off. Set `runLabel` explicitly.

**Traces or screenshots are missing.** Playwright records neither by default, so there is nothing to upload. Set
`use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }` in your Playwright config, or install through
[`wrapConfig`](./reporter#installing-via-wrapconfig), which sets both when they are unset.

**A run is stuck as `interrupted`.** A run silent for two minutes (a cancelled job, a killed runner, a dropped
network) is marked `interrupted` until its next event revives it. A run still uploading its report (`finalizing`) waits
ten minutes, then keeps the status the reporter sent. [Analytics](/features/analytics#scope) counts interrupted runs as
failing; **full runs only** drops only partial runs.

## Related

- [Reporter](./reporter): setup, streaming and authentication
- [Pull-request feedback & re-run](/features/pr-feedback): the result on the pull request
- [Test tags](/reference/test-metadata#test-tags): what `--require-tag` matches on
- [API keys](/operate/api-keys): the key CI uses
