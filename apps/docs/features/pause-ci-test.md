---
title: Pause a CI test
description: "Someone who may control the project's runs pauses a CI test they watch before its next call, then resumes it or ends it, as a local run's Pause does: off by default, beside Hold a failing CI test."
lang: en-US
---

# Pause a CI test

<Needs reporter fixtures />

A CI test that waits on an element goes past the moment worth seeing before anyone can look at it. With this setting
on, a Maintainer or a Project admin who watches a CI worker in the [live view](./live-view) can **Pause** its test
before its next call, look at the page as it stands, [inspect](./live-inspect) it, then **Resume** it or **End the
test**: a local run's controls, on a test running in CI.

## Turn it on

A Project admin turns on **Let controllers pause a CI test** in **Project → Settings → Live view**. It needs
[Hold a failing CI test](./hold-ci-failure) on: the switch stays off until the hold is on, the API refuses it alone, and
turning the hold off turns it off too. A pause lasts the **Longest hold or pause** at most: 1 to 15 minutes, 5 by
default. It is off in every project, and needs `@piwitests/reporter` 0.75.0 or later: an older one never pauses, and
its lanes offer no **Pause**.

The CI workers of the runs going on hear the change at once. While it is on, a CI worker follows its test's calls
through Playwright's in-process instrumentation, as a local run that may pause does, so a pause stops a call before it
waits for its element, where a local run's would. A test whose page was watched before the setting was turned on was
followed through Playwright's own call stream, which would stop the call only after that wait: it takes no Pause, and
says so; the worker's next test can pause.

## Pause, Resume, End the test

In the run page's lane panel of a CI lane, someone with the `run:control` permission on the project
([roles](/operate/project-access#what-each-role-can-do)) sees **Pause** while the lane's test runs. The test stops
before its next call, the way a local run's **Pause** stops it: a test waiting in a long call stops once that call
ends. Until then the lane panel says **Pause asked by Ana**, and **Resume** takes the Pause back. One Pause at a time:
a second one, from anyone, is refused naming who asked the first.

The worker drops a Pause it cannot take, and the lane panel says why, with **Pause** offered again: no test runs (the
worker is between tests, or in a `beforeAll` hook), the test's function ended first (its `afterEach` hooks and
fixtures never stop, and a failure is then [held](./hold-ci-failure) as any other), nobody with `run:control` watches
the lane in full any more, or the setting went off.

While it is paused, the test's row and its lane panel say by whom and until when: **Paused by Ana · until 12:05**,
or **Paused · until 12:05** when the instance knows no name. The lane panel shows the call the test stopped before and its place, and the live
view goes on as for any watched test: the image, [page events, text and filmstrip](./live-view-layers), and
[Inspect](./live-inspect). The lane panel offers:

- **Resume**: the test goes on from where it stopped;
- **End the test**: the test fails there, at once, with the error `Ended from Piwi by Ana` (`Ended from Piwi` when the
  instance knows no name), so the CI job stays red and the test's retries run as after any failure. The call it
  stopped before never runs, nor does anything after it in the test or its `beforeEach` hook: the call stays held
  until its page closes, then fails, which the result may list as a second error. The `afterEach` hooks and fixtures
  tear down as after any failure. On a Playwright runner whose internals Piwi does not recognize, the test fails at
  its next locator call or as its function ends instead, and the call it stopped before runs first unless it is a
  locator call on Playwright 1.62 or later.

A Viewer or a Contributor watching sees the pause, and no control. A refusal is said in the instance's words, such as
"The project's setting is off" or "You may watch this run, not control it".

The test's own timeout stops while it waits, as at a breakpoint. **The CI job's own timeout still runs**: the lane
panel says so beside the pause. A paused test that resumes passes or fails as it would have, and its reported
duration leaves the wait out.

The run's log says that the test is paused, and until when, in UTC:

```text
[piwi] The test is paused at tests/checkout.spec.ts:31 for the people watching it on the run page, until 12:05:00 UTC at the latest.
```

## When it ends

A pause ends at the first of:

- **Resume** or **End the test**;
- the longest pause the project set. A new length set during a pause applies to it;
- nobody with `run:control` watching the lane in full any more: the last one closed the panel or moved to another
  lane, as for a [hold](./hold-ci-failure#when-it-ends);
- the project's setting turned off, the hold's included, or the run's live view ending.

A **Pause** that no call took yet is dropped at the same ends, and as its test's function ends: it never stops the
next test.
Each command is logged by the instance at info level, with the run, the worker, the command and who asked. Nothing is
stored.

## What it costs, and what it never does

- **CI minutes.** A paused test holds its CI job's runner for the longest pause at most, each time. One lane waits;
  the run's other workers go on.
- **No new reach.** The worker already holds its live view stream to the instance; nothing listens on the CI machine.
  The instance checks the settings, the permission of the person who asks and that their own watch shows that worker
  in full, and sends the command on that worker's stream alone; the worker takes it only on its own stream, and only
  while its project's setting is on.
- **No input.** The page takes no click, key or text from a viewer, and nothing is run in it. **Interact**, the
  picker acting on the page, **Show the browser** and **Stop the run** stay with local runs: cancelling a CI job
  belongs to CI.

## Related

- [Hold a failing CI test](./hold-ci-failure): a failure waits for the people who may control the run
- [Live view of a run](./live-view): watching a CI run's workers
- [Inspect a worker's page](./live-inspect): the page at each call, with the locator picker
- [Who can do what](/operate/project-access#what-each-role-can-do): the `run:control` permission
