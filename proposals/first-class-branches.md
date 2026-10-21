# First-class branches

A proposal to promote the git branch from a display string inside a run's `metadata` JSON to a reliable, queryable,
analysis-bearing dimension — and, in its final stage, to an entity with a lifecycle. The document argues the case,
stages the work so each stage pays for itself, and records the alternatives and open questions.

**Status.** Tiers 1 and 2 have shipped: the reporter resolves the branch from the CI provider's variables instead of
recording a detached `HEAD`, honors a `PIWI_BRANCH` override and captures the pull-request number; `test_runs` carries
an indexed scalar `branch` column; projects carry a `defaultBranch`, resolved from the SCM provider when unset; runs,
the flaky leaderboard and the MCP tools take a `branch` filter; regression baselines and the visual-diff baseline
prefer the same branch, then the default branch; and PR feedback exonerates a test that is also flaky on the default
branch. The flaky leaderboard, Analytics and the project tabs read the default branch by default (2026-10-19). Still
open from Tier 2: locator-healing candidates preferring the same branch, and quarantine release streaks counted on
default-branch runs. Tier 3 — branches as entities, the merge-readiness verdict, branch-class policies and retention
— has not shipped and stays under *Exploring* in [`ROADMAP.md`](../ROADMAP.md). The design below is the original text.

**Summary.** Branch is already load-bearing: pull-request feedback, the auto-heal policy, notification filters and
the run-comparison diff all read it. But it is collected in a way that records the literal string `HEAD` on most CI
pull-request builds, stored only inside the `metadata` JSON blob where nothing can index or filter it, and ignored by
exactly the analysis that most needs it — baseline selection compares runs across unrelated branches. The proposal has
three tiers. **Tier 1** makes the value true and queryable: a CI-aware collection fallback in the reporter, a scalar
`branch` column on `test_runs` (the same promotion `browser_name` already went through, backfill included), a
server-resolved default branch, and a `branch` filter across the query surface. **Tier 2** makes analysis
branch-aware: same-branch baselines with a default-branch fallback, default-branch-scoped flakiness and trends, and
"already flaky on the default branch" exoneration in PR feedback. **Tier 3** makes branches entities with SCM-synced
lifecycle, enabling a merge-readiness verdict, branch-class gate policies, cross-branch fix verification and
retention by branch class. Tiers are independently shippable; each stops at a coherent place.

## Problem

Four defects, all consequences of branch never having been designed as data.

### 1. CI runs record the branch as literally `HEAD`

`collectScmInfo` (`packages/reporter/src/internal/collect/metadata-collector.ts`) resolves the branch with
`git rev-parse --abbrev-ref HEAD` and nothing else. CI pull-request builds — GitHub Actions' `actions/checkout`,
GitLab merge-request pipelines, most others — check out a detached HEAD, so the recorded branch is the literal string
`HEAD`. The collector already detects seven CI providers and stores `ci.ref` for GitHub, but never consults the
provider's branch variables (`GITHUB_HEAD_REF`, `CI_COMMIT_REF_NAME`, `BITBUCKET_BRANCH`, …) when git's answer is
useless. In the most common deployment — Piwi fed from CI — the value every branch feature depends on is wrong.

### 2. The default branch is documented but never collected

`server/utils/run-json-types.ts` documents `metadata.defaultBranch` as "recorded at the top level by the reporter";
the reporter has no such code. The field exists only when a user hand-adds it to the reporter's `metadata` option.
Consumers each cope alone: `run-notifications.ts` assumes `'main'`, and the auto-heal policy
(`server/utils/heal/policy.ts`) **skips its default-branch guard entirely** when the field is absent — the one
feature that opens pull requests autonomously silently loses the check that was designed to constrain it.

### 3. Baseline selection is branch-blind

Both `computeRegressionSignals` (`server/utils/compute-regression-signals.ts`) and the last-green lookup behind
regression context and AI diagnosis (`server/utils/regression-context.ts`) pick "the most recent passing run in the
project", regardless of branch. Two feature branches reporting interleaved runs become each other's baselines. The
consequences compound: false `isNewRegression` / `isNewFlaky` flags on executions, a wrong "new failures" vs
"pre-existing" split in the PR comment (`server/utils/scm/pr-feedback.ts` builds it from those flags), a CI gate rule
(`max-new-regressions`) firing on the wrong count, and an AI diagnosis fed "what changed since last green" as a diff
between two commits that never shared a branch.

