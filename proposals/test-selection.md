# Test selection from run history

A design record for **selections**: named, data-driven subsets of a project's tests that the dashboard computes from
the history it keeps, and that a developer, a CI job or an AI agent can actually *run* — `piwi run smoke` — instead of
maintaining grep patterns and tag lists by hand.

**Status.** M1 and M2 have shipped, and most of M3 and M4: the selection model with its catalog predicates and
built-ins, `piwi select` / `piwi run` with duration-balanced `--shard` and `--fail-fast` ordering, run stamping, the
`--require-selection` gate policy, the project's Selections tab with builder and live preview, the PR-feedback
summary line, five MCP tools (`list_selections`, `resolve_selection`, `preview_selection`, `suggest_selections`,
`analyze_selections`) with the `run-the-right-tests` skill, suggested tags and budgeted smoke mining, impact-from-diff
over captured source frames, and selection health and drift analytics. Impact also reaches the handler file of each
route a test called, through [code reach](../apps/docs/features/code-reach.md) with an instrumented backend (Nitro or
ASP.NET Core). Not shipped: applying tag suggestions back to the spec files as a pull request, suggestion digests
through notifications, the per-project route mapping for a backend without that instrumentation, and **Save as
selection** from the test catalog, the flaky leaderboard and the cluster page (it exists on Analytics and on the
Selections tab). The user guide is [Test selections](../apps/docs/features/test-selection.md) on the docs site; the design
below is the original text.

**Summary.** Piwi already knows which tests are fast, stable, flaky, slow, quarantined, recently broken, owned by
whom, and which routes and source files each test actually exercised. Today that knowledge flows only into dashboards;
the run itself is shaped by hand-maintained `--grep` patterns and tag conventions that go stale silently. A selection
is a saved, declarative rule set (`tags`, `owner`, `priority`, file globs, flakiness, duration, cluster membership,
changed-code impact, a time budget…) stored server-side, resolved on demand against the live test catalog, and
materialized into arguments Playwright understands — reusing the retry-command ladder that already exists. Consumption
is layered: a `piwi select` / `piwi run` CLI for terminals and CI, a dashboard builder with live preview and
copy-command, MCP tools for agents, and a `--require-selection` gate policy that catches silent shrink. On top sits
the intelligence: Piwi *suggests* selections and tags (`@smoke` candidates mined as a budgeted set cover over observed
route coverage, `@slow` outliers, feature tags from URL clustering) and can apply accepted tag suggestions back to the
spec files as a reviewable pull request, reusing the auto-heal PR machinery. Self-hosted, all analysis local, no new
telemetry.

## Problem

Three gaps, one shape: the data that should decide *what to run next* is in Piwi, but the decision is made elsewhere,
by hand.

1. **Choosing a subset is manual and stale.** A smoke suite today is a tag convention (`@smoke` in titles), a grep
   pattern in a CI YAML, and a wiki page explaining both. Nothing checks that the tagged set is still fast, still
   stable, or still covers the app's entry points; nothing notices that a renamed file silently dropped three tests
   out of the smoke job. The dashboard can see all of this — `test_cases` carries denormalized tags/owner/priority
   ([`schema.sqlite.ts`](../apps/application/server/database/schema.sqlite.ts)), the catalog query aggregates pass
   rate, flaky count, last status and average duration per test (`getProjectTestCases` in
   [`shared/handlers/projects.ts`](../apps/application/shared/handlers/projects.ts)) — but it can only display, not
   drive.

2. **History becomes a command in exactly one place, and it's copy-paste.** `buildRetryCommand`
   ([`shared/retry-command.ts`](../apps/application/shared/retry-command.ts)) turns a list of failing cases into a
   runnable `npx playwright test` line, with a file-line → grep → file fallback ladder, per-Playwright-project
   grouping and Windows-safe path normalization. The fix plan reuses it for its verify command. That is the whole
   story: one-shot, failure-scoped, clipboard-delivered. There is no way to say "run the stable critical tests",
   "run whatever exercises `/api/checkout`", or "run the best five minutes of this suite".

