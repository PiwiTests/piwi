---
name: apply-locator-healing
description: Replace brittle Playwright locators with the healed selector Piwi suggests after a failing run, then re-run to confirm. Use when a test fails because a selector no longer matches, when the user asks to "fix the broken locator", "apply Piwi's suggestion", or "heal the selector".
---

# Apply Piwi's locator healing

When a locator stops matching, Piwi has already computed a ranked replacement from the locator snapshots it captured on passing runs. This skill applies that suggestion to the real spec file and verifies it — closing the last mile Piwi cannot do on its own (edit your code).

## How you reach Piwi

Prefer the **Piwi MCP server** if it is connected (`get_locator_healing`, `explain_failure`, `get_run`). Otherwise open the failing case in the dashboard — the healing panel shows the suggested locator and its call site — and work from that plus the repo. The reporter also attaches a `piwi-locator-suggestion` annotation to the failing test in the Playwright report.

## Steps

1. **Find the failing case.** From a run the user names, or the latest failed run (`list_recent_activity` → `get_run` with a failed filter). Identify the case whose failure is a locator that matched nothing (a timeout on `click` / `fill` / `expect(locator)`).

2. **Get the healed locator.** Call `get_locator_healing` for that case. It returns the **recommended durable locator** plus ranked alternatives, each stamped with the **call site** (file and line) where the original locator was used, and a ready-to-apply `edit`. Read the call site — that is the exact spot to edit. An answer with `applicable: false` means the locator resolved and the failure came after it: do not rewrite the selector.

3. **Confirm it's really a locator problem.** The suggestion is only right if the element still exists under a new selector. Skim the error and the ARIA snapshot (`get_test_run_case` / `explain_failure`): if the element is genuinely gone or the page errored before rendering, this is not a healing case — hand it to the `investigate-failure` skill instead.

4. **Edit the spec.** At the call site, replace the brittle locator with the recommended one. Prefer role/label/test-id selectors (what Piwi ranks highest) over CSS/XPath. Keep the change minimal and in the user's existing style. If the same brittle selector appears elsewhere (a page object, a helper), update those too.

5. **Verify.** Re-run just that spec: `npx playwright test <file>`. It should pass. If Piwi is set up to report, confirm the new run is green for that case; if it still fails, try the next-ranked alternative from step 2 before broadening the search.

6. **Report.** Show the before/after locator, the file and line, and the verifying result. If several tests shared the selector, list every place you changed.

7. **Report back to Piwi.** Commit with the trailer `Piwi-Cluster: <clusterId>` as the last line of the message (the cluster of the failing case; `get_fix_plan` returns the line in `verify.commitTrailer`), then call `report_fix_attempt` with that cluster, `kind: "locator-edit"`, the commit or the branch, and the `edit` (`filePath`, `line`, `from`: the old locator, `to`: the one you applied). Do it once per call site you changed. Piwi records the attempt verified when the test passes on that commit, and records the healing suggestion applied once a run uses the recommended locator at that call site. `report_fix_attempt` needs the Maintainer role or above on the project.

## Guardrails

- Change the **locator**, not the assertion's intent — if a test checked for "Sign in" and the button is now "Log in", that is a copy change to confirm with the user, not a locator to heal.
- Never paste a suggested locator without reading its call site and the surrounding test; apply it where the original was used.
- One verified green re-run per healed selector. Don't batch-replace across many files without running the affected specs.
