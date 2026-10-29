---
title: Notification events & webhooks
description: "Every notification event Piwi fires, when it fires, and the JSON body a webhook channel receives, with its signature and payload fields."
lang: en-US
---

# Notification events & webhooks

A [subscription](/features/notifications#subscriptions) picks one or more of these events. This page lists when each
one fires and what a webhook channel receives; channels, subscriptions and delivery are on
[Notifications & alerts](/features/notifications).

## Events

| Event | Fires when |
|-------|------------|
| `run.finished` | A run completes (any status) |
| `run.failed` | A run completes with failures |
| `run.failed.default_branch` | A run fails on the repository's default branch |
| `run.interrupted` | A run stops reporting before its end and the stale-run sweep marks it interrupted (two minutes without activity, an hour for a sharded run whose shards send their results in one batch). The payload is a run event's, with `status: "interrupted"` and the results stored so far; Flake Lab and probe runs send none |
| `cluster.new` | A new failure cluster appears |
| `cluster.fixed` | A run passes every test a cluster covers: the fix landed (a filtered re-run of just those tests counts). The payload's `verification` says whether the diagnosis was corroborated (`diagnosis-verified`) or the tests merely stopped failing, and `resolved` whether the triage status was closed automatically |
| `cluster.regressed` | A cluster with a recorded fix fails again; `reopened` says whether a *resolved* cluster was set back to open |
| `flakiness.spike` | A completed run contains flaky tests; the flakiness-threshold filter keeps only rates above N% |
| `perf.regression` | A run is at least 20% slower than the median of the previous five completed runs on the same branch and environment; the regression-% filter raises the bar |
| `diagnosis.completed` | A diagnosis of a cluster, or of one of its failures, is stored: Piwi's (requires an [AI provider](/guide/ai-provider)) or one an agent records. A failure in no cluster sends none |
| `auto_heal.pr_opened` | [Auto-heal](/features/auto-heal) opened a pull request; the payload carries `prNumber`, `prUrl`, `branch` and `editCount` |
| `environment.incident` | A completed run is flagged as an [environment incident](/features/environment-incidents); it replaces the run's `run.failed`, `run.failed.default_branch`, `flakiness.spike`, `perf.regression`, `cluster.new` and `bug.looks_fixed` (`run.finished` still fires). The payload carries `rule`, `reason`, `host`, `otherProjects` and `incidentKey`, which is the same for every run of one outage across projects, so a channel receives one message. A subscription filtered on owners does not receive it |
| `bug.looks_fixed` | A `test.fail()` test passed in a completed run, in every browser project that ran it, and did not already pass on the previous completed run of the same branch; the payload lists the `tests`, each with the bug report (`bugId`, from `piwi:bug`) and ticket (`link`) it names |

**`report.ready`** needs no subscription: a [report schedule](/features/quality-reports#report-schedules) sends it to
the channels it names, through the same outbox. Its webhook body adds the whole report:
`{ "event", "payload": { "snapshotId", "scheduleId", "periodEnd", "url" }, "bundle", "timestamp" }`.

## Webhook body

A webhook channel receives a `POST` with the body `{ "event": "run.failed", "payload": { … }, "timestamp": "…" }`.
For run events the payload includes up to three failing tests, so you can act without a round-trip to the dashboard:

```json
{
  "event": "run.failed",
  "payload": {
    "runId": 42,
    "projectName": "checkout",
    "status": "failed",
    "totalTests": 120,
    "failedTests": 3,
    "passedTests": 114,
    "flakyTests": 2,
    "skippedTests": 3,
    "didNotRunTests": 0,
    "failingTestCount": 3,
    "branch": "main",
    "environment": "staging",
    "commit": {
      "sha": "3f9c2a1d8e7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d",
      "message": "Validate the card number before enabling Pay",
      "author": "Alex Martin",
      "url": "https://github.com/acme/checkout/commit/3f9c2a1d8e7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d"
    },
    "ciUrl": "https://github.com/acme/checkout/actions/runs/123",
    "origin": "ci",
    "history": [
      { "runId": 40, "status": "passed", "failedTests": 0 },
      { "runId": 41, "status": "passed", "failedTests": 0 },
      { "runId": 42, "status": "failed", "failedTests": 3 }
    ],
    "topFailures": [
      {
        "title": "applies discount code",
        "suitePath": ["Checkout", "Payment"],
        "filePath": "tests/checkout.spec.ts",
        "line": 38,
        "browserName": "chromium",
        "owner": "@acme/payments",
        "headline": "getByRole('button', { name: 'Pay' }) never became enabled, click timed out after 30 s",
        "errorExcerpt": "TimeoutError: locator.click: Timeout 30000ms exceeded.\nlocator resolved to <button disabled>Pay</button>",
        "source": {
          "file": "tests/checkout.spec.ts",
          "line": 42,
          "snippet": "    41 |   await page.getByLabel('Code').fill('SAVE10');\n>   42 |   await page.getByRole('button', { name: 'Pay' }).click();\n    43 | });"
        },
        "history": ["passed", "passed", "failed"],
        "testCaseId": 815,
        "executionId": 9001
      }
    ]
  },
  "timestamp": "2026-07-11T10:00:00.000Z"
}
```

`headline` is the one-line explanation the dashboard builds from the Playwright error (the locator, its last state,
the expected and received values, the timeout; see [Failure evidence](/features/evidence#one-execution-diagnosis-first)),
absent when the case carries no error. `errorExcerpt` is the error's message head: at most five lines before the call
log and the stack trace, capped at 300 characters, plus the last `waiting for …` line when the head is only a bare
timeout. Slack and email messages lead with the headline, quote the excerpt and link each failure to its execution.
The [pull-request comment](/features/pr-feedback) quotes failures the same way.

A test is failing when the last attempt of one of its repetitions failed: a test that passed on a retry counts as flaky,
never as a failure. `topFailures` names the first three, `failingTestCount` counts them all, each test once per
Playwright project however many of its `--repeat-each` repetitions failed (`failedTests` counts each failed repetition),
and `owners` covers every failed attempt, so a team hears of its flaky test's failed first attempt. Each failure names its describe blocks (`suitePath`), the line it is declared on, its Playwright project
(`browserName`) and its `owner`. `source` holds the lines around the line the failure threw at, as the reporter
captured them: the test file, or the helper the error's stack points at, from four lines before it to two after, the
failing line marked `>`.

`origin` is what launched the run: `ci`, `local`, `desktop`, … ([run origin](/reference/test-metadata#run-origin)).

`history` lists the run and up to nine runs before it on the same branch and environment, oldest first: the ended runs
that would send notifications themselves (no lab run, no run from an editor, no bisect step or reproduction, no
partial run from a developer's machine or the desktop app, no environment incident). Each failure's `history` gives that test's outcome in each of those runs (`passed`, `flaky`, `failed`,
`skipped`, `didnotrun` for a test that did not run or was interrupted, or `null` when the run did not report it). `commit`
comes from the run's Git metadata, linked when the project's repository host is known, and `ciUrl` from its CI
metadata.

## Emails

Every event has its own email. A run's email opens with its outcome in large type, then a bar of its tests by outcome,
its `history` as a row of squares with what it says (_First failure after 6 passing runs_), the commit and the CI
build. Each failure in `topFailures` shows its full name with its describe blocks, its file and line, its `source`
syntax-highlighted with the failing line marked, its error with the expected and received values in color, and its own
`history`, which tells a new failure from one that keeps coming back. A digest lists each event with its run's outcome
bar.

## Slack and Microsoft Teams

A Slack message heads with the email's headline and keeps the rest in an attachment whose side stripe takes the
event's color: the run's tests by outcome and its `history` as rows of colored squares, the commit, the CI build and the
owners as fields, then each failure with its describe blocks, its file and line, its `source` with the failing line
marked, its error and its own `history`, and buttons to the run and the build. A Slack-compatible server (Mattermost,
Rocket.Chat) shows the message's text line, and none of its blocks.

A Microsoft Teams card sets the headline on a band of the event's color and draws the outcomes as a stacked bar chart.
Each failure's code goes in a code block Teams colors by language, and its error's expected and received lines are green
and red. Where a Teams client draws no chart or code block (the mobile app), the card shows the same squares and
numbered lines instead.

## Payload fields by event

Every event that comes from a run carries that run's `branch` and `environment` when the run reported them: the
`run.*` events, `flakiness.spike`, `perf.regression`, the `cluster.*` events and `bug.looks_fixed`. A subscription's
[branch and environment filters](/features/notifications#branches-and-environments) match on these two fields.

- **Run events** (`run.*`, `flakiness.spike`, `perf.regression`): the run, its counts, `topFailures`, and the `owners`
  of the failing tests. `perf.regression` adds `durationMs`, `baselineDurationMs` and `regressionPct`.
- **`cluster.new`**: the cluster's `signature` and `title`, `sampleErrorExcerpt` (cut like `errorExcerpt`),
  `affectedCases`, and the `owners` of the tests that failed into it in that run.
- **`cluster.fixed`** and **`cluster.regressed`**: the cluster's `signature`, `title` and the `runId` that decided the
  verdict; for a fix, the `commit` and `timeToResolutionMs`. With an [SCM token](/guide/source-control), a `fixAuthor`
  object (`{ name, email }`) names the author of the fixing commit (for a regression, of the fix that did not hold).
  A fix landed by an [auto-heal PR](/features/auto-heal#after-the-pr-opens) carries `healPr` (`{ number, url, actionId }`).
- **`diagnosis.completed`**: the cluster, and the diagnosis's `summary`, `rootCause`, `category` and `confidence`. A
  diagnosis of one failure in the cluster adds its `executionId`, and the notification opens that failure.

A `cluster.*` event also carries `knownIssue` (`{ key, url }`) when the cluster is linked to a tracker issue.

## Verifying a webhook

Each request is signed with an HMAC-SHA256 `X-Piwi-Signature` header derived from the channel's secret, so you can
verify that Piwi sent it. To check the HMAC, sign the exact bytes you received, never a re-serialized payload. Webhook
secrets are encrypted at rest.

## Related

- [Notifications & alerts](/features/notifications): channels, subscriptions, digests and SMTP
- [Failure clusters & the inbox](/features/failure-clusters): what triggers `cluster.new`, `cluster.fixed` and `cluster.regressed`
- [AI diagnosis](/features/ai-diagnosis): what triggers `diagnosis.completed`
- [Quality reports](/features/quality-reports#report-schedules): the schedules that send `report.ready`