3. **The reporter is one-directional.** Runs flow in — with their filters faithfully recorded
   (`test_runs.filter_details`, `is_full_run`, and the CLI file-filter detection in
   [`cli-filters.ts`](../packages/reporter/src/internal/support/cli-filters.ts)) — but nothing flows back out to
   shape the next run. The gate (`piwi gate`, evaluated server-side in
   [`gate.post.ts`](../apps/application/server/api/test-runs/%5Bid%5D/gate.post.ts)) judges a run after the fact;
   quarantine adjusts the verdict, not the execution. The loop is open exactly where it would pay the most.

Why this belongs in Piwi, against the ROADMAP's own test ("when a proposed feature doesn't strengthen one of the
three, that's the argument against building it"): job 3 is **hand back a fix** — "an owner, a command that verifies
the work. The point is to leave with something to do." A selection is that principle generalized from one failure to
the whole suite: the history Piwi keeps (job 1), turned into the run you should do next. The gate, PR feedback and
MCP are the precedented delivery routes; this adds the missing one — the run itself.

## What the dashboard already knows

Every signal a selection rule or a suggestion needs is already collected and indexed. No new capture is required for
v1; the intelligence layer reads tables that exist today.

| Signal | Where it lives today |
|---|---|
| Stable test identity (file, suite path, title) | `test_cases` (unique per project + file + suite path + title) |
| Tags, owner, priority, feature, link | `test_cases` denormalized columns, refreshed every run; per-execution truth on `test_runs_cases.tags` / `test_meta` |
| Pass/fail/flaky counts, last status, average duration | catalog aggregates in `getProjectTestCases` |
| Flakiness + root cause + impact score | flaky detection (`flaky-classify.ts`), `test_cases.flaky_root_cause`, flaky leaderboard |
| Quarantine state | `quarantined_tests` (active = `released_at IS NULL`) |
| New-regression / new-flaky signals | `test_runs_cases.is_new_regression` / `is_new_flaky` (`compute-regression-signals.ts`) |
| Failure grouping | `failure_clusters` + `test_runs_cases.failure_cluster_id` |
| Per-test route coverage | `network_requests.normalized_url` (route pattern, indexed), `method`, `status` |
| Per-test page coverage | `test_runs_cases.page_state` (URL/history at test end) |
| Per-test source reach | `test_runs_cases.test_source_frames` (in-project call-stack frames) |
| Durations, slowest step, wasted wait time | `test_runs_cases.duration` / `slowest_step_duration` / `wasted_time_ms`, run-level p90 |
| Ownership | CODEOWNERS-derived (`scm/ownership.ts`) |
| Repository diffs and commits | SCM providers (`server/utils/scm/`) already power AI diagnosis and auto-heal |
| What a run was filtered to | `test_runs.filter_details` (`grep`, `grepInvert`, `files`) + `is_full_run` |

The last row is the keystone: Piwi already treats "which tests did this run *intend* to run" as first-class data.
Selections give that intent a name, a version and a server-side definition.

## Design in one page

Three layers, each useful without the ones above it:

```
┌─ Layer 3: intelligence ─────────────────────────────────────────────┐
│ suggested selections & tags: @smoke mining (budgeted set cover      │
│ over observed coverage), @slow outliers, feature tags, impact-from- │
│ diff; accepted tag suggestions become a reviewable PR               │
├─ Layer 2: consumption ──────────────────────────────────────────────┤
│ piwi select / piwi run · CI two-step · dashboard builder + copy     │
│ command · MCP tools · gate --require-selection · balanced shards    │
├─ Layer 1: the selection model ──────────────────────────────────────┤
│ named declarative definitions, stored per project, versioned,       │
│ resolved on demand against the catalog, materialized via the        │
│ retry-command ladder, stamped onto the runs they produce            │
└─────────────────────────────────────────────────────────────────────┘
```

