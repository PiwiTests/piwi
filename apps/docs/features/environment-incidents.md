---
title: Environment incidents
description: "How Piwi recognizes a run that failed because the app under test was down, and keeps it out of flaky scores, baselines, fix verification and the CI gate."
lang: en-US
---

# Environment incidents

<Needs reporter />

When the environment under test is down, every test fails at once: staging refuses connections, a DNS name stops
resolving, the browser crashes on a starved runner. None of those failures says anything about the tests or the code.
Piwi recognizes such a run as an **environment incident**, says so on the run page, and keeps it out of every verdict
that compares runs.

![A run flagged as an environment incident: the reason, the rule that decided, and the action to clear the flag](/screenshots/environment-incident.png)

## How a run is recognized

When a run finishes, Piwi reads what it already stored: how many tests failed, what each failure was doing, and the
host of the run's Playwright `baseURL`. A run is flagged by one of three rules:

| Rule | Flags the run when |
|---|---|
| `host-unreachable` | At least 80% of the executed tests failed, and at least 70% of the failures were navigating or connecting to the app's host |
| `browser-crash` | At least 80% of the executed tests failed, and at least 70% of the failures were the browser crashing or closing |
| `cross-project` | At least 50% of the executed tests failed, most failures reached the app's host or share one error, and the same host or error failed in another project's run that started within 30 minutes |

A failure counts as reaching the host when it is a network error (`net::ERR_CONNECTION_REFUSED`, a name that does not
resolve, a reset connection, `ECONNREFUSED` from a request fixture) or a `page.goto` that timed out, and the address
it names is the host of the run's `baseURL`. With no `baseURL` recorded, the host most failures reached stands in for
it.

A failure whose error names no such address also counts when the network capture of its execution (recorded by the
[capture fixtures](/guide/capture-fixtures)) holds a request to the `baseURL` host that got no answer: a network error
such as a refused connection, or a `502`, `503` or `504` from a gateway in front of the app. That catches an API that
is down behind a page that still loads, where the tests fail on assertions. A `500` is the app answering, and an
aborted route (`net::ERR_FAILED`) is the test's own doing, so neither counts. Piwi reads the capture of at most 500
failing executions per run, and a failure whose capture it did not read counts as not reaching the host.

A third-party host going down (a CDN, an analytics script) does not count, and neither does a failing assertion whose
requests were answered, however many tests it breaks: a login page broken by a commit is a regression, not an
incident. A run with fewer than three failing tests is never flagged.

A [probe](./probes) or [Flake Lab](./flake-lab) run is never judged: it injects its failures on purpose.

## What a flagged run changes

- **The run page** says *Environment incident · not counted*, the reason (*41 of 44 tests failed, 39 of them
  navigating or connecting to staging.example.test (connection refused)*), and which rule decided.
- **Flaky scores, baselines, fix verification, the selection catalog, the editor's CI failures and auto-heal** leave
  the run out. A test that failed only in the incident does not become flaky, does not lose its last green run, and
  does not count as a regression. The run gets no regression signals.
- **One timeline marker** in the `incident` category, labeled *Environment incident: staging.example.test* and linked
  to the run, so the gap on the trend charts has a visible cause (unless `PIWI_AUTO_MARKERS=false`). See
  [Timeline markers](./timeline-markers).
- **One notification**, [`environment.incident`](/reference/notification-events), in place of the run's failure,
  flakiness, performance and new-cluster events. It goes to the project's subscribers, not to a subscription scoped to
  test owners. `run.finished` still fires. When one outage flags runs in several projects, a channel that hears from
  all of them receives one message.
- **The failure inbox** on Home shows one row for the run instead of one row per new cluster it opened. Clusters that
  were already open before the incident keep their rows.
- **No AI diagnosis and no pull-request comment** are produced for the run.

The run's history stays: its executions, evidence and clusters are kept like any other run's, and analytics still
count it as a failed run.

## The CI gate

[`piwi gate`](/reference/cli#gate) gives a flagged run the verdict **inconclusive**, distinct from a pass and a fail,
whatever the policy says. It exits with code `3`, so a pipeline can tell "the environment was down, re-run" from "the
change broke something" (`1`):

```text
? Piwi gate inconclusive — checkout run #930
  41 tests, 41 failed, 0 new, 0 newly flaky, 0 flaky
  ? The run is an environment incident: 41 of 44 tests failed, 39 of them navigating or connecting to staging.example.test (connection refused).
  Re-run once the environment is back, or clear the flag on the run page if it is wrong.
```

The gate's JSON result carries `verdict: "inconclusive"`, `passed: false` and the incident under `facts.incident`, so
a client that reads only `passed` still blocks the merge.

## Stopping a run before it starts

With the reporter option [`checkBaseUrl`](/reference/reporter-options#checkbaseurl), the reporter checks that each
`baseURL` of the run's projects answers before any worker starts. When one does not (a refused connection, a name
that does not resolve, no answer in 10 seconds, or a `502`, `503` or `504`, on each of three tries), the run stops
with a message naming it and Playwright's failure exit code. No test runs, so the outage costs no CI time, and no run
reaches the dashboard. The option is off by default, and the check runs before the config's own `globalSetup`, so
leave it off when that setup is what starts the app.

The check runs from the machine that runs Playwright. A browser on a grid (`connectOptions`) reaches the app from the
grid's network instead, unless the `exposeNetwork` rule covers the app's host and port. For such a base URL, the reporter says
so: in the stop message when the check fails, and in a line of the run's output when it passes. A run whose tests then
fail to navigate may have hit a gap between the two networks rather than an app that is down.

## Marking and clearing by hand

The rules can miss an outage or flag a real regression. Anyone who can upload or control the project's runs
(Uploader, Maintainer and above) can decide instead:

- **Mark as an environment incident**, in the run header's **Details**, for a run the rules did not flag (the payment
  sandbox was down, a shared account was locked). The run is left out of the same verdicts and gets its marker.
- **Clear the flag**, on a flagged run, when its failures are real. The incident marker is removed and the run counts
  again: its regression signals are computed, and it feeds flaky scores and baselines from then on.

Either decision is kept on the run, and finalizing the run again (a late shard, a report upload) never overrides it.
The run page says who decided. The same action is in the [API reference](https://piwitests.dev/demo/docs), and an
agent makes it with the MCP tool [`set_run_incident`](/reference/mcp-tools#set_run_incident), which needs a key whose
owner may make the same change in the dashboard and is kept in the [write log](./mcp).

## Limits

- The check runs once, when the run finishes. A run in another project that finishes later is compared with this one
  and names it, but this run's flag is not revisited.
- An incident that hits only part of the suite (one service down, 30% of the tests failing) stays below the
  thresholds: mark it by hand.
- Clearing or marking a run after it finished does not send the notifications it skipped, or withdraw the ones it
  sent.

## Try it in the demo

<DemoExamples />

## Related

- [Flaky tests & quarantine](./flaky-tests): the scores an incident leaves alone
- [Notification events & webhooks](/reference/notification-events): `environment.incident` and its payload
- [Piwi CLI](/reference/cli#gate): the gate's exit codes
- [Reporter options](/reference/reporter-options#app-under-test): `checkBaseUrl`
- [Timeline markers](./timeline-markers): the `incident` category
- [Concepts](/guide/concepts#environment-incident): the term
