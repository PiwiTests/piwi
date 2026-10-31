# Piwi docs review: missing illustrations and gaps

A review of every page of the documentation site (`apps/docs/`), focused on the illustrations that users and newcomers miss: screenshots, diagrams, annotations, loop videos, command output. It also records the gaps and content errors found along the way, and ranks the fixes in batches that can ship separately.

**Status.** Proposed 2026-10-27, against `main` at commit `7fc8c44e`; partly built since. Each batch of §3 can ship alone, in any order; a pull request that builds part of it updates this paragraph.

- **Built.** Batch 1 whole: click-to-zoom (`theme/image-zoom.ts`, no dependency), image markup out of the word budget, one `<figure>` markup, dark themes and larger text on every diagram, and drift checks for an unused screenshot and a missing `## Related`. Batch 2: the images with no page placed or deleted with their scene, 25 existing scenes published, the broken test case and dark evidence captures replaced, and *Try it in the demo* on seven more pages. Batch 3: `init`, the reporter's *Not enabled* line, the gate, a metrics scrape and a coverage upload quoted from their code (`docs-checkpoints.test.ts`), the pull-request comment and the heal pull request rendered by their builders. Batch 4: the moving parts, the data model grid, the baseline ladder, the worked flakiness score and the production topology. All of §5 that held up against the code, and the `diff-rename` label of §6. The demo seed's failed flaky attempts wait out the timeout their error names, and the flaky lists show a cost under a minute in seconds rather than *0 min*. The issue tracking and integrations screenshots show a connected Jira and a bound project. `vscode-hover.png` shows the failure screenshot under the error, the hover dragged taller as a reader can. Batch 5: loop videos of picking an element, recording actions and reporting a bug, written by the extension's docs spec.
- **Remaining.** The JetBrains screenshots keep the trial badge. The `probe` and `run impact` outputs, the fix plan, Jira and email renderings, the annotated screenshots, Batch 4 from the editors on, and the replay and editor-recording loops of Batch 5 are not built.

**Scope**: the 115 hand-written pages of `apps/docs/`, plus the 7 generated pages (regenerated locally for the review), 80 screenshots and 12 diagrams.
**Method**: 7 parallel reviews (one per group of pages), then a check of the most important points: the real rendering of the built site, measurements of each image's display scale, and reading the code.

Terms used in this review:

- **scene**: an entry of the screenshot script `apps/application/scripts/take-feature-screenshots.mjs`, which produces one or more images reproducibly.
- **publish a scene**: switch an existing scene to `tags: ['docs'], out: 'docs'`, so its image lands in `apps/docs/public/screenshots/`.
- **word budget**: the per-page word limit checked by `apps/application/tests/unit/docs-drift.test.ts` (1,500 words for a guide, feature or self-hosting page, 1,000 for a recipe).
- **checkpoint**: what the reader should see after a step (command output, a screen, a status line), so they know it worked.
- **loop video**: a short, muted MP4 played in a loop, like `demo-live-run.mp4` on the home page.

---

## 1. Summary

- **48 of the 102 pages with a word budget have no visual at all.** They include 12 of the 15 self-hosting pages, every reference page, and 9 of the 12 setup pages of the guide, among them **Getting started**, **Capture fixtures** and **CI**.
- **29 of the 72 image placements display at less than 55% of their native size, and none enlarges on click.** UI text drops to 5 to 7 px. This hits every editor screenshot and the key images of flaky tests and failure evidence. At phone width, the scale drops to 24%.
- **40 of the 102 pages are within 25 words of their budget, and the count includes image markup.** A figure costs 25 to 45 words (tags, alt text, caption), and images cost 2,839 words across the site. In practice, the rule blocks adding illustrations.
- **The tooling exists but goes unused:**
  - the screenshot script has **329 scenes, 269 of which write only to `.screens/`**;
  - a **numbered annotations** option (`annotate`) exists and **no docs image uses it**;
  - the renderers of the artifacts Piwi hands back are pure functions that already exist, and the docs show none of their output: PR comment, heal pull request, fix plan, Jira issue.
- **The flaky tests page and its recipe show "0 min" wasted on every row** of the flaky tests image, and a test's history chart is broken. Several captions promise what the image does not show.
- **The setup pages lack checkpoints.** There is no output of `init`, of the reporter, of `gate`, `probe`, `coverage upload` or `/api/metrics`.
- **Only 12 feature pages link to the live demo**, although the demo data covers the screens of clusters, flaky tests, failure evidence, run changes and dashboards.

---

## 2. Cross-cutting problems

Each one is fixed once and improves many pages.

### 2.1 Screenshots unreadable at the docs width

The content column is 688 px wide. Docs scenes are captured at scale 1, except `home` and the README tour images, which are at scale 2.

| Display scale | Images (placements) |
|---|---|
| 0.44 to 0.49 | `gather-evidence.png` (2 pages), `flaky-detection.png` (2 pages), the 7 VS Code and JetBrains screenshots, `tested-elements-overlay.png` |
| 0.53 to 0.54 | `run-timeline.png` (a 688×126 strip), the 7 `picker-*.png` (store format, 1280×800), `notifications.png`, `bug-report.png`, `flake-lab.png`, `test-functions.png`, `test-selections.png`, `failure-clusters-tab.png`, `saved-dashboard.png`, `dashboard-editor.png`, `assistant-docked.png`, `report-schedules.png` |

Proposals:

1. **Add click-to-zoom** to content images, for example with `medium-zoom` mounted in `theme/index.ts`. Effort S. This is the fix that covers the most placements.
2. **Crop scenes to the useful area** with `of:`, at `deviceScaleFactor: 2` and with a fitting `outputWidth`, instead of capturing the whole screen with the sidebar. The sidebar takes 19 to 55% of several screenshots.
3. **For the editors**, crop with `page.screenshot({ clip })`, or capture at 1100×700 with `window.zoomLevel: 1`.
4. **Hide the version** in the sidebar of full-page screenshots. They show v0.56.0 or v0.59.0, while the current version is 0.61.0.

### 2.2 The word budget penalizes images

The drift test splits the raw page on whitespace (`docs-drift.test.ts:533`). A `<figure>` with its alt text and caption therefore counts 25 to 45 words. 40 pages have less than 25 words of margin, among them `evidence`, `flaky-tests`, `locator-healing`, `issue-tracking`, `storage`, `ci`, `reporter`, `capture-fixtures`, `extension` and `desktop`.

**Decision to make (recommended)**: exclude image markup from the count (`<figure>`, `<img>`, `![…](…)`, attributes and alt text), and optionally keep the `<figcaption>`. Otherwise every illustration in this review first needs a cut. The reviews named a candidate cut for each affected page (appendix).

### 2.3 Tooling already in place but unused

