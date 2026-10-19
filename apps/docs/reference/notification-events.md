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
    "branch": "main",
    "environment": "staging",
    "topFailures": [
      {
        "title": "applies discount code",
        "filePath": "tests/checkout.spec.ts",
        "headline": "getByRole('button', { name: 'Pay' }) never became enabled, click timed out after 30 s",
        "errorExcerpt": "TimeoutError: locator.click: Timeout 30000ms exceeded.\nlocator resolved to <button disabled>Pay</button>",
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
