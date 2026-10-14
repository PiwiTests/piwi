---
title: Failure evidence
description: "Everything captured about one failing execution on one screen: the evidence tabs, clues, attempts, the page diff and the trace-powered views."
lang: en-US
---

# Failure evidence

Everything Piwi captured about a failing attempt lands on one screen: what each tab holds and what a trace adds.

Two pages are involved, told apart in [Core concepts](/guide/concepts#execution):

| Page | Path | Answers |
|---|---|---|
| **Execution** | `/test-run-cases/:id` | "why did this attempt fail?": [the diagnosis view](#one-execution-diagnosis-first) |
| **Test case** | `/test-cases/:id` | "how has this test behaved over time?": [its history](#the-test-case-page) |

## One execution, diagnosis-first

A failing execution reads top to bottom in one column. It opens on the **situation block** (headline, most likely
cause, next step, cluster), described on [Your first failure, explained](/guide/first-failure).

<figure>
  <img src="/screenshots/gather-evidence.png" alt="A failing execution: one situation block, then one evidence card whose tabs (Timeline, Screen, Source, Network, Console, State, Performance) hold the captured evidence">
  <figcaption>A failing execution: the situation block, then one evidence card whose tabs hold everything captured.</figcaption>
</figure>

Below the block, one **evidence card** holds tabs, a count on those that list items, empty ones dimmed. It opens on **Source** or
**Performance** when a strong or medium leading clue cites it, else on **Timeline** when it can place two or more items,
else on the cited tab, else on **Screen** when a screenshot or video exists, else on **Source**; never on **State**.

- **Timeline**: one time axis for the steps, console entries, requests, their backend logs and (Playwright 1.63+)
  browser dialogs, with the failure marked, over a table giving each step's and request's offset (`t-1.1s`) and
  duration, colored only when it lasts at least 1 s and a third of the test, or twice its time in recent passing
  runs and 1 s more. **Around the failure** / **Whole test** and one chip per item type filter both. Hooks and fixtures fold into
  **Setup** and **Teardown** rows, open when the failure is there; a `test.step` holds its steps; the failing step
  shows its error and its page's Screenshot, DOM and Accessibility tree; a caught error is greyed out.
- **Attempts**: shown when a test ran more than once, see [below](#attempts).
- **Screen**: the page at the failure as views (**Screenshot**, **DOM**, **Accessibility tree**, **Visual diff**,
  [**Page diff**](#page-diff), **Video**) over the trace and attachments. **DOM** renders it as recorded: field values
  (passwords masked), scroll offsets, open dialogs, shadow DOM, the action's target outlined. **Open in picker** finds a
  locator on that DOM.
- **Source**: the test source as a call stack (the line that threw plus its callers), deepened
  [with a trace](#trace-powered-deep-views).
- **Network**: the requests with inline [backend logs](/guide/backend-logs); one with no response shows the browser's
  error (`net::ERR_CONNECTION_RESET`). **Console**: the console output.
  **State**: the app state at test end and the environment diff against the last green run. **Performance**:
  performance hints and Web Vitals.

Below the evidence sit the folded [**More ways to fix**](./fix-plans#more-ways-to-fix) toolbox and a **history** strip
of this test's recent executions. A test that **passed on retry** leads with its failed attempt's error, opens on
**Attempts** and keeps its next step; any other passing execution shows identity and facts, with the evidence on
**Timeline**. A test that **did not run** gives its reason as Most likely, with no evidence card. Network, console,
Web Vitals, ARIA and alternative-locator data come from the [capture fixtures](/guide/capture-fixtures).

### Clues

A **clue** is a one-line finding a deterministic rule draws from the evidence already captured, with no model
involved. Each carries a **strength** (strong, medium or weak) and a **citation** that opens and marks the evidence it
came from; the **Most likely** line leads with their strong or medium story, else a completed diagnosis, else a weak
story or the strongest one, and marks the rows and tabs it cites. The AI diagnosis receives the clues as evidence.
Every rule, and when it fires, is listed on [Clue rules](/reference/clues).

### Attempts

When a test passed on retry, the **Attempts** tab lists every attempt (status and duration, the one you
opened marked), then **what differed** between the failing attempt and the passing one, most diagnostic first:

- the **error** present on the failing attempt and gone on the pass;
- a **request**, keyed by route (`GET /api/cart/:id`), that failed (5xx or no response) on one attempt only, or took
  at least 1 s and twice as long on the failing one;
- a **console** error or warning logged on one attempt only;
- a **step** that errored, ran much slower, or ran with different **params** on one attempt;
- a **page-state or URL** difference, including storage keys and cookies;
- an **ARIA structural** difference at the landmark and heading level.

Each difference links to its evidence tab, a request that is one of the test's [suspects](./flaky-tests#suspects) to
it. The comparison feeds the [root-cause classifier](./flaky-tests#root-cause-classification).

## Page diff

Where the visual diff compares pixels, the Screen tab's **Page diff** view compares *structure*: it parses the failing
page's [ARIA snapshot](/guide/capture-fixtures#what-gets-captured) and the same test's last passing snapshot into trees
and reports nodes **added**, **removed**, **renamed**, **changed** (an attribute such as `[disabled]` flipped) or
**moved**. The element the failing locator names
is highlighted: a broken `getByRole('button', { name: 'Pay' })` lands on the button renamed `"Pay now"`.

The baseline is the same test's most recent passing snapshot on the same browser, preferring the same environment then
the same branch. Green snapshots come from
[sampling on pass](/guide/capture-fixtures#green-page-sampling-on-pass), about once a day per test; until one exists the
view says why (*not captured*, *no green sample yet* or *not applicable*). The page-diff summary reaches the
`explain_failure` [MCP tool](/features/mcp).

When the trace carries [aria snapshots](#aria-and-screen-snapshots), the view adds an **in-execution** page diff
that needs no green baseline: the structure at the failure against the last different page before the failing action.

## Trace-powered deep views

::: tip Where screenshots come from
Failure screenshots come from Playwright's `screenshot: 'only-on-failure'` [option](/guide/reporter#basic-configuration), one per page. The failing step shows the [capture fixtures](/guide/capture-fixtures#what-gets-captured)' screenshot of the failing page, else the only one.
:::

With an uploaded trace (`trace: 'retain-on-failure'` or `'on-first-retry'`), two views go deeper:

- **Source → Full stack**: the failing action's whole call stack, each frame with its source from the trace,
  dependency frames folded, Open in IDE on your project's frames.
- **Network → Full trace**: every request the page made, on a waterfall with the failing action's window shaded, with
  timing phases, headers and a capped body preview. Sensitive headers and token-shaped strings are masked on the server.

### Aria and screen snapshots

A Playwright 1.63 trace can record the page's **aria tree** and a **screenshot** before and after every action
(`trace: { snapshots: { dom, aria, screen } }`; [`wrapConfig`](/guide/reporter#installing-via-wrapconfig) turns `aria`
on, `screen` stays [opt-in](/operate/storage#trace-snapshots)). Then the Screenshot view sets the page **before the
failing action** beside the one at the failure, and the Timeline tab adds a **filmstrip** of the page before each
step. The [in-execution page diff](#page-diff) reads the same snapshots.

### Recovered from the trace without the fixtures

With the reporter alone and a trace uploaded, the dashboard recovers the **console** entries, the **network requests**
(including failed and aborted ones) and the failure-time **ARIA snapshot** from the trace at ingest. Cards showing
it carry a **derived from the trace** chip; fixture-captured data is never replaced.

### Why a card is empty

A tab that needs the capture fixtures appears only when it holds data or the fixtures ran and found nothing; otherwise
one footer line names the missing tabs. When a card does open empty, it says which case applies: **captured, nothing
happened**, **not applicable** (backend logs need a [backend integration](/guide/backend-logs)), or **declined** for this
project ([Declining a capability](/operate/capabilities#declining-a-capability)). The AI diagnosis's **Data coverage**
block uses the same words.

## Trace viewer

**Open trace**, atop the evidence card on every tab, opens the Playwright trace viewer; the Screen tab lists each trace with **Open trace** and **Download**. The dashboard serves the viewer at `/trace-viewer/`, so traces never go to a
third party, with or without [authentication](/operate/authentication). The hosted
`trace.playwright.dev` can't send your session cookie, so it only works with authentication off.

## The test case page

`/test-cases/:id` is the other axis: not one attempt, but the test's whole life. Total runs, pass rate, average duration
and last run, a duration trend, a status-history strip, and the recent executions, each linking back to its execution.
A flaky test adds a **Flakiness** tab with its [suspects](./flaky-tests#suspects).

<figure>
  <img src="/screenshots/test-case-detail.png" alt="Test case page with run stats above a duration trend chart, a status history strip, and a table of recent executions">
  <figcaption>The test case page: pass rate and duration stats, a duration trend, and every recent execution of this test.</figcaption>
</figure>

## Related

- [Your first failure, explained](/guide/first-failure): the situation block at the top of a failing execution
- [Fix a broken locator](/recipes/broken-locator): this page, used for one concrete job
- [Clue rules](/reference/clues): every rule behind a clue
- [Capture fixtures](/guide/capture-fixtures): the one file that produces the network, console, Web Vitals and locator evidence
- [AI diagnosis](./ai-diagnosis): an explanation of the failure against your git diff
- [Offline export](./offline-export): take the investigation out of the dashboard as one file