- **269 unpublished scenes.** Many cover exactly the screens the docs only describe. Examples, all checked:

  | Page | Scenes to publish |
  |---|---|
  | `guide/getting-started` | `setup-connect`, `home-empty-connect` |
  | `features/quality-reports` | `report-snapshot`, `report-schedule-preview` |
  | `features/timeline-markers` | `run-trend-marker-tooltip`, `markers-panel` |
  | `features/mcp` | `mcp-oauth-consent`, `mcp-tool-details` |
  | `features/agent-skills` | `mcp-agent-skills` |
  | `features/desktop` | `setup-connect-desktop`, `desktop-repro-request` |
  | `features/bug-reports` | `bug-report-spec`, `bug-report-step-shots` |
  | `features/notifications` | `channel-form` |
  | `features/analytics` | `analytics-scope-bar`, `chart-export-menu` |
  | `features/extension-connection` | `project-url-patterns` |
  | `features/replay-a-bug-report`, `features/offline-export` | `execution-replay-export` |
  | `features/failure-clusters` | `cluster-activity` |

  The reviews also name others, not rechecked one by one:
  - on the admin side: `storage-analysis`, `localization-settings`, `setup-ladder-declined`, `user-api-keys`, `settings-user-project-roles`;
  - on the feature side: `flakiness-tab`, `flake-lab-tab`, `quarantine-dismiss`, `run-resources`, `run-timeline-resources`, `page-diff`, `attempt-diff`, `assistant-proposal`, `guides`, `locator-usage-drawer`, `project-locators`, `test-search`, `failure-headline`, `evidence-fixtures-footer`, `open-in-ide-settings`, `extension-connect`.

  Publishing a scene only takes a tags change, plus a crop where needed.
- **Numbered annotations.** `scripts/screenshot-annotations.mjs` draws numbered steps, boxes and arrows, and writes an `-annotated.png` variant. No scene uses it. It is the right tool for dense screens: a failure's situation block, a cluster page, the locator fix panel, the AI diagnosis, a run's timeline.
- **Pure renderers of the artifacts Piwi hands back**, never shown in the docs:

  | Artifact | Renderer |
  |---|---|
  | Pull request comment | `buildPrComment` |
  | Heal pull request | `buildHealPrBody` |
  | Fix plan as Markdown | `fixPlanToMarkdown` |
  | Test skeleton for a scenario gap | `renderScenarioDraft` |
  | Automatic Jira comments | `policy-comments.ts` |
  | Emails | `renderRunNotificationEmail`, `renderNewClusterEmail`, `renderDigestEmail` |
  | Teams card | `teamsEventMessage` |

  The screenshot script's `prCommentPage()` template serves only one scene. As code blocks, these renderings also reach agents, through the MCP `describe_piwi` tool.
- **Video.** `scripts/record-demo-video.mjs` already converts WebM to MP4. Turned into a shared helper, it can produce loop videos of the interactions a still image cannot show: picking an element, replaying a bug report, recording, stepping in the editor.

### 2.4 No "what you should see" checkpoints

No setup page shows the expected output of a step. The costliest case is the reporter's `Not enabled … set PIWI_DASHBOARD_URL or serverUrl to enable.` line: it is what a stuck newcomer searches for, and no page quotes it. Proposals:

- **Real text blocks**, generated from the real formatters and checked by a unit test, on the model of `tests/unit/setup-snippets.test.ts`:

  | Output | Formatter |
  |---|---|
  | `init` (marks `+ ~ = ! - x`) | `formatStep` |
  | Reporter during a run | |
  | `piwi gate` | `formatGateResult` |
  | `coverage upload` | `formatSummary` |
  | `piwi run impact`, `piwi probe` | |
  | `/api/metrics` | fixtures of `open-metrics.test.ts` |

  These blocks are indexed by search, readable by agents, and need no image.
- **Use the Setup page as the check.** `shared/capabilities.ts` detects the capture fixtures, backend logs, SCM, AI and coverage there, but no setup page says so.

### 2.5 Inconsistent presentation

- **Three image markups coexist.**
  - `<figure>`: 44 pages, with a frame and a caption.
  - `<div class="doc-screenshot">`: 4 pages (`issue-tracking`, `issue-automation`, `operate/integrations`, `operate/project-access`). **This class has no style**: no frame, no caption. In the dark theme, the "Create issue" dialog shows as a white block 964 px tall.
  - `![…](…)`: 5 pages (`analytics`, `assistant`, `dashboards`, `environment-incidents`, `quality-reports`), with no frame or caption.

  Proposal: one format, either `<figure>` everywhere or a `<Screenshot>` component that adds zoom, `loading="lazy"`, width and height. A new component also needs a text rendering in `docs-corpus.ts`.
- **7 of the 12 diagrams have no dark variant** and show as light boxes in the dark theme: `piwi-ecosystem`, `failure-loop`, `failure-clustering-fingerprint`, `failure-clustering-semantic-merge`, `locator-healing-capture`, `locator-healing-resolution`, `demo-in-browser`. This goes against the "theme-aware" rule of the docs guide. Also, all of them have a 920 px `viewBox` with 10.5 to 11 px text, about 8 px on screen.
- **Mixed themes.**
  - Dashboard screenshots are mostly light; three are dark for no visible reason: `ai-diagnosis`, `gather-evidence`, `run-timeline`.
  - Editor screenshots are all dark.
- **PNG only**: 11 MB in total, with no `width` or `height`, so the layout shifts as images load. Switching to WebP would cut the weight by about 3 (a secondary gain).

### 2.6 Demo data that contradicts the captions

- **`flaky-tests.png` and `flaky-detection.png`.** Every row shows "0 min" with a green dot, and the first test shows "0% fail". The captions promise a ranking by wasted CI minutes, and the recipe says "a few red rows usually account for most of the total". The demo data needs wasted minutes.
- **`failure-clusters-tab.png`** shows 2 clusters of 1 and 2 tests, under the caption "forty red tests become the three causes".
- **Edge cases in canonical images**:
  - the "backend restarted" banner on `coverage-file.png` and `combined-coverage-file.png`;
  - the `PIWI_SITE_URL` warning and an empty Jira binding on the `issue-tracking` screenshots;
  - the empty state on `integrations-settings.png`, whose alt text describes a verified connection;
  - the "**Trial**" badge of the JetBrains trial license in the status bar of both JetBrains screenshots (checked).

### 2.7 Links to the live demo

The `## Try it in the demo` section exists on only 12 pages: `ai-diagnosis`, `flake-lab`, `coverage-insights`, `combined-coverage`, `code-reach`, `server-coverage`, `scenario-gaps`, `resource-leaks`, `probes`, `issue-tracking`, `environment-incidents` and `cpu-memory-disk`.

