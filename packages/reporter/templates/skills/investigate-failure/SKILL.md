---
name: investigate-failure
description: Investigate a failed test run recorded in Piwi Dashboard and propose a fix grounded in its evidence — error, steps, console, network, locator suggestion, and the diff since the last green run. Use when the user asks "why did the last run fail", "what broke in CI", "diagnose this failure", or points at a Piwi run/cluster.
---

# Investigate a Piwi failure

Turn a failed run in [Piwi Dashboard](https://piwitests.dev) into a grounded diagnosis and a concrete fix. Piwi has already gathered the evidence — the error text, the steps that ran, console output, failing network calls, a suggested locator, and the source diff since the last passing run. Use that instead of guessing.

## How you reach Piwi

Prefer the **Piwi MCP server** if it is connected to this agent (tools named `list_recent_activity`, `get_run`, `explain_failure`, `get_cluster_context`, …). If it is not connected, tell the user they can connect it (the reporter CLI does not proxy MCP — see the dashboard's **MCP server** page) or paste the run URL / failure details, and work from those plus the repo.

## Steps

1. **Find the run.** If the user gave a run URL or id, use it. Otherwise call `list_recent_activity` (or `list_runs` for a specific project) and take the most recent failed run. Confirm with the user if several projects are in play.

2. **Get the failures.** Call `get_run` with a failed-status filter to list the failing cases. For a fast single-call evidence bundle on one case, use `explain_failure` (error + steps + console + locator fix + diagnosis context).

3. **Group by cause.** Call `get_failure_groups` (or `list_clusters` / `get_cluster`) — failures that share a root cause are clustered, so you fix one thing, not five. Work cluster by cluster.

4. **Read the evidence per cluster.** Call `get_cluster_context` — the same SCM-grounded context the built-in diagnosis uses: representative errors, test steps, console logs, failing network requests, ARIA snapshots, and the **diff of files changed since the last green run**. If a diagnosis already exists, `get_cluster_diagnosis` returns its root cause and suggested fix. When the failure has no change behind it and the project records coverage, call `compare_coverage` with a failing execution's id: the code this run took that the last passing run did not (an error path, a fallback) is where to look.

5. **Form the diagnosis.** Tie the failure to a cause with evidence: a selector that stopped matching, an assertion on changed copy, a slow/500 endpoint (`get_network_requests`), a race, a genuinely flaky test (check `get_test_stability_trend` — if it fails intermittently, treat it as flaky, not a regression). Point at the specific commit/file from the diff when the evidence supports it.

6. **Propose the fix.** Make the smallest change that addresses the root cause, in the actual source or spec files. Prefer Piwi's own suggestions where they exist — for a broken selector, the ranked replacement from `get_locator_healing` (the `apply-locator-healing` skill does exactly this). Show the diff.

7. **Verify.** Re-run the affected spec(s): `npx playwright test <file>`. Confirm they pass and the new run is green in the dashboard (`get_run_insights` compares against the last green run: regressions cleared, nothing new broken).

8. **Report back.** Piwi learns from what you tell it, so end every investigation with these calls (they need reporter or admin access; each is logged with your API key):
   - **Your diagnosis.** If the cluster had no diagnosis, or yours differs, record it with `record_diagnosis` (`clusterId`, or `executionId` for a failure in no cluster or with a cause of its own): the model you run on and the diagnosis in the schema the tool describes (summary, confidenceScore, severity, ranked hypotheses with their evidence, suggestedFix with the unified-diff `patch`). Piwi validates the patch against the source that failed and shows the diagnosis as written by an agent.
   - **Your rating of Piwi's diagnosis.** If you read one with `get_cluster_diagnosis`, rate it with `submit_diagnosis_feedback`: `up` when it pointed at the real cause, `down` with a one-line note on what it got wrong when it did not. A `down` keeps the next diagnosis from repeating it.
   - **Your fix.** Commit the change with the trailer `get_fix_plan` returns in `verify.commitTrailer` (`Piwi-Cluster: <clusterId>`) as the last line of the commit message, then call `report_fix_attempt` with the cluster, the kind (`patch`, `locator-edit` or `fix-plan`), the commit or the branch, the patch you applied and the `diagnosisId` you followed. When the tests pass on that commit, Piwi records the attempt verified and shows it on the cluster's activity.
   - Leave the cluster's status alone: the run that passes on your commit records the fix.

## Guardrails

- Ground every claim in evidence you actually read — never invent a stack trace, a commit, or a line number. If the evidence is thin, say so and get the trace (`list_case_traces`) or ask.
- Distinguish a **regression** (was passing, now failing — fix the cause) from a **flaky** test (intermittent — stabilize it) from an **environmental** failure (dashboard/CI/network). The fix differs for each.
- Don't mark a cluster resolved until a run proves it. Report the diagnosis, the change, and the verifying run URL.
