---
title: Probes
description: "Replay a passing test with one injected fault and record whether it noticed: client probes with piwi probe, the not-noticed gap, and experimental server probes."
lang: en-US
---

# Probes

<Needs reporter fixtures />

[Reach](/guide/concepts#reach) says a test touched a route, not that it would fail if the route returned garbage, and
many passing tests would not. A **[probe](/guide/concepts#probe)** replays a passing test with one fault injected
behind one request and records whether the test noticed. A route that stays green under a fault becomes a
**not noticed** gap: the most dangerous class, because the suite says everything is fine.

<figure>
  <img src="/diagrams/probes-two-levels.svg" alt="Client probes rewrite a response in the browser; server probes sign a fault the backend instrumentation applies inside the server; both record whether the test noticed">
</figure>

## Client probes

`piwi probe` runs the probe plan the dashboard computes for a project:

```bash
npx @piwitests/reporter probe --project my-project
```

It fetches the plan, runs `playwright test` on the tests in it with the [capture fixtures](/guide/capture-fixtures)
in probe mode, and posts each outcome back. The fixtures apply the fault at the Playwright boundary, on the matching
response after the page's first navigation:

| Fault | What the test receives |
|---|---|
| `status-500` | a 500 in place of the response |
| `empty-body` | the right status with an empty body |
| `drop-field` | the JSON body with its first field removed (from each element of an array) |
| `stale-value` | an earlier response to the same request in place of the current one |
| `slow` | the response five seconds late |

The plan pairs each passing test with a route it reaches: pairs never probed come first, then pairs whose test
changed since its last probe, and each test gets one fault per run, up to a budget (50 pairs by default,
`--budget` to change it). Quarantined tests and tests whose last run failed are left out. A fault that did not change
the response records the pair as *inconclusive*, and an inconclusive pair waits a week before it returns to the plan.

A test counts as changed when the source lines its steps run from differ from those of its passing runs before the
probe: an added assertion, an edited helper or a moved line. A new tag or owner does not count, and neither does a
change to the route's handler alone.

A probe run is stamped as one, with retries off. It never counts as a real run: no failure clusters, no regression
signals, no notifications, no pull-request feedback, no metric, no quarantine streak, never the baseline another run is
compared with, and nothing in the Test Map but the probe outcomes. It never moves a pass rate, a duration or the
`failed` selection either, and leaves a test's tags, owner, locks and locator snapshots as they are.
A probed test that notices its fault fails, so a non-zero Playwright exit is expected. The
[CLI reference](/reference/cli#probe) lists every flag.

## What an outcome records

Each outcome is a *checks* edge in the [Test Map](/features/scenario-gaps) between the test and the route: noticed,
not noticed, or inconclusive. The *not noticed* detector reads them: a route with at least one probe that no test
noticed, and none that did, is a **false-comfort** gap:

```
Tests pass when POST /api/orders breaks
A probe (status-500) on POST /api/orders did not make checkout › pay fail. Assert the effect the request should have.
```

The next step is an assertion on what the request is for: the order appears, the total changes, the error shows.
Once a probe on that route is noticed, the gap closes itself.

## Server probes

**Experimental.** Server probes are off by default. The rule for when to turn them on (client probes reporting
*not noticed* on one probed pair in ten) has not been measured yet. The design is in the
[scenario gaps design record](https://github.com/PiwiTests/piwi/blob/main/adr/scenario-gaps.md#level-two--server-probes-m3-on-an-entry-condition).

A client probe rewrites the response in the browser, so the server never runs its error path. A server probe signs a
fault onto one request (`X-Piwi-Probe`, an HMAC signature made with `PIWI_PROBE_SECRET`), and the
[backend instrumentation](/guide/backend-logs#server-probes) applies it inside the server: a thrown error, a status,
a delay, a mutated response or a failed dependency call. The instrumentation reports the fault it applied, so a probe
it did not honor records as *inconclusive*, never as a pass.

Two signals come back: whether the test noticed, as with a client probe, and whether the application coped. An
uncaught page error once the fault applied, or a blank page (no accessible content when the test ends) after a backend
error, makes an **unhandled** finding. A console error, a dialog, a backend error or a blank page alone makes a
**degraded** one. A fault the server never applied makes no finding. Findings rank by severity and reach, and the
*unprobed dependency* detector names the dependencies no probe has failed yet.

It needs:

- the Nitro plugin or the ASP.NET Core package in the application under test, with `PIWI_PROBE_SECRET` set and
  `PIWI_SERVER_PROBES=true`. Both apply faults only outside production. The ASP.NET Core package applies throw,
  status, delay and extreme-value faults; its data and dependency probes record as *inconclusive*;
- the same `PIWI_PROBE_SECRET` where `piwi probe` runs;
- **Server probes** turned on under **Scenario gaps** in the **Capabilities** section of the project's **Settings** tab,
  where the fault classes and routes are allow-listed. Dependency faults on state-changing routes (`POST`, `PUT`,
  `PATCH`, `DELETE`) stay off unless you allow them.

With server probes on, half of the budget goes to server faults.

## Try it in the demo

<DemoExamples />

## Related

- [Scenario gaps & the Test Map](/features/scenario-gaps): the other gap classes, and triage
- [Backend instrumentation](/guide/backend-logs): the packages server probes need
- [Piwi CLI: probe](/reference/cli#probe): every flag
- [Gap detectors & exposure](/reference/gap-detectors): the *not noticed*, *unprobed dependency* and *not handled*
  detectors
