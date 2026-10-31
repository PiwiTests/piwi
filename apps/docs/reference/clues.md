---
title: Clue rules
description: "Every rule that can produce a clue on a failing execution, its strength and when it fires, and the stories that chain several clues into one sentence."
lang: en-US
---

# Clue rules

A **clue** is a one-line finding a deterministic rule draws from the evidence Piwi already stores for a failing
execution; no model is involved. The **Most likely** line of the [situation block](/guide/first-failure#_2-most-likely-why)
leads with a strong or medium story, else the cluster's completed AI diagnosis, else a weak story or the strongest
clue, and the same clues are handed to the [AI diagnosis](/features/ai-diagnosis) as evidence to confirm or refute. What a clue is on the page is described on
[Failure evidence](/features/evidence#clues).

## Rules

Each rule emits at most one clue (two for a failed request), with a strength and a citation to the evidence section it
came from. The **failure window** is the timeline's default view: from 10 seconds before the failed step to 2 seconds
after it.

| Rule | Strength | Fires when |
|---|---|---|
| Failed request before the failure<br>`failed-request-before-failure` | strong | A request returned 5xx, or failed without a response (the clue names the browser's error, such as `net::ERR_CONNECTION_RESET`), in the 10 seconds before the moment of failure. |
| Slow request overlapping the failure<br>`slow-request-overlapping-failure` | medium | A request slower than `PIWI_AI_SLOW_REQUEST_MS` (default 1,500 ms) was still in flight during the failed step. |
| Console mentions the target<br>`console-mentions-target` | strong for an error, medium for a warning | A console entry in the failure window names the failing locator or route. |
| Dialog open at the failure<br>`dialog-open-on-failure` | strong | A browser dialog (`alert`, `confirm`, `prompt`, `beforeunload`) closed in the failure window, so it was open when the action ran. Needs Playwright 1.63 or later. |
| Backend error attached<br>`backend-error-attached` | strong | A request in the failure window carries an error-level [backend log](/guide/backend-logs). |
| Element renamed<br>`element-renamed` | strong | [Locator healing](/features/locator-healing) found the element under a new identity, or flagged the stored name as stale while still recommending a fix. |
| Page structure changed near the failing locator<br>`page-structure-changed` | strong when the locator never resolved, else medium | The [page diff](/features/evidence#page-diff) against the last green sample shows the element the locator names was removed or renamed. |
| Element present but blocked<br>`element-present-but-blocked` | strong | The call log says the element resolved but was disabled, hidden, not visible or covered by another element, and the ARIA snapshot still shows it. |
| Locator matched nothing<br>`locator-matched-nothing` | strong when [locator healing](/features/locator-healing) names the element the page had instead, else medium | The call log says the locator never found an element, and no clue says the element was renamed or removed: a locator written wrong, as in a test being written, or an element that never showed. A flaky test's clue names no replacement. |
| Wrong page<br>`wrong-page` | strong | The page ended on a login, sign-in, auth, error, 404 or not-found route, or somewhere other than the last navigation the test asked for. The end URL comes from the captured app state, else from the last navigation step. |
| Worker pollution<br>`worker-pollution` | medium | The previous test on the same worker failed, timed out or was interrupted. |
| Previous lock holder failed<br>`lock-holder-failed` | strong | The execution that held the same [lock](/reference/test-metadata#test-locks) just before this test, in this run, failed or timed out. |
| Lock held on two shards<br>`lock-cross-shard` | medium | A lock this test held overlapped in time with a holder on another shard. Locks serialize only within one `playwright test` process. |
| Timeout budget<br>`timeout-budget` | medium; weak when the failed call waited for a locator that matched nothing | The failed step used at least 80 % of the test timeout, or the execution used at least 95 %. |
| Environment changed<br>`environment-changed` | medium when the browser, channel, viewport, locale, timezone, base URL or environment label changed, else weak | The environment differs from the same test's last green run in the same environment. Tool versions and color scheme alone stay weak. |
| Browser-specific<br>`browser-specific` | medium | The same test passed on at least one other browser in this run. |
| Known flake suspect<br>`known-flake-suspect` | strong when a [Flake Lab](/features/flake-lab) experiment reproduced the suspect, else weak | This failure shows one of its test's [suspects](/features/flaky-tests#suspects), when it shows several, the one an experiment reproduced, else the highest ranked: a slow or failed route, a test alongside or just before, load or a browser. The detail gives this failure's value and the suspect's counts, and, once reproduced, the arm against its control ("3 of 4 under delay GET /api/cart 1.8 s, against 0 of 10 without"). |

Clues are ranked by strength, then by membership of the story, then by how close they sit to the moment of failure, and
the list is capped at eight. An earlier fix that regressed is not a clue: the execution's **Cluster** line carries it.

## Stories

When several clues form a known combination, they are chained into one **story** sentence at the strongest member's
strength. The first combination that matches, in this order, wins:

| Story | Clues it chains | Example sentence |
|---|---|---|
| Blocked by a pending request | element present but blocked, with a slow or failed request, and the console clue when present | *The button "Pay" stayed disabled because POST /api/checkout/quote was still in flight (28 s).* |
| Renamed | element renamed and page structure changed | *The button the locator names was renamed from "Pay" to "Pay now" since the last pass.* |
| Removed | page structure changed, without element renamed | *The button "Pay" is no longer on the page since the last pass.* |
| Wrong page | wrong page, with a failed request or an open dialog | *The test ended on /login instead of /checkout after the request.* |
| Polluted worker | worker pollution, and the lock holder clue when present | *The previous test on this worker failed and left state behind.* |
| Backend error | backend error attached, with a failed or slow request | *POST /api/orders failed on the server.* |
| Timing | timeout budget and slow request | *The step used 92 % of the timeout waiting on /api/search.* |

When no combination matches, the strongest clue stands alone. A cluster's completed AI diagnosis leads instead of a
weak story or a lone clue, and the clues then read as *supported by N clues*.

## Related

- [Failure evidence](/features/evidence#clues): where the clues appear, with the evidence they cite
- [Your first failure, explained](/guide/first-failure): the situation block the **Most likely** line belongs to
- [Core concepts](/guide/concepts#story): the story