It is missing from pages whose screen is in the demo data:
- history and failures: `evidence` (execution 37), `failure-clusters` (cluster 10), `flaky-tests` (test case 9), `run-changes` (run 2), `slow-tests`;
- other features: `locator-healing`, `analytics`, `dashboards`, `guides`, `assistant`;
- guide: `first-failure`, `backend-logs`.

It is the cheapest illustration there is: one entry in `shared/demo/demo-examples.mjs`. The `expect` vocabulary of that registry is closed, so some pages first need a new key (dashboard, bug report, marker).

### 2.8 Images with no page

| Image | Where to place it |
|---|---|
| `project-detail.png` | `features/timeline-markers` (the run trend with its markers), with no other work |
| `ai-usage.png` | `guide/ai-provider`, "Usage and quality" section |
| `vscode-run-control-hover.png` | replaces `vscode-run-control.png` on `editor-run-control`: same stop, controls readable at 14 px (checked) |
| `vscode-run-control-paused-page.png` | `editor-run-control`, "A headless run" section |
| `performance.png` | `timeline-markers` or `slow-tests` |
| `projects.png` | used nowhere, neither in the docs nor in the README |
| `jetbrains-heal.png`, `vscode-hover.png` | used only in each extension's README; place them on `jetbrains` and `editor-failures` |

`vscode-hover.png` must be recaptured first: it lacks the promised failure screenshot.

`npm run app:screens:check` does not catch an image no page uses: it only checks that scenes and images match.

---

## 3. Recommended plan

The batches are ranked by gain over effort. Each batch can be its own pull request.

### Batch 1: foundations (effort S to M, site-wide effect)

1. Add click-to-zoom to content images.
2. Settle the word budget rule for image markup (§2.2), then update `docs-drift.test.ts`.
3. Use one image format: remove `doc-screenshot` and the remaining `![]()`.
4. Add a dark variant to the 7 light diagrams and enlarge their text.
5. Check in the drift test that every image of `public/screenshots/` is used, and that every page has its `## Related` (7 pages lack one, §5).

### Batch 2: quick wins (effort S, no new scene)

1. Place the images with no page (§2.8).
2. Replace wrong or broken images:
   - `test-case-detail.png`: only the failed bars render and there is no status strip. Recapture it, or use `tour-test-history.png`.
   - `flaky-detection.png` and `flaky-tests.png`: data and crop.
   - `gather-evidence.png` on `evidence`: use the evidence card alone.
   - `integrations-settings.png`: capture the connected state.
   - `vscode-hover.png`: recapture with the failure screenshot.
3. Publish the existing scenes listed in §2.3, page by page.
4. Add the missing `## Try it in the demo` sections (§2.7).

### Batch 3: checkpoints and artifacts as text (effort S to M)

1. **Command output** generated and tested: `init`, the reporter (with `Not enabled`), `gate`, `coverage upload`, `run impact`, `probe`, `/api/metrics`.
2. **Handed-back artifacts**, as an image through `prCommentPage()` or as a code block:
   - the complete pull request comment;
   - the heal pull request;
   - the fix plan as Markdown;
   - the Jira issue body;
   - the test skeleton of a scenario gap;
   - an AI step's file;
   - the before and after code on `recorded-code` and `test-functions`.
3. **Previews of received notifications**: email (existing renderer, S), then Teams and Slack (M).

### Batch 4: new diagrams (effort M each, SVG with light and dark themes)

In priority order:

1. **"The moving parts"** on `getting-started`: reporter → upload → server (database, artifacts in `.data` or S3) → browser, with a CI lane.
2. **Production topology** on `operate/deployment`, reused with step numbers on `production-checklist`.
3. **Data model as a grid** on `concepts`: runs as columns, test cases as rows, executions in the cells, a cluster spanning both. It replaces the ASCII tree, which misleads: it puts the cluster under the test case.
4. **Baseline choice ladder** on `run-changes`, reused on `branches` and `concepts`. The rule is restated in prose on more than 5 pages.
5. **Flakiness score, worked example** on `flaky-tests` (10 runs → a score of 30, the impact formula).
6. **Editor extensions architecture and an entry page** "which page to read" on `editors`. Add the instance selection ladder on `editor-connection`.
7. **MCP flow** on `mcp`: OAuth or a `pd_` key, modules, roles, the write log. Add a real transcript of an agent ↔ tools exchange.
8. **Upgrade and rollback** on `operate/upgrading`, reused on `backup-restore`.
9. Then:
   - a bug report's states (`bug-reports`);
   - the extension's connection handshake (`extension-connection`);
   - how shards merge (`ci`);
   - the data flow out of your network (`privacy`);
   - the SQLite or PostgreSQL × local disk or S3 matrix (`database`);
   - the "which coverage needs what" table on `reference/coverage-cost` (which has no budget), linked from each coverage page.

### Batch 5: loop videos (M once for the shared helper, then S to M per loop)

In priority order:

1. `pick-an-element`: hover, snap, tree walk, click.
2. `replay-a-bug-report`: the cursor replaying, then the verdict.
3. `record-actions` and `report-a-bug`.
4. `editor-recording`: needs an Xvfb capture of two windows, so a new pipeline (effort L). In the meantime, a still of the editor while recording (M).

---

## 4. The most cost-effective P1 proposals

P1 means: a newcomer is likely to be stuck or misled without this illustration, or a key page has no visual at all.

