---
title: Record actions
description: "Record clicks and fills across a site's pages with Piwi Picker into a runnable Playwright spec, paused, titled and replayed before you export it."
lang: en-US
---

# Record actions

<Needs extension />

**Record actions** asks for access to the site you are on, then captures clicks, fills, checks, choices, drags, the
names of chosen files (never their content), the keys that submit, close or move through a list, a click on what a
hover shows, and the browser's **Back**, **Forward** and reload as a step to the page they reach, across pages. Each
element is recorded with up to five locators that find it alone, ranked, so a replay has others to try when one no
longer holds. **Check an element** and **Check the address** add an `expect(…)` of what the page shows
now. **Pause** stops capturing without ending the recording, on every page and tab of it, so signing in or closing a
banner stays out of the spec, until **Resume**. **Stop** opens the review: the **Test title**, filled with the first
page's own title (or, left empty, the first step in words), names the spec's test and the steps file; **Copy as
TypeScript** for a runnable spec that waits for each page it opens,
**Download steps** for a [steps file](/reference/steps-format) to share or render with
[`piwi codegen`](/reference/cli#codegen), [**Send to editor**](./editor-recording#send-from-piwi-picker),
[**Replay**](./replay-a-bug-report) to play the steps again in the tab and see that each still finds its element, or
**Discard**. Passwords are never captured, nor a card number, its security code or a one-time code in a field whose
`autocomplete` names it: the spec reads them from `process.env`.

<figure>
  <img src="/screenshots/picker-record.png" alt="The review panel after a recording: seven steps, Copy as TypeScript">
  <figcaption>The review after Stop: every step, the spec one click away.</figcaption>
</figure>

## Matching functions

With a connection, the recorder loads the [function catalog](./test-functions) of the project mapped to the page and
ranks, while you record, the functions the steps look like. On export, a complete match becomes a call to your
function. No AI: it scores your registered functions' DOM patterns.

## Related

- [Report a bug](./report-a-bug): the same recording, with what the page should show and the evidence
- [Replay a bug report](./replay-a-bug-report): play recorded steps again in a tab
- [Steps file](/reference/steps-format): the format **Download steps** writes
- [Send to editor](./editor-recording#send-from-piwi-picker): the spec inserted in VS Code or a JetBrains IDE
- [Browser extension](./extension): the other tools, the permissions and the limits