### 4. Branch is not queryable

`test_runs` has no branch column — only `metadata` JSON. No runs-list, analytics, flaky or history endpoint accepts a
branch parameter. The MCP `list_test_runs` tool does offer one, and its implementation documents the cost
(`server/utils/mcp/tools.ts`): *"Branch lives inside JSON metadata — can't index it efficiently, so the branch-filter
path fetches a larger batch and filters in-memory"* — a 3× over-fetch to answer a filter the database should serve.
Meanwhile `environment`, the equivalent run dimension, is a real column threaded as a parameter through the flaky and
performance analysis (`shared/handlers/projects.ts`), and executions got a scalar `browser_name` "for index
efficiency" with a backfill migration (`server/database/migrations/0033_backfill_browser_name.sql`). Branch is the
one dimension of a run that never received the treatment the codebase already applies elsewhere. The practical
consequence: one noisy work-in-progress branch pollutes the project's flakiness scores, pass-rate trends and
analytics, and no view can say "default branch only".

## What reads branch today

| Consumer | Reads | Behavior when branch is `HEAD` / absent |
|---|---|---|
| PR feedback (`server/utils/scm/pr-feedback.ts`) | run branch → open PR lookup | finds no PR; feature silently inert |
| Auto-heal policy (`server/utils/heal/policy.ts`) | branch + `defaultBranch` | guard skipped when `defaultBranch` unset |
| Notifications (`shared/notification-events.ts`) | `filters.branches`, `defaultBranchOnly`, `run.failed.default_branch` | filters never match; default-branch event guesses `'main'` |
| Run comparison / regression context | `metadata.scm.branch` | "Branch" diff row compares `HEAD` to `HEAD` |
| AI context (`server/utils/ai-context.ts`) | one context line | model told the branch is `HEAD` |
| MCP tools (`server/utils/mcp/tools.ts`) | branch filter, SCM commit listing | in-memory filter; `HEAD` never matches |
| Cluster commit picker (`app/components/cluster/CommitPicker.vue`, `failure-clusters/[id]/branches.get.ts`) | live SCM branch list | works (provider API, not run data) |
| Demo (`app/demo/simulator.ts`, `demo-scm.ts`) | simulated branches | n/a — the demo already models what production data lacks |

The pattern: every feature built on branch either degrades silently or carries private fallback logic. None of them
can be fixed where they stand; they share one upstream defect.

## Design

Three tiers. Each is shippable alone, each makes the next one smaller, and the argument for the next tier can be
re-evaluated after the previous one lands.

### Tier 1 — make the value true, then queryable

#### Collection (reporter)

`collectScmInfo` resolves the branch through a fallback chain instead of trusting git alone:

1. **`PIWI_BRANCH`** — explicit operator override, for CI setups the chain does not cover.
2. **Provider variables**, keyed off the CI detection `collectCiInfo` already performs: `GITHUB_HEAD_REF` (set on
   pull-request events) else `GITHUB_REF_NAME`; `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` else `CI_COMMIT_REF_NAME`;
   `BITBUCKET_BRANCH`; `CIRCLE_BRANCH`; `TRAVIS_PULL_REQUEST_BRANCH` else `TRAVIS_BRANCH`;
   `SYSTEM_PULLREQUEST_SOURCEBRANCH` else `BUILD_SOURCEBRANCHNAME`; Jenkins `CHANGE_BRANCH` else `BRANCH_NAME`.
3. **git**, as today — with the literal answer `HEAD` treated as "unknown", not as a branch name.

The same pass captures the **pull-request number** where the provider exposes it (`GITHUB_REF`'s `refs/pull/N/merge`,
`CI_MERGE_REQUEST_IID`, `BITBUCKET_PR_ID`, `SYSTEM_PULLREQUEST_PULLREQUESTNUMBER`, Jenkins `CHANGE_ID`) into
`metadata.scm.prNumber`. PR feedback currently discovers the PR by asking the provider which open PR has this source
branch; a captured PR number makes that lookup exact and gives Tier 3 the branch→PR link for free.

All of this is additive `metadata` content — no wire-format break (see "1.0 timing" below).

#### Storage (server)