| # | Page | Proposal | How | Effort |
|---|---|---|---|---|
| 1 | whole site | Click-to-zoom | `medium-zoom` in the theme | S |
| 2 | whole site | Exclude image markup from the word budget | `docs-drift.test.ts` | S |
| 3 | `guide/getting-started` | Connect wizard, "Waiting / A run is reporting now" status line, output of `init` and the reporter (including `Not enabled`) | scenes `setup-connect`, `home-empty-connect`, and text blocks | S |
| 4 | `guide/getting-started` | "The moving parts" diagram | new SVG | M |
| 5 | `guide/first-failure` | Situation block, cropped and annotated 1 to 5 to match the page's sections, instead of the dark full-page capture (scale 0.44); align the quoted text with the image | scene `failure-headline` and `annotate` | S |
| 6 | `guide/capture-fixtures` | Diff of the import (`@playwright/test` → `./fixtures`), then the evidence card before and after | `diff` block, scene `evidence-fixtures-footer` | S to M |
| 7 | `guide/concepts` | Data model as a grid | new SVG | M |
| 8 | `features/flaky-tests` | Worked flakiness score, Flakiness tab, corrected image | SVG and scene `flakiness-tab` | S to M |
| 9 | `features/evidence` | Screen tab in Page diff view, and the evidence card alone at scale 2 | scenes `page-diff` and `of:` | S |
| 10 | `features/failure-clusters` | Home failure inbox and an annotated cluster page | new scene, and `cluster-clarity` with `annotate` | M |
| 11 | `features/slow-tests` | Become the page of a run's timeline: annotated image, then take over the 277 words from `ui-overview` and the recipe's definition of wasted time | `annotate` on `run-timeline` | M |
| 12 | `features/pr-feedback` | The complete pull request comment | `buildPrComment` and `prCommentPage()` | S |
| 13 | `features/auto-heal` | The rendered heal pull request and the settings screen | `buildHealPrBody` and a new scene | S |
| 14 | `features/locator-healing` | Fix `locator-healing-resolution.svg`: the "Diff rename" rung is missing in first place, and the panel is named "Locator fix" | edit the SVG | S |
| 15 | `features/code-reach` | Show **browser** coverage: both current images show C# server files | new scene | M |
| 16 | `features/quality-reports` | The produced report and the email sent | scenes `report-snapshot` and `report-schedule-preview` | S |
| 17 | `features/notifications` | "What you receive": email, Teams, Slack | existing renderers, new script | M |
| 18 | `features/timeline-markers` | Markers on the run trend | `project-detail.png`, with no other work | 0 |
| 19 | `features/editor-run-control` | Readable image and the "headless" case | the two unused `vscode-run-control-*` images | S |
| 20 | `features/editors`, `features/editor-connection` | Architecture, entry page, connection states, and a table of the real error messages from `packages/editor/src/context.ts` | SVG, VS Code scenes | M |
| 21 | `features/mcp`, `features/agent-skills` | Flow diagram, real transcript, the agents' report-back loop | SVG and code block | M |
| 22 | `features/desktop` | First launch (the wizard with no URL), "Run locally" and the local runs area | `setup-connect-desktop`, new scene | S to M |
| 23 | `features/recorded-code`, `features/test-functions` | Before and after code, produced by `piwi codegen` | code block | S |
| 24 | `operate/deployment` | Production topology and a `/api/health` check | SVG and text block | M |
| 25 | `operate/authentication` | First administrator screen (setup token) and sign-in screen | new scene with `page.route` | M |
| 26 | `operate/capabilities`, `operate/api-keys`, `operate/metrics` | Setup page, key management, sample OpenMetrics output | `setup-ladder-declined`, `user-api-keys`, text block | S |
| 27 | `operate/upgrading` | Upgrade and rollback | SVG | M |
| 28 | `features/pick-an-element`, `features/replay-a-bug-report` | Loop videos | shared video helper | M |

---

## 5. Errors and contradictions to fix, regardless of visuals

### Checked

- **Playwright version.**
  - The reporter requires `@playwright/test ^1.64.1` (`packages/reporter/package.json`), and no page gives the supported version.
  - `guide/ci.md:50` pins the image `v1.61.1-noble` "at or above the reporter's peer range", which is wrong.
  - `guide/reporter.md` (lines 21, 35, 59) still describes conditions "before 1.63".
- **`guide/importing-runs.md`**: the description (the search snippet) announces importing "Playwright JSON and blob reports". At line 37, the page says JSON output is not importable.
- **`operate/backup-restore.md` never mentions `PIWI_SECRET_KEY`.** Stored AI keys, SCM and Jira tokens and webhook secrets are encrypted with it, so a restore on a new host loses them.
- **`operate/production-checklist.md`** mentions neither `PIWI_SETUP_TOKEN` nor `PIWI_SITE_URL`. Without a setup token, anyone who reaches the URL between turning authentication on and creating the administrator can become administrator.
- **`reference/cli.md`.**
  - `coverage` is missing from the command table, although its section exists.
  - At line 56, `--skills` says "the four workflow skills", while `WORKFLOW_SKILLS` holds 6.
- **`reference/notification-events.md`** does not give the signature format (`X-Piwi-Signature: sha256=<hex>`; "sha256" appears nowhere on the page). Nor does it say how to verify it.
- **`features/auto-heal.md`**: the description says "locator replacement or patch", while the page says no generated code is written.
- **`guide/ci.md:43`**: "The shallow clone `actions/checkout` makes is fine". But `piwi run impact` and `preflight --base` run a local `git diff`; on a shallow clone, they silently fall back to the full suite.
- **`apps/application/shared/piwi-features.ts:221`**: the assistant has `where: 'API reference → Assistant'`. The panel actually opens from "Ask Piwi", `Ctrl+I` or the command palette.
- **7 pages lack `## Related`**, which is required: `features/quality-reports`, `features/editor-connection`, `features/locator-usage`, `features/auto-heal`, `operate/tracing`, `reference/steps-format`, `reference/coverage-cost`.
- **Banned planned-work wording**:
  - `features/ai-steps.md:62` and `:132` ("not available yet");
  - `features/server-coverage.md:106`;
  - `features/branches.md:56`;
  - `features/extension.md:138` ("No aria-snapshot copier yet");
  - `operate/one-click-deploy.md:41` ("No button yet").
- **Wrong counts.**
  - `features/quality-reports.md:20` says "two built-in dashboards", then lists four.
  - `features/replay-a-bug-report.md:37` says "one of three answers", then lists four.
- **Images that contradict their page.**
  - `test-case-detail.png` (2 pages): only the failed bars render; the passing executions, around 4.5 s, fall below the bottom of the axis. There is no status strip, and the bottom cards are empty.
  - `flaky-detection.png`: "0 min" everywhere.
  - `vscode-hover.png`: no failure screenshot.
  - The JetBrains screenshots carry the "Trial" badge.

### Reported by the reviews, not rechecked

- **`operate/deployment`, Kubernetes manifest.**
  - There is no `fsGroup: 1001`: the volume may not be writable.
  - A `LoadBalancer` `Service` over HTTP, which exposes an instance with no authentication.
  - There is no `envFrom` for the ConfigMap and Secret the generator emits.
  - `:latest` everywhere, while the page says to pin a version.
- **`operate/deployment`, other points.**
  - The page claims the reference says, for each variable, whether the Settings UI can override it. There is no such column.
  - With `npx` on a local network, sign-in fails over HTTP (the `Secure` cookie), which the page does not say.
- **`operate/one-click-deploy`**: Railway is "Button" in the table and "No button yet" in its section.
- **`operate/authentication`.**
  - Forgot password, invitations and email verification need SMTP: without SMTP, password reset answers 200 and sends nothing.
  - There is no reset by an administrator, so no procedure when the last administrator loses their password.
  - The invitation flow is not documented.
  - Only Google and GitHub are supported, with no generic OIDC; the page does not say so.
