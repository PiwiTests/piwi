---
title: CI merge gate
description: "What piwi gate decides about a Playwright run: the rules that fail a merge, the ones that only warn, what it leaves out, and how its verdict reaches the pull request."
lang: en-US
---

# CI merge gate

<Needs reporter />

The CI merge gate fails a CI job on the dashboard's analysis of a run, not on Playwright's exit code. `npx playwright
test` exits non-zero when anything failed; whether the change broke something that was working, whether a critical
test failed or a new root cause appeared needs the run history, so the dashboard evaluates a policy the pipeline
declares and `piwi gate` turns its verdict into an exit code. The reporter never fails a build on its own: the policy
belongs to the pipeline.

## Turn it on in CI

Record which run to gate on, then run the gate after the tests, whatever their outcome:

```yaml
- run: npx playwright test
  env:
    PIWI_DASHBOARD_URL: https://piwi.example.com
    PIWI_OUTPUT_FILE: piwi-run.json

- run: npx @piwitests/reporter gate --require-tag @critical --max-new-regressions 0
  if: always()
  env:
    PIWI_DASHBOARD_URL: https://piwi.example.com
    PIWI_API_KEY: ${{ secrets.PIWI_API_KEY }}
```

The full recipe and the output a failed gate prints are in [CI & sharding](/guide/ci#blocking-a-merge); every flag,
default and exit code is in the [CLI reference](/reference/cli#gate). The policy needs at least one rule or one
warn-only flag, or the gate refuses to run.

## What fails it

Each flag is one rule, and the gate evaluates every rule it was given, so a failed verdict lists everything that is
wrong, not only the first rule to trip. The rules bound:

- **Failures**: the tests that failed for good (`--max-failed`), counted once per test however many Playwright
  projects or attempts failed it; a test that passed on a retry did not fail.
- **New regressions and newly flaky tests** (`--max-new-regressions`, `--max-new-flaky`): tests failing now that
  passed in the [baseline](/guide/concepts#baseline-last-green-run), and tests that started passing only on a retry.
- **Required tests**: every test carrying a tag (`--require-tag`) must pass, a pass on a retry included. A tag no test
  of the run carries is a violation in itself, so a misspelled tag cannot pass.
- **A selection** (`--require-selection`): the dashboard resolves the
  [selection](/features/test-selection#guard-it-in-ci)'s current definition and fails when a test it matches did
  not run, was only skipped, or failed. A selection that matches no test fails too.
- **Flakiness** (`--fail-on-flaky`): any test of the run that passed after an earlier attempt failed.
- **New failure clusters** (`--fail-on-new-cluster`): a [cluster](/features/failure-clusters) first seen in this run.
- **Quarantine debt** (`--max-quarantined`): how many tests the project holds in quarantine, whatever this run did.
- **Leaks** (`--max-leaks`, `--max-new-leaks`): the browsers, contexts and pages the run left open, counted per
  opening line, and those no earlier run of the base branch showed ([leak history](/features/leak-history)). A run
  that sent no resource report (the capture fixtures missing, `captureResources` off, or a reporter older than 0.45)
  fails a leak rule rather than passing on silence, and so does a run of a project that
  [declined](/operate/capabilities#declining-a-capability) the Resources capability, whose leaks are not measured.
- **Pass reuse** (`--max-reused`, `--require-executed`): how many tests the run [reused](/features/reuse-forecast#skipping-reusable-tests)
  from earlier passes, by count or share, and the tags whose tests must have executed. In a run that passed with no
  run error, a reused test counts as passed for `--require-tag` and `--require-selection`, unless a
  `--require-executed` tag names it. A run that claimed a plan whose reused tests could not be recorded fails every
  reuse rule.

## What only warns

Two flags report and never fail: they change neither the verdict nor the exit code.

- `--max-uncovered-changes <n>` warns when more than *n* changed files are
  [uncovered changes](/features/uncovered-changes), naming up to five of them.
- `--min-patch-coverage <percent>` warns when fewer of the change's added and modified lines ran in the head commit's
  [combined coverage](/features/combined-coverage), or when that coverage counts none of them.

Either warns too when the run has no source control diff to count, or when reading the change failed. Without them,
the gate ignores uncovered changes.

## What it leaves out

- **Quarantined tests.** A [quarantined](/features/flaky-tests#quarantine-with-a-way-out) test still runs and reports,
  and the gate says how many failing tests quarantine excluded. It counts toward no failure, new regression, newly
  flaky, required tag or selection rule. `--fail-on-flaky` reads the run's flaky count and `--fail-on-new-cluster` its
  new clusters, quarantined tests included.
- **Environment incidents.** A run flagged as an [environment incident](/features/environment-incidents), by its
  rules or by hand, gets the verdict **inconclusive** whatever the policy, with no violation listed: its failures say
  nothing about the change. The gate exits `3`, so a pipeline can re-run instead of blaming the change.
- **Runs it does not judge.** A run still running or in its global setup is refused, and so is a run the caller cannot
  see, such as another person's [run requested from the dashboard](/reference/test-metadata#run-origin): the gate
  exits `2`, as it does when it cannot reach the dashboard, so a broken pipeline never passes. Any other run is judged
  as it is, whatever launched it.

## The verdict

The gate prints one summary line of counts, each violation, each warning and the run's link. With `--json` it prints
the result instead: `verdict` (`passed`, `failed` or `inconclusive`), `passed`, `violations` (each with a stable
`rule` id a pipeline can branch on, its message, and for a threshold the value and the limit), the measured `facts`
and any `warnings`. An inconclusive result carries `passed: false` and the incident under `facts.incident`, so a client
that reads only `passed` still blocks the merge. Evaluating never changes the run.

## On the pull request

An evaluation made with a key that can upload or control the project's runs (Uploader, Maintainer and above, the CI
key `piwi gate` uses) is stored with its policy, its verdict, its violations and warnings, and the pull request it
judged. Any other reader of the project gets the verdict only: nothing is stored or posted.

- **A commit status of its own.** Turn on **Gate status** under the project's **Settings → Source control**, and each
  stored verdict is also posted as your status context plus `/gate` (`piwi/tests/gate`): green with *Gate policy
  satisfied*, red with the first violation. A branch rule can then require the gate rather than the run. It needs
  [pull-request feedback](/features/pr-feedback#turn-it-on) on, with **Set a commit status**, and `PIWI_SITE_URL`
  set, since the status links the run. An inconclusive verdict posts nothing.
- **Overrides and escapes.** Every ten minutes Piwi asks the host what became of the pull requests a gate failed on.
  One merged while its last evaluation still failed counts as an override; one fixed first, or closed, does not. When
  a cluster that evaluation caught as a new regression fails again on an eligible default-branch run within 30 days
  of the merge, the override also counts as an escape past the gate.

The pull-request comment reports a run's failures; it never blocks a merge. The gate does.

## Related

- [CI & sharding](/guide/ci#blocking-a-merge): the gate in a CI job, and its output
- [Piwi CLI](/reference/cli#gate): every flag, default and exit code
- [Pull-request feedback](/features/pr-feedback): the comment and commit status of a run
- [Flaky tests & quarantine](/features/flaky-tests#quarantine-with-a-way-out): what quarantine leaves out
- [Environment incidents](/features/environment-incidents): the runs the gate calls inconclusive
