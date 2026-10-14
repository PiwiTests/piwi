---
name: stabilize-flaky-tests
description: Find the flakiest Playwright tests from Piwi's flaky analysis, make each one fail on demand with Piwi's Flake Lab, fix what the reproducing condition points at, and prove the fix under that same condition. Use when the user asks to "fix flaky tests", "reduce flakiness", "why is this test flaky", or wants to clean up an unreliable suite.
---

# Stabilize flaky tests with Piwi

Piwi scores every test's flakiness over its whole run history and ranks it by impact, so you spend effort on the tests that actually cost the team — not whichever one failed most recently. For each test it also ranks **suspects** from that history (a route that is slower when it fails, a test running alongside, load), and its **Flake Lab** replays each suspect as a condition next to a control until the failure reproduces. A reproduced condition proves the cause, and the same condition later proves the fix. This skill follows that loop: rank, reproduce, fix, verify.

## How you reach Piwi

Prefer the **Piwi MCP server** if it is connected (`list_flaky_tests`, `get_flake_profile`, `plan_flake_experiment`, `get_test_case`, `get_test_stability_trend`). Otherwise use the dashboard's **Flaky** tab and the test's **Flakiness** tab, and work from what they show plus the repo. The lab itself is a command you run from the project root: `npx @piwitests/reporter flake`. It needs the Piwi capture fixtures in the specs (`piwiFixtures`) and a dashboard URL and reporter API key (`PIWI_DASHBOARD_URL`, `PIWI_API_KEY`, or the project's `.env`).

## Steps

1. **Rank the flaky tests.** Call `list_flaky_tests` for the project and take the top few by impact. Do not try to fix the whole list at once.

2. **Read the suspects.** For a chosen test, call `get_flake_profile`. Each suspect carries raw counts ("slow in 7 of 8 failures and 3 of 44 passes"), the condition that would test it, and, once the lab has run, its latest result (`lab`). `experiments` lists what the lab already found; if an experiment reproduced the test, skip to step 4. Read one failing execution (`get_test_run_case` / `explain_failure`) for the error at the moment it flaked. A test whose root cause is `order` depends on state an earlier test leaves behind: `compare_coverage` with its `testCaseId` names that test and the code whose path changes, so reproduce by running that test before this one in a single worker, and fix the shared state, not the wait.

3. **Reproduce it.** Run the lab on the test (`plan_flake_experiment` gives the exact commands and the arms it will run, with an estimate):

   ```bash
   npx @piwitests/reporter flake <testCaseId>
   ```

   It runs a control, then one arm per suspect, retries off, and counts only failures with the same error as in CI. Exit code `0` means an arm reproduced the failure ("reproduced by delaying GET /api/cart to 1.8 s: 3/4 against 0/10, p = 0.011"); `1` means nothing did; `2` is an error (read its message: often the fixtures are not in use). Use `--suspect <n>` to test one suspect, `--all` to also try every condition at once. If the output warns that this checkout differs from the commit of the failures, say so in your report.

   If nothing reproduces, do not guess a fix from the suspects alone. Report the arms and their counts, and fall back to reading the failure and the attempts diff.

4. **Fix what the reproducing condition points at.** The condition names the cause:
   - **A delayed route** — the test (or the app) acts before that response arrives. Wait for the response or for the UI state it produces (`await page.waitForResponse(...)`, `await expect(locator).toHaveText(...)`), not for a timeout.
   - **A failed route** — the app does not handle that error. If the endpoint really fails in CI, that is a product finding: report it rather than hiding it in the test.
   - **Another test alongside or just before** — shared state: a backend row, storage, a fixture both use. Isolate it (unique data per test, a fresh context, its own fixture).
   - **CPU load** — a race the load exposes; the fix is the same as a delayed route: await the state the test depends on.
   Make the change in the spec, or in the app when the flake is a real defect.

5. **Verify the fix under the same condition.** Run:

   ```bash
   npx @piwitests/reporter flake verify <testCaseId>
   ```

   It reruns the arm that reproduced the failure, and its control, for enough runs to say the fix holds at the rate it failed. Exit code `0` means the fix held; `1` means it still fails (or too few runs passed to say). "It passed ten times in a row" is not a verification; this is.

6. **Report.** For each test you touched: the reproducing condition and its counts, the change, and the verify result. List any remaining high-impact flaky tests, and any test the lab could not reproduce, so the user can decide whether to continue.

## Guardrails

- Fix the cause, never the symptom — no blanket `test.retry`, no bumped global or per-test timeout, no `waitForTimeout` sprinkles. A longer timeout can make `flake verify` pass without fixing anything; do not do it.
- A test that flakes because a *real* endpoint is unreliable is a product finding; surface it instead of hiding it in the test.
- Stabilize a few high-impact tests well rather than lightly touching many. Prove each one with `piwi flake verify` before moving on.