- **`operate/capabilities`** says declining a capability is administrator-only, but the per-project `PATCH` requires `project:manage`.
- **`operate/api-keys`.**
  - It shows a bare `reporter` entry with `apiKey`, while the reporter reads `PIWI_API_KEY` from the environment and the rule is to lead with `wrapConfig`.
  - It uses a `curl` with `\`.
- **`operate/metrics`**: the Prometheus configuration lacks `scheme: https`.
- **`operate/integrations`**: "Jira Cloud is the supported tracker" against "including a self-hosted host".
- **`reference/configuration`, page generator.**
  - It drops the `secret`, `requiredWhen`, `relevantWhen`, `enum` and `min`/`max` metadata.
  - The `OTEL_*` variables are missing from the registry.
  - `PIWI_SMTP_SECURE` contradicts itself ("default false" against "on when port 465").
  - The configuration generator emits `:latest` whatever version is chosen.
- **`features/dashboards`** leaves out the built-in "Team" dashboard.
- **`features/editor-coverage`** limits server line marks to ASP.NET Core, while Nitro provides them too.
- **`features/editor-failures`**: the editor's "Baseline" label, which means the latest complete run, contradicts `concepts` (the last passing run).
- **`features/devtools`**: the text example and the screenshot show two different elements.
- **`features/test-functions`**: the screenshot shows the `scanned` badge, which only the demo data produces.
- **`features/report-a-bug` and `features/bug-reports`**: the example amounts differ between the pages and from the screenshot.
- **`guide/first-failure`**: the quoted headline, identity line and run numbers differ from the screenshot. The **Locators** tab is not listed, and the tab opening order contradicts `evidence`.
- **`guide/getting-started`.**
  - `init` always writes `tests/fixtures.ts`, whatever `testDir` is, which may be an `init` bug.
  - Partial runs and feature-branch runs are hidden by default, which no page says.
- **`reference/gap-detectors`.** The detector ids (`success-only`, …), shown in the Gaps tab, are missing. Each detector's confidence is not given, so the scores in the UI (0.178, 0.070) cannot be recomputed.
- **`reference/mcp-tools`**: tool parameters are not listed, although `toolParameters()` already returns them.
- **Capability link**: in `shared/capabilities.ts`, `flake-lab` points to `features/flaky-tests`.
- **Instance tags** (Settings → Tags): no page.

---

## 6. Bugs and technical debt found along the way

- **Checked**: `apps/application/shared/heal-pr.ts:15`. `sourceLabel()` has no `diff-rename` case, so the "From" column of a heal pull request shows the raw value `diff-rename`.
- **Checked**: some scenario gap detectors are exported and tested but never called in production, for example `detectMatrix`, `detectPhantomCoverage` and `detectIncidentalCatch` in `shared/handlers/scenario-gaps.ts`. The review counts 7, plus `detectEscapedDefect`, which `detectReportedBugEscapes` replaces.
- **Checked**: the JetBrains screenshot pipeline runs on a trial license, hence the "Trial" badge, also visible on the Marketplace listing.
- **To check**: JetBrains Code Vision shows only "Trace" above the failing line. `PiwiCodeVisionProvider.kt` emits several entries under one provider id; the IDE may keep only the last.
- **To check**: the `vscode-hover` scene ignores the timeout of its image wait (`.catch(() => {})`). That is how the screenshot came out without its image.
- **To check**: the "Duration trend" chart of `test-case-detail.png` does not draw bars below the axis minimum. `tour-test-history.png`, captured later, is correct, so it may be a capture artifact.

---

## 7. Appendix: page by page

Proposed visuals are rated P1, P2 or P3, with effort S, M or L. The number in parentheses is the remaining margin under the word budget, when it is small.

### Guide

**index.md**
- Visuals: P3, crop the "Failure clusters" and "Flaky" images to their list. Both show the same project header over 55% of the image (S, and M with richer data).
- Gaps:
  - Step 2 does not say to import `test` from the fixtures file.
  - Step 3 assumes a red test, with no route for a green suite (the demo or the sample app).

**guide/getting-started.md** (0 visuals, about 650 words of margin)
- P1:
  - "the moving parts" diagram (M);
  - connect wizard and status line as the checkpoint (S);
  - `init` output (S);
  - reporter output, with the `Not enabled` line (S).
- P2: the `demo-live-run.mp4` video after "Open it".
- Gaps:
  - the supported Playwright version;
  - where the fixtures file goes, and the relative path from a sub-folder;
  - no help when nothing shows up: `Not enabled`, a container bound to `127.0.0.1` unreachable from WSL or a dev container, authentication with no key;
  - partial and branch runs are hidden by default;
  - the project is created on the first run.

**guide/what-piwi-does.md**
- Visuals: nothing new.
- Both SVGs have no dark theme and their text renders at about 8 px.
- Gap: "AI brings your own key" ignores the CLI providers (Claude Code, Codex, DeepSeek), which need none.

**guide/first-failure.md** (2)
- P1: annotated situation block, in the light theme and at scale 2 (S).
- P2: a demo link, cutting "You're not reading it alone".
- P3: loop video of clicking a citation.
- The quoted text differs from the screenshot (§5).

**guide/concepts.md** (reference, no budget)
- P1: data model grid.
- P2:
  - baseline ladder;
  - `failure-clustering-fingerprint.svg` under "Error fingerprint";
  - annotated situation block (Situation, Story, Next step, Cluster state).
- Gaps:
  - the difference between a Piwi project and a Playwright project is never explained;
  - entries are missing for run status, full or partial run, Quarantine, editor service, run channel and stop.

**guide/comparison.md**
- Nothing new.
- Gaps: the Playwright version; the desktop app for the "only debug locally" case.

**guide/license.md**: nothing.

**guide/privacy.md** (1)
- P2: diagram of the network boundary and the 8 outbound destinations, moving the Piwi Picker part (210 words) to `bug-reports`.
- Gap: what the reporter sends to the server; link to `reference/test-metadata`.

**guide/reporter.md** (1)
- P2:
  - decision tree "where does this run go" (URL, environment, `.env`, desktop app);
  - sequence of a run's lifecycle;
  - reporter output block.
- Gaps:
  - the "before 1.63" conditions are moot with the `^1.64.1` range;
  - the reporter lines people search for are not quoted: `Not enabled`, `Using the desktop app…`, `Partial run detected`;
  - `video: 'retain-on-failure'` is not explained.

**guide/capture-fixtures.md** (3)
- P1: `diff` block of the import.
- P2: evidence card before and after, moving "Green page sampling" (140 words) to `evidence`.
- Gaps:
  - where the file goes;
  - the checkpoint (the capability detected on the Setup page, the line that disappears from the evidence card's footer).

**guide/ci.md** (0)
- P2:
  - diagram of how shards merge;
  - `piwi gate` output, replacing the rules table with a link to `reference/cli#gate` (150 words).
- Gaps:
  - the `v1.61.1` image;
  - the shallow clone;
  - the `Not enabled` line missing from troubleshooting.