One vocabulary note up front: **"suite" is taken** — in Piwi's concepts a suite is a `describe` block
(`test_suites`, [`concepts.md`](../apps/docs/guide/concepts.md)). The feature is called a **selection** everywhere: in the
schema, the API, the CLI and the docs.

## Layer 1 — the selection model

### Definition

A selection is a project-scoped row: `key` (slug, stable), `name`, `description`, `definition` (JSON), `version`
(incremented on every definition change), `created_by`, timestamps, `archived`. The definition is declarative — rules
over catalog facts, not a frozen list of test ids — so it keeps tracking the suite as tests are added, renamed and
deleted. Shape:

```jsonc
{
  "include": [                       // OR-ed groups; within a group, AND-ed predicates
    { "tags": ["smoke"] },
    { "priority": ["critical", "high"], "maxAvgDurationMs": 15000 }
  ],
  "exclude": [
    { "quarantined": true },
    { "files": ["tests/experimental/**"] }
  ],
  "pins":   { "add": [412, 907], "remove": [55] },   // manual per-test overrides, by test_case id
  "budget": { "maxTotalDurationMs": 300000, "rankBy": "failureLikelihood" },
  "limit":  200
}
```

Predicates, all optional, all against data listed above: `tags`, `owner`, `priority`, `feature`, `files` (globs),
`suitePath`, `playwrightProjects` (browser/project names), `text` (title search), `quarantined`, `flaky`
(bool or min score), `minPassRate` / `maxPassRate`, `minAvgDurationMs` / `maxAvgDurationMs`, `lastStatus`,
`failedInLastRuns: n`, `inOpenCluster` (any, or a specific cluster id), `newRegressions`, `coversRoute`
(match on `normalized_url`), `visitedUrl`, `touchesFile` (match on `test_source_frames` paths), and — layer 3 —
`impactedBy: { base: "<ref>" }`. Unknown predicate keys are a validation error, not a silent no-op, so an old CLI
against a newer server fails loudly.

`budget` turns a selection into a knapsack: rank the matched tests (by failure likelihood, recency of failure, or
declared priority), then take tests until the summed `avgDuration` hits the cap. "The best five minutes of this
suite" is `include: [{}]` plus a budget.

Two definitions are worth shipping as **built-ins** that exist implicitly for every project, no setup: `failed` (what
the retry command covers today: failed + new-regression tests of the latest run) and `quarantine-free` (everything
minus active quarantine). They make the CLI useful on day one and double as living documentation of the format.

### Resolution

`resolve(selection, at = now)` evaluates the definition against the current catalog and returns:

- the concrete test list (test_case ids + file/line/title/playwright-project),
- a **materialization** for Playwright — produced by the existing ladder in `shared/retry-command.ts`, extended to
  emit structured forms, not only a shell string: `file-line` args (default), `--grep` regex (title-based), or plain
  file list, grouped per Playwright project exactly as `buildRetryCommand` groups today, POSIX-normalized for
  Windows;
- a `resolvedHash` (SHA-256 over the sorted stable test identities) and the `version` it came from,
- an estimate: count, summed `avgDuration`, and any warnings (see below).

Resolution rules that are part of the contract:

