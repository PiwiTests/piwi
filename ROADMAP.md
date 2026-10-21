# Roadmap

Piwi Dashboard is under active development (pre-1.0). This page shows direction, not promises — priorities shift with feedback, and the best way to influence them is a [GitHub Discussion](https://github.com/PiwiTests/platform/discussions).

## What Piwi is for

Everything below is in service of four things, in this order. When a proposed feature doesn't strengthen one of them, that's the argument against building it.

1. **Keep the history.** CI deletes every report it makes. Piwi keeps every run, trace and report, so "has this always been flaky?" and "did my fix hold?" are answerable at all.
2. **Explain the failures.** Group them by root cause so forty red tests become three problems, score the flaky ones by what they actually cost, and — optionally — have an LLM explain a cluster against your real diff.
3. **Hand back a fix.** A ranked replacement locator, a validated patch, an owner, a command that verifies the work. The point is to leave with something to do, not just something to read.
4. **Find what your tests miss.** The runs you already have show the routes, pages and controls no test reaches, and the ones a test reaches without noticing when they break. Each gap comes with a skeleton to start the missing test from.

Everything else — analytics, quality reports, notifications, the CI gate, PR feedback, MCP, the desktop app — is a delivery route for those four. That's the ranking the UI follows too: the dashboard leads with results and failures, and the supporting lenses sit behind them.

## Recently shipped

- **Project roles and groups**: five project roles (Viewer, Contributor, Maintainer, Project admin, Uploader), granted
  to users or groups per project or on all projects, replace the three global roles, so a product owner can file an
  issue without triage or upload rights. [proposals/roles-and-groups.md](proposals/roles-and-groups.md); see
  [access, roles and groups](https://piwitests.dev/operate/project-access).
- **Quality reports, dashboards and trends over time**: a plain-language report of a suite's health for people who
  do not open the dashboard (pass rate and its movement, wasted CI time and what it costs, open failure causes and how
  long they take to fix), generated from the same numbers the Analytics page shows, downloadable as HTML, PDF,
  Markdown, JSON or CSV, delivered on a schedule by email, Slack, Microsoft Teams, webhook or browser notification, in
  English or French, and readable through `piwi report` and MCP. Underneath: daily rollups that keep long-term trends
  after retention prunes the runs; filters (test selections, tags, owners, browsers) and periods (calendar periods,
  custom ranges, release cycles, sprints) carried by the URL; saved and shared dashboards with TV mode for a wall
  screen; the default branch as the default scope, per-project targets, and trend widgets for suite growth, flaky
  debt, time to fix and ownership. The same schedules deliver the Test Map's weekly gaps digest. Publishing a report
  to Confluence waits for the wiki connection (see *Issue trackers, the rest*). Design record in
  [adr/analytics-and-reporting.md](adr/analytics-and-reporting.md); see
  [analytics](https://piwitests.dev/features/analytics), [dashboards](https://piwitests.dev/features/dashboards) and
  [quality reports](https://piwitests.dev/features/quality-reports).
- **Scenario gaps and the Test Map** — one graph per project of what the application exposes, what the suite reaches
  and what it would actually notice, turned into the tests that do not exist yet: ranked by exposure, each with a
  skeleton to start from. Surfaced as a Gaps tab with a feature map and an ego graph view, a per-ticket section in the
  pull-request comment, and MCP tools that hand an agent a draft; client probes mutate responses at the Playwright
  route boundary to catch false comfort, and server probes (experimental, off by default) inject a fault inside the
  server. Optional — decline the Test Map per project or instance-wide and its surfaces disappear.
  [adr/scenario-gaps.md](adr/scenario-gaps.md); see
  [scenario gaps](https://piwitests.dev/features/scenario-gaps).
- **Issue tracking with Jira** — file a Jira issue from a failure or a failure cluster with the evidence and the fix
  plan already in the body, keep it linked as the known issue, and let Piwi keep it honest: a background sync task and
  an optional inbound webhook carry status both ways under per-project policies (comment on fix or regression,
  transition, resolve on close), a `needs-ticket` inbox queue lists the clusters still without one, tickets are written
  in the destination's language (English or French), and the `create_issue` MCP tool does the same for agents.
  Per-project rules file an issue on their own for a failure that persists on the branches and environments a team
  picks (occurrences, runs, days, test tags; never a flaky one, under a daily cap, previewed before saving), and keep
  its comments and description current without overwriting an edit made in Jira. Jira Cloud first, on a provider
  layer that makes the next tracker one file. Steps 1–3 and the automatic creation of step 4 of
  [proposals/issue-tracker-integrations.md](proposals/issue-tracker-integrations.md); see
  [issue tracking](https://piwitests.dev/features/issue-tracking) and
  [issue automation](https://piwitests.dev/features/issue-automation).
- **Deterministic failure clues and rebuilt failure pages** — a rules engine explains every failure in one line before
  the raw error, with no AI configured. The execution, cluster, run, project and history pages were rebuilt around one
  situation block (what most likely happened, and the next step), tabbed evidence and a folded fix toolbox; a
  page-structure diff compares the failing ARIA snapshot with the last green run; and a failure inbox on Home lets you
  filter, assign, snooze, quarantine and bulk-triage open clusters across projects, also through MCP.
  [adr/failure-experience-audit.md](adr/failure-experience-audit.md) and
  [adr/ui-simplification.md](adr/ui-simplification.md); see
  [the UI overview](https://piwitests.dev/features/ui-overview).
- **Environment-aware baselines** — every run-level comparison (the Changes tab, regression signals, the CI gate, PR
  feedback, the bisect window, AI diagnosis) picks its baseline through one ladder: the same environment first, then
  the same branch, then the base branch the run forked from (the pull request's target branch, captured by the
  reporter as `scm.baseBranch`), then the project's default branch. The Changes tab names the baseline it chose and
  offers a base-branch picker. See [run changes](https://piwitests.dev/features/run-changes).
- **Failing step on the timeline** — the failing step's screenshot and ARIA tree appear inline on the timeline and in
  trace snapshots, on Playwright 1.63 traces and older ones alike, and every evidence screenshot opens in a lightbox.
  See [evidence](https://piwitests.dev/features/evidence).
- **Desktop app: reproduce, bisect, import** — a failure's reproduction recipe and a generated `git bisect` run from
  the app in throwaway worktrees that never touch your checkout, and the first bad commit is recorded on the cluster;
  linking a project folder offers to import the runs already in its `test-results/`; run reports and evidence open in
  their own windows; and the bundled server restarts itself if it crashes. See
  [desktop app](https://piwitests.dev/features/desktop).
- **Local Claude Code as an AI provider** — with the `claude` CLI installed on the machine, diagnosis runs through it
  with no API key to configure, in the desktop app or a self-hosted server alike.
- **`test.fail()` follows Playwright's outcome** — a test declared as expected to fail counts as passing when it fails
  and as failing when it unexpectedly passes, in the reporter and the blob-report importer, so it no longer turns a run
  red, files a cluster or trips the CI gate.
- **Playwright 1.63 captured end to end** — step subtitles and params, test locks, browser dialogs, `.visible()`
  narrowing and contrast, from the reporter through the timeline to the AI context.
- **Branch-aware runs and baselines** — the reporter records the real branch on CI (from the provider's variables,
  or `PIWI_BRANCH`) instead of a detached `HEAD`; runs carry a queryable `branch` column and a per-project default
  branch; runs, flaky tests and MCP tools filter by branch; regression and visual-diff baselines prefer the same
  branch, then the default branch; and PR feedback flags a failure that is already flaky on the default branch.
  Tiers 1–2 of [proposals/first-class-branches.md](proposals/first-class-branches.md); see
  [branches](https://piwitests.dev/features/branches).
- **Auto-heal pull requests** — when a locator breaks on the default branch and healing has high-confidence
  evidence, Piwi opens the fix PR itself: a branch, a deterministic one-line locator edit per broken call site, and
  an evidence-rich body, with the CI gate and fix verification closing the loop. GitHub, GitLab and Bitbucket; off by
  default, per-project allowlist, draft PRs, and a head-content guard so a drifted line is dropped rather than
  mis-patched. See [auto-heal PRs](https://piwitests.dev/features/auto-heal).
- **Public share links (opt-in)** — a read-only URL for one execution or one failure cluster that anyone can open
  without an account: the offline-export report rendered live at view time, bounded by the same size budgets,
  revocable, and off unless `PIWI_SHARE_LINKS_ENABLED` is set. Design record in
  [adr/public-share-links.md](adr/public-share-links.md).
- **First-admin setup from the browser** — with authentication enabled on a fresh instance, the login page walks you
  through creating the administrator account and signs you in; `POST /api/auth/setup` stays for scripted provisioning.
- **Auth rate limiting** — login, initial setup and password-reset endpoints are throttled per client address (failed
  logins also per account), throttled responses carry `Retry-After`, and `PIWI_TRUST_PROXY` keys the limits on the real
  client address behind a reverse proxy.
- **Distinct timed-out and interrupted run statuses** — the reporter keeps Playwright's `timedout` and `interrupted` run outcomes instead of folding them into `failed`, so a run the CI killed and a run that blew its budget read differently in the run list and analytics (all non-`passed` statuses still count as failing where it matters).
- **Fail on flaky** — `failOnFlakyTests` reporter option (forwarded to Playwright 1.52+'s native option, or `PIWI_FAIL_ON_FLAKY_TESTS`) fails the run locally when any test passed only on a retry; `piwi gate --fail-on-flaky` does the same against the dashboard's recorded flaky count.
- **Per-attempt outcomes** — the reporter records every attempt's status, duration and start time; a retried execution shows one chip per attempt on its detail page, an Attempts tab diffs a flaky test's passing and failing attempts and feeds the flaky classifier, and the history views carry the same data.
- **Live step streaming** — while a run executes, the steps each worker is on (Playwright `pw:api`/`expect` and hook/fixture steps) stream to the run page in real time; a "Live activity" strip shows each worker's current step until the run finishes.
- **One-click deploy** — hosting templates for Railway, Render, Fly.io, Koyeb, Coolify and Dokploy, each
  provisioning a single container with a persistent volume, authentication on and its secrets generated by
  the platform. Generated from the same env-var registry as the configuration reference, so a template can
  never drift from what the app reads.
- **Fix verification** — a cluster whose every affected test passes again is recorded as fixed, with the commit and how
  long it was open, and distinguishes "stopped failing" from "the diagnosed change is what fixed it". A fix that does
  not hold is marked regressed. A partial run verifies a fix when it covers the whole cluster, and the fixer is told.
- **Quarantine with an exit ramp** — a quarantined test keeps running and keeps reporting; it is only excluded from the
  CI gate's verdict. Passing streaks accumulate, a release is proposed once earned, and the debt is reported.
- **Ownership from CODEOWNERS** — who answers for a failing test, derived from the repository with no test edits, used
  in pull-request comments, the flaky leaderboard and notification routing.
- **Fix plans for agents** — one call returning the diagnosis, validated patch, locator replacement, failing tests and
  the command that verifies the work.
- **Pull-request feedback** — when a run finishes on a branch with an open pull request, Piwi posts a summary comment
  (new failures separated from pre-existing ones, each with its owner and the suggested replacement locator) and a
  commit status. GitHub and GitLab; off by default.
- **CI gate** — `npx @piwitests/reporter gate` fails a build on the dashboard's analysis rather than on the raw exit code: required
  tags, new regressions, newly flaky tests, or a failure cluster never seen before.
- **Test tags & ownership** — Playwright's own test tags plus `piwi:owner` / `priority` / `feature` / `link`
  annotations, filterable across the test-case catalog and the flaky leaderboard.
- **Import of existing history** — backfill runs recorded before Piwi from Playwright's own blob reports or bare trace
  files, with traces and screenshots, from a page in the dashboard. Imports are idempotent and deliberately silent (no
  notifications, AI diagnosis or regression signals).
- **Offline export** — a failing execution or a whole failure cluster taken out of the dashboard as a self-contained
  HTML file, a ZIP with the raw evidence, a PDF generated server-side with highlighted source and frame screenshots, or
  plain Markdown/JSON — readable with no network and no Piwi server, and bounded so one download cannot exhaust the
  instance.
- **Automatic data retention & storage efficiency** — opt-in nightly pruning of old runs (`PIWI_RETENTION_DAYS`), notification-outbox and diagnosis-history housekeeping, ingest size caps, and content-addressed dedup of per-failure evidence payloads.
- **Runs kept forever** — keep a run from the dashboard, from the reporter (`keep: true` / `PIWI_KEEP`) or with a linked `release` marker, and retention never deletes it; `PIWI_RETENTION_MIN_RUNS` also keeps each project's newest runs whatever their age.
- **AI diagnosis, grounded** — failure-cluster analysis fed by your actual SCM diff, with suggested patches validated server-side against your source; optional two-stage (research → final) pipeline; works with Anthropic, OpenAI, or any OpenAI-compatible endpoint including local models.
- **Locator healing** — element attributes captured on passing runs power ranked replacement locators when a selector breaks.
- **MCP server** — tools so AI agents can query runs, flaky tests, clusters, diagnoses, traces, and test selections, and read Piwi's own docs and release notes.
- **Notifications** — email, Slack, webhook (HMAC-signed), and browser channels with per-project subscriptions and digests.
- **Sharding & live streaming** — shards merge automatically via CI run detection; runs stream into the dashboard while CI executes.
- **Ops hardening** — `/api/health` endpoint, Docker `HEALTHCHECK`, committed `docker-compose.yml`, backup & reverse-proxy guides; bounded memory on large runs (trace ingestion and the reporter's stream buffer are capped, case-file uploads stream to disk); `PIWI_OAUTH_*` honored by the published image and `npx @piwitests/server`.

## Next

- **1.0 stabilization** — settle the wire format and API surface, then commit to semver stability. The outstanding
  decisions are catalogued in [proposals/1.0-stabilization.md](proposals/1.0-stabilization.md).

## Exploring

- **Demo examples in the docs** — every feature page links to a concrete example in the live demo (a verified flake
  fix, a stored AI diagnosis, a broken locator with its replacements), from one registry of examples the seed is
  checked against, so a link never opens the wrong test when the demo data changes. The screenshot scenes and the
  demo runtime check read the same registry. Design record in [proposals/demo-examples.md](proposals/demo-examples.md).

- **The Test Map, measured** — page reach along each test's journey, control reach from the locator index and
  click-to-request edges, so the detectors stop flagging what the suite does exercise; features that group the
  surface their tests miss; exposure for every gap; indicators of how well the suite covers the application and of
  how far the map itself can be trusted, with a labeled benchmark; and the extension's Tested elements overlay
  showing the map's gaps on the live page, recording the missing test, and, with consent, adding the surface a
  person sees. Design record in [proposals/test-map-accuracy.md](proposals/test-map-accuracy.md).
- **Issue trackers, the rest** — tickets for flaky tests and whole runs, investigation and run reports published to
  Confluence with in-place page updates, and the next trackers on the same provider layer: GitHub Issues and GitLab
  Issues on the SCM token, Jira Data Center, Linear. The rest of step 4 and steps 5–6 of
  [proposals/issue-tracker-integrations.md](proposals/issue-tracker-integrations.md).
- **Branches as entities** — on top of the shipped branch column: a merge-readiness verdict per branch,
  branch-class gate policies, cross-branch fix verification and retention by branch class, plus flakiness and trends
  scoped to the default branch by default. Tier 3 of
  [proposals/first-class-branches.md](proposals/first-class-branches.md).
- **Exporting whole runs** — [offline export](https://piwitests.dev/features/offline-export) covers one execution and one failure cluster today; a whole run, and a
  test's history across runs, would follow the same shape.
- **Self-sufficient trace archives** — an export can carry the trace files, but reading them still needs a Playwright
  trace viewer. Bundling the viewer's assets would close that gap, at roughly 10 MB per export.
- More backend-log instrumentation packages beyond ASP.NET Core and Nitro.
- Merging imported shards of one CI run into a single run (today each shard imports separately).
- A dual ESM/CJS reporter build (the package is CommonJS-only today; named imports work everywhere, but a native ESM default import needs an interop shim).

## Non-goals

- **Other test frameworks** (Cypress, Jest, JUnit…) — Piwi stays Playwright-only; depth over breadth is the point. See [Why Piwi?](https://piwitests.dev/guide/comparison) for alternatives that aggregate many frameworks.
- **A hosted SaaS** — Piwi is built to be self-hosted; your data stays yours.