**guide/source-control.md**
- P2: Project → Settings → Source control (scene `project-settings`), then the "What changed" line and card (scene `cluster-suspect-lines`).
- Gaps:
  - links to each host's token creation page;
  - the check through the Setup page.

**guide/ai-provider.md** (3)
- P2:
  - `ai-usage.png`;
  - Settings → AI → Model providers;
  - a table to choose a provider.
- Move the Claude Code CLI paragraph (230 words) to its own page, as for Codex and DeepSeek.
- Gap: no checkpoint for the first diagnosis.

**guide/codex-cli.md, guide/deepseek-cli.md**
- Nothing essential.
- Gaps:
  - use with the Docker image (the binary and its login inside the container);
  - troubleshooting "Recheck".

**guide/backend-logs.md** (0)
- P1/P2: an execution's Network tab with its server logs, with a demo link.
- P2: sequence diagram of the `X-Piwi-Logs` header.
- Gap: no verify step (`X-Piwi-Logs` header, `/__piwi/manifest`, Setup page).

**guide/importing-runs.md** (1)
- P2: the import page with 4 archives in 4 states, replacing the table.
- Gaps:
  - the description contradicts the page;
  - no step for a reader with no project yet.

### Features: keep the history

**features/ui-overview.md** (0)
- P2: SVG navigation map, replacing `home.png`, the only screenshot on a page whose rule bans them.
- Gaps:
  - a run's Resources tab;
  - the sidebar's "Active" list;
  - a test case's tabs.
- Move the 277 words on the timeline to `slow-tests`.

**features/guides.md**
- P1: a guide's stop (scene `guides`, image `guides-stop.png`).
- P2: the palette and a "Show me" suggestion.
- Gaps:
  - how guides differ from the demo's guided tour;
  - `<Needs reporter />` is misleading, since one guide is how you install the reporter.

**features/branches.md**
- P1: baseline ladder.
- P2: the branch filter open (scene `project-header`).
- Gaps:
  - where to see the branch a run recorded;
  - one planned-work phrasing and one history phrasing.

**features/run-changes.md**
- P1: baseline ladder.
- P2:
  - annotated `run-changes.png`;
  - run picker (scene `run-changes-fallback`).
- The image lacks the "Fixed" section that the alt text and caption promise.
- No demo link.

**features/offline-export.md**
- P2:
  - Export menu (scene `execution-replay-export`);
  - an exported HTML report, as the recipient sees it.
- P3: the mapping in Perfetto.
- Gap: the "on the roadmap" phrasing.

**features/share-links.md**
- P2: the share dialog with a newly minted link (scene `report-share-link`).
- Gap: the behavior when `PIWI_SHARE_LINKS_ENABLED` is off.

### Features: explain the failures

**features/evidence.md** (0)
- P1: Screen tab in Page diff view, and the evidence card alone instead of `gather-evidence.png`.
- P2: the list of differences between attempts (scene `attempt-diff`).
- `test-case-detail.png` is broken.
- Gaps:
  - the Locators tab is not mentioned;
  - no `<Needs fixtures />`;
  - no demo link.

**features/failure-clusters.md** (3)
- P1: Home failure inbox, and an annotated cluster page.
- P3: loop video of keyboard triage.
- Gaps:
  - no link to environment incidents;
  - no demo link (cluster 10).

**features/environment-incidents.md**
- Nothing essential.
- Switch `![]()` to `<figure>`.
- The link from `mass-failure` is missing.

**features/flaky-tests.md** (1)
- P1: worked score, Flakiness tab, corrected image.
- P2: Quarantine view.
- Gaps:
  - the thresholds and the impact formula;
  - "pipeline-block effect" is undefined.

**features/flake-lab.md** (3)
- P2: the loop "suspects → piwi flake → verdict → verify", and the scene `flake-lab-tab` instead of the full-page capture.

**features/slow-tests.md**
- P1: an annotated "The run timeline" section, and the Timeout opportunities table.
- P2: slow endpoints, Web Vitals.
- Gap: "Wasted time", in the title, is never defined on the page.
- Flaw of `performance-trends.png`: the total series flattens the average and P90.

**features/resource-leaks.md** (2)
- P1: Resources tab (scene `run-resources`).
- P2: diagram of scopes on a worker.

**features/cpu-memory-disk.md** (1)
- P1: the CPU, memory and pages tracks of the timeline (scene `run-timeline-resources`).

**features/ai-diagnosis.md** (2)
- P1: annotated `ai-diagnosis.png`, with a numbered list of its contents.
- No `<Needs llm />`.
- The page opens with semantic merging before saying how to start a diagnosis.
- The semantic merging SVG has neither a dark theme nor the "kept apart" outcome.

**features/assistant.md** (6)
- P1: a proposal card before and after Apply (scene `assistant-proposal`).
- P2: an answer with every block kind.
- Switch `![]()` to `<figure>`.

### Recipes

**recipes/regression-or-flaky.md**
- P1: replace `test-case-detail.png` with `tour-test-history.png`.
- P2: four status strips, one per row of the table.
- Gap: the baseline is first looked up in the same environment.

**recipes/mass-failure.md**
- P1: `environment-incident.png` in step 2.
- P2: an annotated cluster page.
- Gap: no link to environment incidents; yet the run's timeline shows the per-worker correlation.

**recipes/flaky-cleanup.md**
- P1: fix `flaky-detection.png`.
- Gap: "Candidates over the API" contradicts `flaky-tests`, where they show in the UI as "Proposed for quarantine".

**recipes/faster-suite.md** (2)
- P2: annotated timeline, and the Timeout opportunities table instead of `performance-trends.png`.
- Shorten the alt texts (106 words).

**recipes/broken-locator.md**
- P2: `next-step-change.png` in step 1, `vscode-heal.png` in step 2.
- Gap: the editor's "Heal" quick fix is not mentioned.

### Features: hand back a fix

**features/locator-healing.md** (1)
- P1: fix the resolution SVG.
- P2: annotated panel, the "diff rename" case, picking at failure time.
- Neither SVG has a dark theme. "In-page element probe" is easily confused with the Probes feature.
- Gaps: "Pick from snapshot", "Copy fix prompt" and "Copy patch" are documented nowhere.
- Move "Pause at a breakpoint" to `editor-breakpoints` (120 words).

**features/locator-usage.md**
- P2: scenes `locator-usage-drawer` and `project-locators`.
- Gaps: no `## Related`; one history phrasing.

**features/preflight.md**
- P2:
  - output after `--fix`;
  - diagram from the diff to the broken chains.
- Gaps:
  - the Playwright version the locator index requires;
  - a Git hook without husky.

**features/fix-plans.md** (10)
- P2:
  - decision tree of the "Next step" (it replaces a 330-word sentence);
  - the "More ways to fix" toolbox;
  - `fixPlanToMarkdown` output.