- **Zero matches is an error, not an empty run.** A selection that resolves to nothing exits the CLI with code 2
  (the gate's "could not evaluate" convention) — a misconfigured smoke job must fail loudly, never silently pass by
  running nothing.
- **Warnings are attached, not fatal**: a quarantined test matched by an include rule, a pinned id that no longer
  exists, a grep materialization that had to fall back to file granularity (over-selection), a budget that evicted
  pinned tests.
- **Determinism**: same definition version + same catalog state ⇒ same hash. The hash is what runs are stamped with,
  so "did CI actually run smoke@v7 as resolved" is answerable.

## Layer 2 — consumption

### CLI: `piwi select` and `piwi run`

Two commands join `init` / `skills` / `gate` / `ai` in [`cli/index.ts`](../packages/reporter/src/cli/index.ts),
following the house contract: `PIWI_DASHBOARD_URL` / `PIWI_API_KEY` env or flags, `--json` for agents, exit codes
0/1/2 with 2 = could not evaluate.

```
piwi select <key> [--format args|grep|files|json] [--project <pw-project>]
                  [--budget 5m] [--shard 2/4] [--base origin/main]
piwi run    <key> [same options] [--strict] [-- <extra playwright args>]
```

`piwi select` resolves and prints — the two-step CI form, and the composable one:

```yaml
# smoke job
- run: npx @piwitests/reporter select smoke --format args > .piwi-selected
- run: npx playwright test $(cat .piwi-selected)
```

`piwi run` resolves and **spawns** `npx playwright test` with the materialized arguments plus anything after `--`.
This is the recommended everyday form for three reasons: it is one command; it sets `PIWI_SELECTION` context env vars
so the reporter stamps the run (below) with zero configuration; and it sidesteps shell-quoting entirely — a real win
on Windows, where hand-quoting a grep alternation in PowerShell is the reliable way to lose an afternoon (the repo's
own cross-platform command rule exists for a reason).

Failure philosophy mirrors the reporter's own (a reporting problem must never break the test run): if the dashboard
is unreachable, `piwi run` falls back to the **full suite** with a warning, and caches the last successful resolution
in `.piwi/selection-cache.json` for offline repeats. `--strict` inverts that for CI: unreachable ⇒ exit 2. Resolving
to zero tests is exit 2 in both modes.

`--shard i/n` shards the *resolved list* balanced by summed `avgDuration` — historically informed balancing that
Playwright's file-count sharding cannot do, using data Piwi uniquely has.

### Config-level integration (deliberately thin)

The tempting magic — `PIWI_SELECTION=smoke npx playwright test` with `wrapConfig` applying the filter — has a real
constraint: [`wrapConfig`](../packages/reporter/src/public/config-wrapper.ts) is synchronous and runs at config load,
before any Piwi global setup, and CJS configs cannot await a server round-trip there. Rather than a sync-HTTP hack,
v1 offers an explicit helper for ESM configs (top-level await is fine there):

```ts
import { resolveSelection } from '@piwitests/reporter';
const selection = await resolveSelection();       // reads PIWI_SELECTION, returns grep or undefined
export default wrapConfig(defineConfig({ grep: selection?.grep, /* … */ }));
```

Everyone else uses `piwi run`. No hidden network calls inside config loading; the wrapper stays predictable.

### Stamping the run

A run produced from a selection records it. `FilterDetails` (in
[`@piwitests/core/wire`](../packages/core/src/wire.ts), re-exported to both sides, guarded by
`wire-shared-drift.test.ts`) gains one optional field:

```ts
selection?: { key: string; version: number; resolvedHash: string; resolvedCount: number };
```

The reporter reads the `PIWI_SELECTION_*` env vars `piwi run` (or `resolveSelection`) set and passes them through the
existing `filterDetails` path in the serializer and stream manager — a small, additive wire change, which is exactly
the kind to land **before** the 1.0 wire freeze ([`proposals/1.0-stabilization.md`](1.0-stabilization.md)) rather
than after. `is_full_run` stays 0 for such runs, but the run list and run detail can now say *which* partial run this
was: `smoke@v7 · 42/42 resolved tests ran` instead of today's anonymous grep string.

Stamping is what turns selections from a convenience into a closed loop:

- **Gate**: `piwi gate --require-selection smoke` — server-side policy: the run claims smoke@vN, the server
  re-resolves smoke@vN's definition, and every test currently matching must have run and passed in this run. This
  catches the failure mode tags cannot: the silently shrinking smoke job (renamed file, changed title, over-narrow
  grep). It composes with the existing policy flags (`requireTags`, `maxNewRegressions`, …) in `GatePolicy`
  (`@piwitests/core/gate`).
- **PR feedback** comments can lead with `✓ smoke (42 tests, 3m 10s)` — the summary line reviewers actually want.
- **Analytics**: selection runtime and stability trends per key ("smoke got 40 s slower this month") fall out of the
  stamp plus existing run aggregates.

### Dashboard

A **Selections** tab per project:

- **Builder** — predicate form on the left, live preview on the right: matched tests, estimated duration
  (`Σ avgDuration`), warnings (quarantine overlap, budget evictions), and the exact command to copy. The preview is
  just the resolve endpoint; the copy button is `buildRetryCommand` fed with the resolution.
- **Save from any filtered view** — the test-case catalog, the flaky leaderboard and cluster detail pages already
  have rich filters; a "Save as selection…" action seeds a definition from the current filter state. A cluster page
  gets "Run these tests" for free (a one-off unsaved selection resolved to a command — the retry command generalized).
- **Health strip per selection** — last resolved count vs. last executed count, quarantined members, tests matched
  by no selection at all ("unselected tests" is the drift metric nobody can see today).

Demo-mode note: every new server route needs its mirror in `app/demo/api/` (`app:check:demo` enforces this).
Resolution is pure SQL over the catalog, so the demo SPA can run the full feature — worth doing, since the demo is
where prospects will first meet it.

### MCP

Three tools in the registry ([`shared/mcp-tools.ts`](../apps/application/shared/mcp-tools.ts), handlers in
`server/utils/mcp/tools.ts`): `list_selections`, `preview_selection` (definition in, resolution + warnings out —
also the path for ad-hoc definitions an agent composes), `resolve_selection` (key in, test list + ready-to-run
command out). An agent that just landed a fix asks for `impact` scoped to its diff and gets back the exact
verification command — the fix-plan idea, generalized. The docs-drift test pins the documented tool count in
`mcp.md`, so the registry, handlers and docs move in one commit. The `piwi skills` templates gain a matching
"run the right tests" skill.

## Layer 3 — intelligence: suggestions

Everything below is **suggest-only**: surfaced with evidence, never auto-applied. Suggestions are computed by a
scheduled task (the nightly Nitro task pattern retention already uses) and on demand from the Selections tab.

### Suggested tags

Each suggestion is `{ testCaseId, tag, confidence, evidence[] }` — the evidence is the argument, in the dashboard's
existing show-your-work style (flaky root causes, cluster diagnoses and healing candidates all do this):

- **`@smoke` candidates** — see the mining below.
- **`@slow`** — tests whose `avgDuration` sits past the suite's p95 with meaningful `wasted_time_ms`; evidence:
  duration trend, slowest step.
- **Feature tags** — cluster tests by shared `normalized_url` route families and `page_state` URL prefixes; tests
  that consistently hit `/api/checkout/**` and `/checkout` pages but carry no `feature` annotation get
  `feature: checkout` proposed. Evidence: the route list.
- **Priority candidates** — tests whose failures historically anchor large clusters or block many dependents
  (`blocked_by` cascades) but are marked low/no priority.

### Smoke mining: a budgeted set cover

"Suggest a smoke suite" has a precise form with the data at hand. Coverage units: distinct `normalized_url` routes
(fetch/xhr), `page_state` URL prefixes, and `test_source_frames` in-project files. Candidate pool: tests with a
pass-rate floor (say ≥ 99% over the window, not quarantined, not flaky). Weight: historical early-detection — tests
that were *first* to fail in clusters that later grew (the `is_new_regression` rows already mark first failures).
Greedy weighted set cover under a wall-clock budget (`Σ avgDuration ≤ budget`) yields the classic diminishing-returns
curve: each added test buys fewer new routes. The UI shows exactly that curve and lets the user cut it at 3, 5 or
10 minutes. Honest label on the tin: coverage here is *observed behavior* (routes, pages, files the test actually
touched on recent runs), not instrumented code coverage — an approximation, and a good one for smoke's purpose,
which is breadth over entry points.

### Impact-from-diff: `piwi run impact --base origin/main`

The SCM layer (`server/utils/scm/`) already fetches commits and diffs for AI diagnosis. Impact selection maps a diff
to tests through three observed edges, cheapest first:

1. changed spec/support files → tests defined in or reached through them (`test_source_frames` paths),
2. changed server route files → tests whose `network_requests.normalized_url` hit those routes (route ↔ file mapping
   configurable per project; for Nitro/file-based-routing backends it is derivable),
3. changed frontend pages/components → tests whose `page_state` visited matching URL prefixes.

Union, plus `inOpenCluster` and `failedInLastRuns` for focus, minus quarantine. Again honestly labeled: this is
evidence-based impact, not static analysis — it degrades to "run more than strictly needed", never to "silently skip
the one test that mattered", because unmapped changes widen the selection to full suite (with a warning) rather than
narrowing it.

### Applying suggestions back — two ramps, both explicit

A suggestion the user accepts becomes either:

1. **A selection** (dashboard-side, instant, reversible; no source change) — the default ramp. Or:
2. **A tag pull request** — Piwi edits the spec files: `@smoke` appended to the title or a
   `{ tag: ['@smoke'] }` option added, one deterministic edit per accepted test, opened as a draft PR. The machinery
   is precedented end to end by auto-heal PRs: deterministic line edits with a head-content guard (a drifted line is
   dropped, never mis-patched — `shared/heal-edit.ts`), per-project allowlist, draft by default, evidence-rich body.
   Same rules, new payload.

The philosophy line this preserves: **Playwright source stays the source of truth for tags** (that is the shipped
model — tags come from titles or the `tag` option, the dashboard stores what the run declared). Piwi never grows
dashboard-only tags that drift from the code. A suggestion either lives openly as a selection or lands in the source
via review. And the two compose into a lifecycle: mine → adopt as a selection → let it stabilize → commit it as tags
via PR → the selection rule collapses to `tags: ["smoke"]`, and from that day plain `npx playwright test --grep @smoke`
works with no Piwi server in the loop. Piwi bootstraps the convention, then gets out of its way — the least
lock-in-shaped version of this feature that exists.

## Storage & API

One new table, both dialects (`schema.sqlite.ts` + `schema.pg.ts`):

```
test_selections
  id, project_id FK, key (unique per project), name, description,
  definition JSON, version, created_by FK users, created_at, updated_at, archived_at
```

Pins live inside the definition JSON (they are definition, and they version with it). No per-test membership rows —
resolution is computed, never stored; the only persisted artifact of a resolution is the stamp on the runs it
produced. Suggestions v1 are computed on demand and cached in memory; a `selection_suggestions` table only if digest
notifications need durable state.

Endpoints (all project-scoped through the existing `project-access.ts` guards; resolve readable by reporter API
keys, mutations by member+):

```
GET/POST       /api/projects/:id/selections
GET/PATCH/DELETE /api/projects/:id/selections/:key
POST           /api/projects/:id/selections/:key/resolve      # + ?format=…&budget=…&shard=…
POST           /api/projects/:id/selections/preview           # ad-hoc definition in body
GET            /api/projects/:id/selections/suggestions       # tags + smoke candidates, with evidence
POST           /api/projects/:id/selections/suggestions/apply # → selection | tag-PR
```

Retention interplay: definitions are configuration, not history — never pruned. Aggregates behind resolution degrade
gracefully as old runs are pruned (a test with no surviving runs simply has no duration estimate). Imported runs
(`importing-runs.md` — deliberately silent) are never selection-stamped.

## What this deliberately is not

- **Not instrumented test-impact analysis.** No per-test code-coverage maps, no build-time dependency graphs. The
  impact and smoke features work from *observed* evidence (routes, URLs, frames) and say so in the UI. Wrong in the
  safe direction by construction: uncertainty widens the selection.
- **Not an execution scheduler.** Playwright owns ordering and parallelism. Ranked materialization can influence
  scheduling (file order, shard composition) and that is documented as best-effort; no promises about intra-worker
  order.
- **Not a way to hide failures.** Quarantine is the verdict tool; selection is the execution tool. A selection never
  suppresses a result that ran, and the builder warns when a rule would *exclude* a test currently in an open
  regression. The full suite remains the scheduled baseline; selections exist so the fast loops between full runs
  are chosen by data instead of folklore.
- **Not auto-committed.** No tag edit reaches a branch except through the reviewed PR ramp.
- **Not a service.** Everything resolves on your instance against your data — consistent with "self-hosted, MIT,
  zero telemetry" and the no-SaaS non-goal.

## Interactions worth designing, not discovering

- **Regression baselines on partial runs.** `compute-regression-signals.ts` compares against baseline runs; a
  selection-stamped run should compare per-test (same test, last executed) rather than per-run, or new-regression
  counts on smoke runs will mislead. Needs a decision in M1, not a bug report in M3.
- **`is_full_run` semantics.** Today partial = second-class (some analytics exclude partial runs). A
  selection-stamped run is *intentionally* partial; surfaces that filter on `is_full_run` should learn the
  distinction (e.g., trends per selection key rather than exclusion).
- **1.0 freeze order.** The `FilterDetails.selection` field and the resolve response format are wire/API surface —
  land them (or explicitly defer them) as part of the stabilization pass, not right after it.
- **Auth.** Resolve is read-only but reveals test inventory; it authenticates like other project reads. The CLI
  already carries `PIWI_API_KEY` for `gate`, so no new credential shape.

## Milestones

- **M1 — the model and the CLI.** `test_selections` table + CRUD + resolver with the catalog predicates (tags,
  owner, priority, files, text, quarantined, flaky, pass rate, duration, lastStatus, failedInLastRuns), built-ins
  (`failed`, `quarantine-free`), materialization via the extended retry-command ladder, `piwi select` / `piwi run`
  (fallback + cache + `--strict`), run stamping through `FilterDetails.selection`, docs. Usable end to end from the
  terminal with zero UI.
- **M2 — the loop.** `--require-selection` gate policy, Selections tab with builder/preview/copy/save-from-filter,
  cluster-page "run these tests", MCP tools + skills template, demo handlers, PR-feedback summary line.
- **M3 — the intelligence.** Suggested tags with evidence, smoke mining with the budget curve UI, `@slow`/feature
  suggestions, budget + duration-balanced `--shard`, impact-from-diff behind a per-project route-mapping config.
- **M4 — the ramps.** Tag PRs on the auto-heal machinery, suggestion digests through notifications, selection
  health/drift analytics ("unselected tests", runtime trend per key), ranked materialization for fail-fast.

## Open questions

1. **Grep vs. file-line as default materialization.** File-line is precise but brittle across uncommitted local
   edits (line drift); grep survives edits but can over-match duplicated titles across Playwright projects. The
   retry command already defaults to file-line and downgrades on length — is the same right default here, or should
   `piwi run` prefer grep locally (drifty working trees) and file-line in CI (clean checkouts)?
2. **Per-Playwright-project resolution.** A test matched in `chromium` and `firefox` is one `test_case` row with two
   browsers of history. Does a selection resolve per PW project (and `piwi run` pass `--project` per group, as
   `buildRetryCommand` does), or leave project scoping entirely to the caller?
3. **Route ↔ file mapping for impact.** Derivable for file-routed backends (Nitro, Next); arbitrary routers need
   per-project glob→route hints. Is a `piwi.impact.map` config in the dashboard enough, or does the Nitro
   instrumentation package (`integrations/nitro/`) grow the mapping export?
4. **Where suggestions run.** Nightly task per project vs. on-demand only — the set cover is cheap at typical suite
   sizes (thousands of tests, tens of thousands of route rows) but the first computation on a big instance isn't
   free.
5. **Naming the built-ins.** `failed` collides conceptually with Playwright's own `--last-failed` (local, from
   `.last-run.json`); worth either adopting their name for familiarity or picking distance (`recent-failures`) to
   avoid implying identical semantics.
6. **Selection-scoped notifications.** "smoke broke" is a sharper subscription than "a run failed" — does
   `subscriptions.filters` grow a selection key, and does that wait for demand?
