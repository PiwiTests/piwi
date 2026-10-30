---
title: Stuck tests
description: 'A running test that has run far longer than its passing runs took is marked Stuck? on its run page, and a test.stuck notification goes out once per attempt, with no viewer and no live view needed.'
lang: en-US
---

# Stuck tests

<Needs reporter />

A CI run that never ends is often one test waiting on something that will not come: a button that stays disabled, a
page that never loads, a lock never released. Piwi says so while the run is still going. A running test that has run
far longer than it usually does is marked **Stuck?** on its run page, and a `test.stuck` notification goes to the
project's channels. Nobody needs to have the run open, and the [live view](./live-view) does not need to be on.

## When a test is stuck

The dashboard checks the running tests of its live runs every 15 seconds. A test is stuck when its current attempt has
run longer than both:

- two minutes, whatever the test usually takes;
- three times its longest duration among its last ten passing executions on the same browser.

A test needs two passing executions on that browser before any attempt of it can be stuck: a new test is never
flagged. The executions read are the ones a baseline reads, so no Flake Lab or investigation run and no environment
incident. The time counts from the start the attempt's begin event names, else from when the dashboard heard it begin; the
reporter's begin events name none.
Each attempt is said to be stuck once; a retry is a new attempt.

The question mark is meant: a test can be slow for a good reason, a large import or a cold cache. The rule says only
that this attempt is far outside what its passing runs took.

## On the run page

A stuck test's row on the run page's **Tests** tab carries a **Stuck?** badge, how long it has run and the longest
its last passing runs took: `Running for 7 minutes, usually 41.2s at most`. The row's live step names the step it is
in. With the project's [live view](./live-view) on, **Watch** shows its page and, in a CI run, what its current call
waits for. The badge leaves the row when the attempt ends.

A page opened after the test was said to be stuck shows it too: the dashboard keeps it with the running test.

## The notification

`test.stuck` fires once per attempt, through the channels of the project's
[subscriptions](./notifications#subscriptions) that chose it. Its message names the test, how long it has run against
its usual time, the run with its branch and environment, the browser and worker, and the test's owner. Its button opens
the run with its **Tests** tab searched for the test. The payload is on
[Notification events & webhooks](/reference/notification-events#payload-fields-by-event).

The branch, environment, owner and **Default branch only** filters apply to it. A run that sends no notification sends
none: a run from an editor, a bisect step, a reproduction, or a partial run from a developer's machine or the desktop
app.

## Limits

- **A live run on this dashboard.** The running tests are kept in the memory of the server the run reports to, as the
  run's live events are. A dashboard that restarts forgets them until each test's next attempt begins, and it needs one
  dashboard server ([Resource requirements](/operate/deployment#resource-requirements)).
- **Fixed thresholds.** Two minutes and three times the longest pass are the same for every project.
- **No history, no verdict.** A test with fewer than two passing executions on its browser is never said to be stuck.

## Related

- [Live view of a run](./live-view): watch a stuck test's page and what it waits for
- [Notifications & alerts](./notifications): channels and subscriptions
- [Notification events & webhooks](/reference/notification-events)