**features/auto-heal.md**
- P1: the rendered heal pull request.
- P2: the diff and the `Piwi-Heal` trailer, the settings screen.
- The description is wrong and there is no `## Related`.
- The `diff-rename` bug (§6).

**features/issue-tracking.md** (1)
- P1: the complete issue as it is created.
- P2: recapture the create dialog in the configured state.
- The screenshots show empty states or warnings, with unstyled markup. `project-integration-binding.png` is 1,750 px tall on screen.
- Gap: a JQL example.

**features/issue-automation.md**
- P2: the text of the automatic comments, and a recapture of the preview with its three groups.
- The alt text describes a row "waiting on a threshold" that the image lacks.

**features/pr-feedback.md** (46)
- P1: the complete comment.
- P2: the list of commit statuses (`piwi/tests`, `gate`, `change-coverage`).
- Gap: "Two things get posted" leaves out the gate and change coverage statuses.

**features/test-selection.md** (32)
- P2: crop `test-selections.png` after Analyze, and the selection builder with its preview.

**features/change-impact.md**
- P1: the three outcomes of `piwi run impact`.
- P2: diagram from a changed file to tests, and before and after at line level.
- Gap: shallow clone and `fetch-depth: 0`.

**features/ai-steps.md** (2)
- P1: a committed AI step's file.
- P2: lifecycle.
- Gaps:
  - an `export` block with no PowerShell version;
  - two "not available yet";
  - no `<Needs llm />`.

### Features: find what your tests miss

**features/scenario-gaps.md** (4)
- P2: the copied test skeleton (`renderScenarioDraft`).
- P3: a feature map in several colors.
- Two nearly identical oranges in `test-map-graph.svg`.

**features/uncovered-changes.md**
- P2: the `change-coverage` commit status.
- The Markdown blocks show other files than the screenshot.

**features/code-reach.md**
- P1: a browser coverage screenshot; both current ones show C# server code.
- P2: diagram "from a script to a file" (source maps).
- Gaps:
  - no `<Needs fixtures />`;
  - no troubleshooting when no browser file shows up;
  - two names for one option.

**features/css-coverage.md**
- P2: diagram of 3 rules and 2 tests.
- Gaps:
  - no `<Needs fixtures />`;
  - missing from `coverage-cost`;
  - the prerequisite sits in "Limits".

**features/server-coverage.md**
- P1: collection sequence.
- P2: a checkpoint on the `X-Piwi-Coverage` header.
- Gaps:
  - no `<Needs>`;
  - the only demo example is the restart case.

**features/combined-coverage.md** (1)
- P1: `coverage upload` output.
- P2: diagram from suites to lines.
- Gaps:
  - the "backend restarted" banner on the screenshot;
  - an orange clash between the two screens;
  - the `e2e` suite's prerequisite.

**features/coverage-insights.md** (2)
- P2: timeline of a path that depends on test order.
- P3: recapture `quarantine-coverage-loss`.

**features/probes.md**
- P1: `piwi probe` output, which exits 0 even on failure.
- P2: the "not noticed" gap row, and a scheduled CI job.

### Features: trends and reports

**features/analytics.md** (46)
- P1: the Overview dashboard (`tour-analytics.png` or a new cropped scene).
- P2: annotated scope bar, a chart's export menu.
- Gap: `analytics-handbacks.png` lacks the "Fix attempts" line.

**features/dashboards.md**
- P2: TV mode.
- The screenshots are at scale 0.54, and the "Move to band" menu item is missing.
- Gap: the built-in "Team" dashboard is left out.

**features/quality-reports.md**
- P1: the report and the email.
- P2: Markdown excerpt, recipients.
- Gaps: "two" instead of four; no `## Related`.

**features/timeline-markers.md**
- P1: `project-detail.png`, a marker's tooltip.
- P2: the markers panel.
- Gap: a GitHub Actions example.

**features/notifications.md** (10)
- P1: the messages as received.
- P2: the Slack form, the project's bell.
- The current screenshot is unreadable (5 px), and its channels are "unverified".
- Gaps:
  - port 465 implies `SECURE`;
  - no troubleshooting when nothing is delivered.

### Features: use it from elsewhere

**features/mcp.md**
- P1: flow diagram, real transcript.
- P2: the OAuth consent page, a tool's details.
- The screenshot shows port 3050 and Opencode.
- Gaps:
  - no Opencode section;
  - no check per client;
  - no troubleshooting (401, `mcp-remote`).

**features/agent-skills.md**
- P1: the agents' report-back loop.
- P2: a cluster's Activity, `skills add` output.

**features/desktop.md** (2)
- P1: first launch, "Run locally".
- P2: a project from a folder, MCP clients.
- Move "Jobs from your editor" and "Reproducing a flake" (230 words).

**features/extension.md** (4)
- P2: crop the popup.
- Gaps:
  - "aria-snapshot copier yet" contradicts "Assert a region";
  - pin the extension after installing it.
- Move the permissions table.

**features/pick-an-element.md**
- P1: loop video.
- P2: multi-pick, the "context for agent" block.
- Gap: address redaction is not mentioned.

**features/record-actions.md**
- P1: the recording bar, and the TypeScript produced.
- Split the single paragraph into three.

**features/lint-overlay.md**
- P3: the container case.

**features/extension-connection.md** (3)
- P1: sequence of the connection handshake.
- P2: the `/extension/connect` page and the code in the settings, side by side.
- Move about 380 words to a reference page.

**features/tested-elements.md**
- P2: the "At risk" tab, "Limit to an element".
- The screenshot is at scale 0.49, without the This page / All pages switch.

**features/report-a-bug.md**
- P1: the "Mark what's wrong" panel and the finished report.
- P2: loop video.
- Gap: inconsistent example amounts.

**features/replay-a-bug-report.md**
- P1: loop video.
- P2: the hand-off panel, the Export menu.
- Gap: "three" instead of four.

**features/bug-reports.md** (6)
- P1: state diagram.
- P2: Spec tab, the "Send to Piwi" preview.
- The caption "A report's page." says nothing.

**features/devtools.md**
- P1: the Playwright view.
- P2: the Locators console.
- The text and the image show two different elements.

**features/mock-requests.md**
- P2: the panel's Network tab.

**features/test-functions.md**
- P1: before and after code.
- P2: the review form.
- The screenshot shows the `scanned` badge, and the sources are not explained.

### Features: editors

**features/ide-integration.md** (19)
- P1: the "open in IDE" link hovered, with its menu open and annotated.
- P2: the Open in IDE dialog (scene `open-in-ide-settings`), a "your editor → what to set" table.
- Gap: no troubleshooting when nothing opens.

**features/editors.md** (0)
- P1: architecture, entry page, annotated "what you should see" screenshot.
- Move the commands table (416 words) to a reference page generated from `package.json`.
- Gaps:
  - 4 commands are missing;
  - no `<Needs>`.

