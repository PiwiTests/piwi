---
title: Hold a failing CI test
description: "A CI test that fails while someone who may control the project's runs watches its worker waits at its failure, its page open for Inspect, until Let it go or the project's longest hold: off by default, its result unchanged."
lang: en-US
---

# Hold a failing CI test

<Needs reporter fixtures />

A CI test that fails is gone a second later: its page closes before anyone can look at it. With this setting on, a CI
test that fails while a Maintainer or a Project admin watches its worker in the [live view](./live-view) waits at its
failure, its page open, so they can [inspect](./live-inspect) the page as it failed, read its events and text, and pick
the locator it should have used. **Let it go** ends the wait; the test then ends as it failed.

## Turn it on

A Project admin turns on **Hold a failing CI test for its controllers** in **Project → Settings → Live view**, with the
project's live view on, and sets the **Longest hold**: 1 to 15 minutes, 5 by default. It is off in every project.
It needs `@piwitests/reporter` 0.75.0 or later: an older one never holds, and gets no **Let it go**.

The CI workers of the runs going on hear the change at once: turned off, a test that is held goes on.

## When a test is held

A CI test is held only when all of these stand as it fails:

- the project's setting is on;
- someone with the `run:control` permission on the project (a Maintainer or a Project admin:
  [roles](/operate/project-access#what-each-role-can-do)) watches that worker's lane in full, in its lane panel. A
  tile of [Watch all](./watch-all) does not count, nor does a Viewer or a Contributor watching;
- the test failed or timed out, and was not expected to.

With authentication off, everyone who opens the run may control it, so anyone watching counts.

A test that fails while nobody who may control the run watches goes on at once, as it always did: a wait nobody looks
at only costs CI minutes.

## While it is held

The test's row and its lane panel say **Failed, held at its line**, then for whom and until when:
**Held for Ana · until 12:05**, naming the people watching it as it failed. The lane panel shows the failure and its
place, and the live view goes on as for any watched test: the image, the call's log,
[page events, text and filmstrip](./live-view-layers), and [Inspect](./live-inspect) on the failing page. Nothing
reaches the page: no click, no key, no code.

The test's own timeout stops while it waits, as at a breakpoint, so Playwright does not fail the wait itself. **The
CI job's own timeout still runs**: the lane panel says so beside the hold. A job that reaches its timeout during a
hold fails as it would have, later.

The run's log says that the test is held, and until when, in UTC:

```text
[piwi] The test failed at tests/checkout.spec.ts:42: held for the people watching it on the run page, until 12:05:00 UTC at the latest.
```

## When it ends

The hold ends at the first of:

- **Let it go**, in the lane panel, which only someone with `run:control` sees;
- the longest hold the project set;
- nobody with `run:control` watching the lane in full any more: the last one closed the panel or moved to another
  lane;
- the project's setting turned off, or the run's live view ending for good (the run ended, the live view turned off).

The test then tears down as it would have: its result, its error, its trace and its attachments are those of the
failure. Its reported duration leaves the wait out.

**Let it go** is logged by the instance at info level, with the run, the worker and who asked. Nothing is stored.

## What it costs, and what it never does

- **CI minutes.** A held test holds its CI job's runner for the longest hold at most, each time. One lane waits; the
  run's other workers go on.
- **No new reach.** The worker already holds its live view stream to the instance; nothing listens on the CI machine.
  The instance checks the setting and the permission of the person who asks, and the worker takes **Let it go** only
  on its own stream, and only while its project's setting is on.
- **No input.** The page takes no click, key or text from a viewer, and nothing is run in it: the CI page may be
  signed in to real systems.

## Related

- [Live view of a run](./live-view): watching a CI run's workers
- [Inspect a worker's page](./live-inspect): the page at each call, with the locator picker
- [Page events, text and filmstrip](./live-view-layers): what the page said beside the image
- [Who can do what](/operate/project-access#what-each-role-can-do): the `run:control` permission