- A **`branch` text column on `test_runs`** in both `schema.sqlite.ts` and `schema.pg.ts`, nullable, populated at
  ingest from the submitted metadata (`setup` / `start` / `submit` / `upload` and the import path all funnel run
  creation), plus an index on `(project_id, branch, start_time)`.
- A **backfill migration** copying `json_extract(metadata, '$.scm.branch')` (SQLite) /
  `metadata->'scm'->>'branch'` (PostgreSQL) into the column for existing rows — the exact shape of
  `0033_backfill_browser_name.sql`, which is the in-repo precedent for promoting a JSON field to a scalar. Rows whose
  metadata says `HEAD` backfill as null rather than as a fake branch.
- Migrations generated via `npm run db:generate` / `db:generate:pg`, never hand-written, per
  [apps/application/AGENTS.md](../apps/application/AGENTS.md).

The JSON field stays; the column is a queryable projection of it, exactly as `browser_name` projects `browser`.

#### Default branch (server-resolved, not per-run)

A repository's default branch is a property of the project, not of a run. Resolution order:

1. An explicit **project setting** (new nullable column on `projects`, editable in project settings).
2. The **SCM provider API** — GitHub, GitLab and Bitbucket all expose it (`default_branch` / `mainbranch.name`), and
   `ScmProvider` implementations for all three already exist under `server/utils/scm/`; this adds one method,
   fetched lazily and cached on the project row.
3. The reporter's `metadata.defaultBranch` hint, kept for compatibility with users who set it today.
4. `'main'`, as the documented last resort — today's scattered fallbacks (`run-notifications.ts`, `heal/policy.ts`)
   collapse into one resolver they all call.

#### Query surface

- `branch` filter parameter on the runs list, the analytics widgets, flaky tests, spec health and test-case history —
  threaded exactly as `environment` already is in `shared/handlers/projects.ts`.
- The MCP `list_test_runs` branch filter switches from over-fetch-and-scan to the indexed column; tools that echo run
  metadata read the column.
- UI: the branch shown on run and execution pages becomes a clickable filter chip; the runs page gains a branch
  dropdown beside the environment one. A "default branch only" toggle becomes possible anywhere trends render.

Tier 1 alone fixes defect 1, 2 and 4 and makes every existing branch consumer work on CI data.

### Tier 2 — branch-aware analysis

All server-side query changes; no schema work beyond Tier 1.

- **Baseline selection** (`compute-regression-signals.ts`, `regression-context.ts`): prefer the most recent passing
  run **on the same branch**; when none exists (first run of a fresh branch — the common case for a new PR), fall
  back to the most recent passing run **on the default branch**, which is the state the branch forked from. Runs with
  unknown branch keep today's behavior. This turns "new failure" from *new since whatever ran last* into *new
  relative to this branch's own history, else relative to the trunk* — which is what the PR comment, the
  `max-new-regressions` gate rule and the AI diagnosis diff all mean to say. A merge-base-precise baseline (asking
  the SCM provider for the fork point) is a refinement listed under open questions; the default-branch fallback is
  already right for the overwhelming case and needs no SCM call.
- **Flakiness and trends scope to the default branch by default.** The flaky leaderboard, stability trends and
  pass-rate analytics read default-branch runs unless a branch filter says otherwise — a work-in-progress branch
  stops contaminating the project's health signal. The quarantine flow inherits this: quarantine evidence and release
  streaks count default-branch runs.
- **Flake exoneration in PR feedback.** With trustworthy branch data, the PR comment can annotate a failure that is
  *already flaky on the default branch*: "failing here, but flaky on `main` for the last N runs — likely not yours."
  The data (per-test flakiness over recent default-branch runs) exists once the leaderboard is branch-scoped; this
  is a presentation change in `shared/pr-feedback.ts`.
- **Evidence locality for healing and visual comparison.** Locator-healing candidates and the visual-diff baseline
  (`server/utils/visual-diff.ts` picks "most recent passing execution") prefer same-branch runs before falling back
  to the default branch — a branch that intentionally redesigns a page stops being diffed against the old design.

### Tier 3 — branches as entities

The expansion tier. Everything above treats branch as a scalar; this tier gives it identity and lifecycle, and is
the part to re-argue once Tiers 1–2 are in and real usage shows where it hurts.

#### Table

A `branches` table in both schemas:

| Column | Notes |
|---|---|
| `id` | PK |
| `project_id` | FK → `projects`, cascade delete, unique with `name` |
| `name` | the branch name as reported |
| `kind` | `'default'` \| `'release'` \| `'feature'` \| `'bot'` — classified by pattern (`release/*`, `renovate/*`, `dependabot/*`, heal branches by their own prefix) |
| `state` | `'active'` \| `'merged'` \| `'deleted'` \| `'stale'` |
| `first_seen_at` / `last_run_at` | maintained at ingest |
| `last_commit_sha` | from the newest run's metadata |
| `pr_number` / `pr_url` / `pr_state` | from reporter capture (Tier 1) or provider lookup |

Runs keep the scalar `branch` column as the source of truth and join by `(project_id, name)` — no FK backfill, no
second write path, and imported runs never create entity side effects beyond the name row (imports stay silent, per
the import feature's own rule). Rows are created lazily at ingest; lifecycle fields refresh lazily (on ingest, and
on-demand when a branch page or comparison is opened) through the existing `ScmProvider` abstraction. No background
sync daemon: a self-hosted instance without an SCM token simply has branches that are always `active`, and every
feature below degrades to Tier 1/2 behavior.

#### What it unlocks

- **Merge readiness** — the flagship. One view, one gate rule, one MCP tool answering: *what does merging this
  branch change about test health?* New failures the default branch does not have; clusters this branch fixes
  (fix verification already records "passes again" per cluster — scoped to the branch it passed on); flakiness the
  branch introduces; duration deltas. PR feedback already computes most of this per run — merge readiness promotes it
  from a comment to a queryable verdict (`piwi gate --merge-ready`, and an MCP tool so an agent iterating on a PR can
  ask "did my fix hold, and did I break anything `main` doesn't already have?"). This is the roadmap's third purpose
  — "leave with something to do" — applied to the merge decision itself.
- **Branch-class policies.** The CI gate and quarantine become configurable per branch kind: strict on default and
  release branches, lenient on feature branches, pattern-based overrides. Today's single global policy is the
  special case "every branch is the default branch".
- **Cross-branch fix verification.** A cluster verified fixed on a feature branch re-arms verification for the
  default branch; when the merge lands and the default branch goes green on those tests, the fix is confirmed where
  it counts — closing the loop `fix-verification.ts` currently closes only within one branch's runs.
- **Retention by branch class.** `PIWI_RETENTION_DAYS` is one number for all runs. With branch state, retention can
  keep default- and release-branch history long while pruning merged/deleted feature branches aggressively — "keep
  the history" (the roadmap's first purpose) made affordable on busy repositories, because the history worth keeping
  is mostly trunk history.
- **A branch page and honest navigation.** Runs, health, failures unique to the branch vs the default, the linked
  PR and its state, time-to-green, CI minutes spent. Notification `filters.branches` autocompletes against real
  branches instead of free text.

## 1.0 timing

`proposals/1.0-stabilization.md` (D4) records that the reporter↔server exchange has no wire versioning and that
unknown fields are ignored. Everything Tier 1 sends is additive metadata (`scm.branch` with better semantics,
`scm.prNumber`), so no compatibility break is involved in any tier. The timing argument is softer but real: the
stabilization effort is the moment the *meaning* of wire fields gets written down. `scm.branch` should be pinned as
"the logical branch, never `HEAD`, resolved by the documented chain" — and `defaultBranch`'s false documentation
corrected to match wherever resolution actually lands — before the format's semantics freeze, not after.

## Compatibility and degradation

- **Branch stays nullable everywhere.** Local runs without git, exotic CI, imported archives from before the change —
  every feature must degrade to today's behavior on null, and "unknown branch" is displayed as such, never as `HEAD`.
- **Fork pull requests** can present the same branch name from different repositories. The entity keys on
  `(project_id, name)` regardless; the PR link disambiguates. Recorded honestly as a known imprecision — a Piwi
  project maps to one repository in practice.
- **Both databases.** Every schema change lands in `schema.sqlite.ts` and `schema.pg.ts` with generated migrations;
  the backfill ships for both dialects.
- **Demo.** The simulator already models branches and a default branch (`app/demo/simulator.ts`, `demo-scm.ts`);
  demo handlers for endpoints that gain a `branch` parameter must honor it, and `npm run app:check:demo` keeps any
  new endpoint covered or explicitly excluded.