**features/jetbrains.md** (763 words of margin)
- P1:
  - `jetbrains-heal.png`;
  - annotated `jetbrains-failures.png`;
  - a paused run scene (effort L, starting from `run-worker.mjs`).
- "Trial" badge.
- Gaps:
  - Node 20 for Rider;
  - IntelliJ Community.

**features/editor-failures.md**
- P1: `vscode-hover.png` recaptured.
- P2: "Failures follow your edits" in three images.
- Gaps:
  - the Baseline label;
  - the prerequisites of each quick fix.

**features/editor-runs.md**
- P2: the status bar and its states, the end-of-run notification.
- Gap: start with "run the test at the cursor".

**features/editor-coverage.md**
- P1: the main marks (green, gray, amber); the current image shows only the rarest one.
- The ASP.NET Core or Nitro contradiction (§5).

**features/editor-breakpoints.md** (2)
- P1: the editor and the browser side by side at the same stop.
- P2: loop video of picking a locator (L).
- Gap: the minimum reporter versions are spread over three pages.

**features/editor-run-control.md** (7)
- P1: the two unused images.
- P2: the annotated status bar.
- The text of `run-control.svg` renders at about 8 px.
- The terms "editor service", "run channel" and "stop" are used before their diagram.

**features/editor-stop-code.md** (2)
- P2: crop, before and after "Assert" code, a stop on failure.

**features/editor-recording.md**
- P1: loop video (L) or a still (M).
- Move "Send from Piwi Picker" (314 words) to its own page.
- The prerequisites sit at the bottom of the page.

**features/recorded-code.md**
- P1: before and after code, produced by `piwi codegen`.
- Gaps:
  - where to set the `E2E_*` values;
  - `defineConfig` against `wrapConfig`.

**features/editor-connection.md**
- P1: the three status bar states, the sources ladder, the table of real messages.
- Gaps:
  - no `## Related`;
  - an orphan sentence.

### Self-hosting

**operate/deployment.md**
- P1: topology.
- P2: a `/api/health` check.
- The Kubernetes manifest to fix, and a column that does not exist (§5).

**operate/one-click-deploy.md**
- The Render and Koyeb buttons are loaded from a third-party site.
- The Railway contradiction.
- No verify step; `openssl` instead of `node -e`.

**operate/production-checklist.md**
- P2: numbered topology, Settings → About.
- Gaps:
  - setup token, `PIWI_SITE_URL`, SMTP;
  - the list of outbound access;
  - a final verify step.

**operate/authentication.md** (4)
- P1: first administrator and sign-in.
- P2:
  - a table of the OAuth app fields;
  - an account linking tree.
- Split OAuth into its own page.
- Gaps: SMTP, account recovery, invitations, limits (§5).

**operate/project-access.md** (18)
- P2: diagram "rights add up", a user's roles.
- The grid is at scale 1 with unstyled markup.

**operate/api-keys.md**
- P1: key management (`user-api-keys`).
- Gaps:
  - the environment variables;
  - 401 or 403;
  - key rotation.

**operate/storage.md** (0)
- P2: Storage analysis.
- Gaps:
  - migration from local disk to S3;
  - an S3 check;
  - bucket versioning;
  - the UTC time zone.

**operate/database.md**
- P2: SQLite or PostgreSQL × local disk or S3 matrix.
- Gaps:
  - SQLite on a network file system;
  - `sslmode`;
  - database growth.

**operate/backup-restore.md**
- P2: the `.data/` tree.
- P1 gap: `PIWI_SECRET_KEY`.
- `sqlite3` is missing from the image.

**operate/upgrading.md** (10)
- P1: upgrade and rollback flow.
- P2: the real migration logs, `/api/version`.

**operate/metrics.md**
- P1: OpenMetrics output.
- Gaps:
  - `scheme: https`;
  - a link to `reference/metrics`;
  - a PromQL example.

**operate/tracing.md**
- P2: span waterfall.
- Gaps:
  - no `## Related`;
  - `OTEL_*` missing from the registry;
  - sampling;
  - no gRPC.

**operate/capabilities.md**
- P1: Setup page (`setup-ladder-declined`).
- A contradiction on who may decline a capability.

**operate/localization.md**
- P3: a screenshot of the settings.
- Gap: scheduled reports run in UTC by default.

**operate/integrations.md** (17)
- P2: direction of the network flows with Jira.
- `integrations-settings.png` shows the empty state.
- Cloud or self-hosted contradiction.

### Reference

**reference/cli.md**
- P2: one tested output block per command.
- Gaps:
  - `coverage` missing from the table;
  - "four" instead of six;
  - the statuses of `init`;
  - the exit codes of `probe`, `init` and `skills`.

**reference/clues.md**
- P2: annotated "Most likely" and "All clues".
- Gap: the ids of the failure stories.

**reference/gap-detectors.md**
- P1: detector ids, each detector's confidence.
- P2: an annotated row, a worked score.

**reference/notification-events.md**
- P1: signature, retries, deduplication.
- P2: a sample payload per event, a diagram "what a finished run sends".

**reference/steps-format.md**
- P2: `steps.json` and the spec it produces, side by side.
- Gaps:
  - no `## Related`;
  - the unit of `timestamp`.

**reference/test-metadata.md**
- P2: an annotated "where each field shows"; an origin × use matrix generated from `RUN_USES`.
- SQL table names are exposed to users.

**reference/test-search.md**
- P2: completion (scene `test-search`).
- Gaps:
  - `-flaky` is not a status filter;
  - `project:` means the Playwright project.

**reference/locator-stability.md**
- P2: the "At risk" tab.
- The page could be generated from `LOCATOR_STABILITY_RULES`.

**reference/bug-report-file.md**
- P2: a sample `.piwibug` file to download.

**reference/keyboard-shortcuts.md**
- P3: `<kbd>` and a print stylesheet.
- Gap: the editors' shortcuts are missing.

**reference/coverage-cost.md**
- P3: an overhead chart.
- Gaps: CSS, the date and version of the measurements, `## Related`.

**reference/analytics-widgets.md** (generated)
- P2: one contact sheet of thumbnails per band; the screenshot script can produce it.
- Add the Options and size columns.

**reference/reporter-options.md** (generated)
- P2: a `wrapConfig` example at the top.
- Complete the JSDoc of `ciInfo`, `tags`, `customData`, `label` and `relatedIssue`.

**reference/metrics.md** (generated)
- Gaps: breakdown dimensions, the OpenMetrics name, "wait steps" undefined.

**reference/mcp-tools.md** (generated)
- Gap: the parameters column.

**reference/features.md, reference/whats-new.md** (generated)
- Fix the assistant's `where`.
- The `whats-new` entries are raw commit subjects.

**blog/**: nothing.