- **Docs.** `ci.md`, `reporter.md`, `concepts.md` (branch/default-branch vocabulary), `notifications.md`,
  `auto-heal.md` and the regression-vs-flaky recipe all touch branch behavior today and update with their tiers; the
  API reference is generated.

## Alternatives considered

1. **Index the JSON instead of promoting a column.** SQLite supports expression indexes on `json_extract(...)` and
   PostgreSQL can index `jsonb` paths, so the filter cost could be fixed without a column. Rejected: the two dialects
   diverge (the app deliberately keeps schemas parallel), Drizzle's schema story for expression indexes is weaker
   than for columns, and a column is what makes the value part of the API surface (select lists, group-bys, the MCP
   tools) rather than a query trick. `browser_name` set the precedent and it has held up.
2. **Fix collection server-side only** (derive branch from `ci.ref` at ingest, leave the reporter alone). Rejected:
   only GitHub's ref is stored today, the mapping is provider-specific knowledge the reporter already has (it
   detects the provider), and a reporter-side fix also serves the reporter's own features (the gate's messages, local
   output). The server still normalizes defensively at ingest.
3. **An FK from runs to the branches table** instead of a scalar name column. Rejected for Tier 1: it couples basic
   queryability to the entity tier, complicates imports and backfill, and creates a second source of truth. The
   scalar column plus a lazy entity row joined by name keeps each tier droppable.
4. **A PR-first model** (make the pull request the entity, branch an attribute). PRs are where feedback lands, but
   they are provider-specific, optional (trunk-based teams, local runs) and short-lived; every run has a branch —
   only some have a PR. Branch is the universal key; the PR attaches to it. Merge readiness reads identically either
   way.
5. **Do nothing and document the limitation.** The status quo is not neutral: it is false regression flags, an AI
   diagnosis reading cross-branch diffs, and an auto-heal guard that silently disarms. The features already shipped
   assume branch data that is not actually there.

## Open questions

- **Merge-base precision.** Is "latest default-branch green" a good enough baseline for fresh branches, or should the
  server ask the SCM provider for the fork point when a token is available? Proposed: ship the cheap fallback,
  measure how often it misleads (a branch far behind the trunk), decide with data.
- **Default scope of the flaky leaderboard.** Default-branch-only by default is the honest health signal, but it
  changes numbers people may be watching. Ship behind a visible toggle with the default flipped, or flip silently?
- **Bot-branch classification.** Which patterns ship built-in (`renovate/*`, `dependabot/*`, the heal prefix), and is
  the list per-project configurable?
- **`stale` semantics.** Time-based (no runs in N days), SCM-based (branch deleted upstream), or both? Affects
  retention-by-class defaults.
- **Where branch-class gate policies live.** Reporter options travel with the repo (versioned, reviewable); app
  settings are operator-owned. The gate reads both today; policies probably follow the same split, but the boundary
  deserves its own writeup inside the Tier 3 design.

## Rollout sketch

1. **Reporter collection** — the fallback chain, `PIWI_BRANCH`, `HEAD`-as-unknown, PR-number capture; unit tests over
   a provider-variable matrix in `packages/reporter/tests/`. Independently useful, no server change required.
2. **Column + backfill + filters** — schema change in both dialects, generated migrations, the backfill, ingest
   population, `branch` parameters on runs/analytics/flaky/history endpoints, the MCP filter fix, clickable branch
   chips. E2E coverage extends `tests/metadata.spec.ts` and the runs-list specs.
3. **Default-branch resolver** — project column, provider fetch, settings UI; `run-notifications.ts` and
   `heal/policy.ts` switch to it. The auto-heal guard stops depending on user-supplied metadata.
4. **Branch-aware baselines** — `compute-regression-signals.ts` and `regression-context.ts`; regression-context and
   fix-verification specs grow branch scenarios (`tests/regression-context.spec.ts` already exercises this area).
5. **Scoped analytics + flake exoneration** — leaderboard/trends scoping, the PR-comment annotation.
6. **Entity tier** — table, lazy lifecycle, merge readiness (view → gate rule → MCP tool), branch-class policies,
   retention by class, the branch page. Each piece its own change, re-sequenced by whatever Tiers 1–2 teach.
