# Issue trackers and wikis — Jira first

A design record for turning a failure into a ticket without leaving the dashboard, keeping that ticket honest as the
failure evolves, routing it to the team that owns the test, and — second — publishing what Piwi knows to Confluence.
Underneath both sits an **integration layer** (connections, providers, a neutral document model, a durable action
outbox) so the next tracker or wiki is one provider file, not one more feature.

**Status:** accepted; rollout steps 1–3 shipped (foundations, create an issue, keep it honest — two-way sync, the
project binding with policies and owner routes, the optional webhook, the needs-ticket queue, and localization), and
the automatic creation of step 4 (ordered rules over branches, environments, test tags, occurrences, runs and days;
the flaky, already-tracked and labeled-issue guards; the daily cap; a preview; a run scope for the write-backs, a
diagnosis comment and description updates that never overwrite an edit made in the tracker); flaky-test and run
tickets (the rest of step 4) and Confluence (step 5) remain. · **Scope:** Jira Cloud (and the shape that lets Server/Data Center follow),
Confluence, the shared layer, and the smaller trackers that fall out of it · **Date:** 2026-09-13 · **Builds on:**
entity links, the notifications outbox, the auto-heal outbox, the SCM provider layer, ownership, fix plans, offline
export, share links.

**Summary.** Piwi already ends every investigation with something to hand over — a headline, a cluster, an owner, a
diagnosis, a validated patch, a locator replacement, a verify command. Today the hand-over to the team's tracker is a
copy-paste: create the ticket in Jira by hand, paste the error by hand, come back and pin the URL by hand, and never
hear again when the ticket closes or the cluster regresses. The proposal makes the ticket a **one-click, evidence-rich
artifact Piwi writes and keeps in sync**: *Create issue* on a cluster, an execution, a flaky test or a run produces a
Jira issue whose body is the fix plan, links it back as the known issue, and from then on Piwi comments when the fix
lands, reopens when it regresses, and reads the ticket's status back into the inbox. Routing follows the owner Piwi
already derives (`piwi:owner`, CODEOWNERS): the checkout team's failures land in the checkout team's Jira project,
assigned to whoever they mapped. Confluence gets the same document model pointed at a page — an investigation report,
a release test report, a weekly digest per team. Everything is off until an administrator connects a system, every
outbound write is a durable, retried, auditable action, and secrets follow the existing encrypt-at-rest rules.

---

## Decisions

Settled on 2026-09-13 with the maintainer; the open questions below that these answer are marked as such.

1. **Jira Cloud only** in the first cut (REST v3, email + API token, ADF). The connection carries a `flavor` field and
   the client interface is shaped so Server / Data Center is a second client file later.
2. **Owner routes live on the project binding.** No Team entity yet; it is promoted once a second consumer wants the
   same mapping.
3. **Build rollout steps 1–3** — foundations, create an issue, keep it honest (two-way sync) — before any
   automatic creation. The binding form carries the auto-create policy fields disabled by default; the trigger code
   waits for step 4.
4. **Jira only** in the first tracker milestone. GitHub Issues and GitLab Issues follow as provider files on the SCM
   token.
5. **The ticket is written in the language of its destination.** A `locale` on the project binding (defaulting from
   the connection, then `en`) drives every sentence Piwi authors in an issue or a comment through a message catalog;
   the data (titles, errors, locators, paths, commands, patches) is never translated; the AI prose follows a
   first-class *response language* setting on AI diagnosis. French ships with English. See *Localization*.

---

## Problem

Four gaps, in the order a team meets them.

### 1. The ticket is written by hand, from evidence Piwi already has

The cluster page states the failure in one line, the most likely cause, the affected tests, the owner, what changed,
and the next step; the fix plan (`server/utils/fix-plan.ts`, `GET /api/failure-clusters/:id/fix-plan?format=markdown`)
renders all of it as Markdown "for a ticket or an agent"; the offline export (`shared/export/render-markdown.ts`)
says the same in its header comment — "for pasting into an issue tracker". The paste is the product boundary. A
developer opens Jira in another tab, types a summary, pastes what they can, and the ticket is already a lossy copy.

### 2. A link is pinned by hand and then goes stale

Entity links (`entity_links`, `shared/handlers/links.ts`, the `l` key in the inbox —
`app/components/home/OpenFailuresCard.vue#linkIssue`) let a cluster carry a "known issue". The link is enriched once
at creation through `server/utils/unfurl/` — a title and a status badge — and refreshed only when someone clicks
refresh. Nothing reads the ticket back into the workflow: a cluster whose Jira issue was closed last week still sits in
the inbox as *open*, and a cluster that regressed after its ticket was resolved tells Jira nothing.

### 3. The Jira and Confluence unfurl cannot be configured

`server/utils/unfurl/index.ts#loadAtlassianConfig` reads an `atlassian` app setting (`{ baseUrl, email, apiToken }`,
encrypted). **Nothing writes it** — no settings endpoint, no settings page, no environment variable. The
`JiraUnfurlProvider` and `ConfluenceUnfurlProvider` classes are unreachable in every deployment. On top of that,
`shared/link-detect.ts` recognizes Jira only on `*.atlassian.net` or a path with a segment before `/browse/`, so a
self-hosted `https://jira.company.com/browse/XYZ-99` is a `generic` link (the E2E suite asserts exactly that:
`tests/entity-links.spec.ts:34`).

### 4. Ownership stops at a string

Piwi knows who answers for a failing test (`server/utils/scm/ownership.ts`: `piwi:owner`, then CODEOWNERS), routes
notifications by owner (`SubscriptionFilters.owners`) and names the owner in PR comments. But the owner is a string
such as `@acme/checkout`; nothing maps it to *the checkout team's Jira project*, *their component*, *their assignee* —
so "file this with the right team" is still a human's job, and the inbox cannot say "this cluster has been open four
days on the default branch and nobody has a ticket for it".

Two smaller loose ends: the reporter's `relatedIssue` option (`packages/reporter/src/public/options.ts:183`) is stored
in run metadata and never becomes a link; and `test_cases.link` accepts only an absolute URL, so the common
`{ type: 'issue', description: 'PROJ-12' }` annotation convention resolves to nothing.

## What exists to build on

Everything below is shipped and is reused, not replaced.

| Piece | Where | What it gives the integration |
|---|---|---|
| Entity links + provider detection + unfurl | `entity_links`, `shared/link-detect.ts`, `server/utils/unfurl/` | The join between a Piwi entity and an external record; the chip (`LinkChip`, `EntityLinks`); the `list_links` MCP tool |
| Notifications outbox | `notification_deliveries`, `server/utils/notifications/dispatch.ts`, `server/tasks/notifications/sweep.ts` | Durable delivery with dedupe key, bounded attempts, progressive backoff (1/5/15/60/240 min) |
| Auto-heal outbox | `heal_actions`, `server/utils/heal/dispatch.ts`, `server/tasks/heal/sweep.ts` | The same pattern for a *write to an external system*: payload snapshotted at enqueue, result recorded, `GET /api/heal-actions` for review |
| SCM providers | `server/utils/scm/` (`ScmProvider`, per-host classes, `createScmProvider`) | A provider-class layer with token resolution (per-project → global) and `fetchIssue` already implemented for GitHub/GitLab |
| Settings pattern | `server/api/settings/pr-feedback.*`, `shared/pr-feedback.ts`, `settings-metadata.ts`, `HELP_TOPICS`, `PIWI_ENV_VARS` | Resolved-settings objects stored whole in `app_settings`, env-managed fields, admin-only pages |
| Ownership | `server/utils/scm/ownership.ts`, `failure_clusters.assignee` | Who a failure belongs to, with the annotation winning over CODEOWNERS |
| Fix plan + Markdown | `server/utils/fix-plan.ts`, `shared/fix-plan-markdown.ts` | The ticket body, already written |
| Offline export | `shared/export/` (bundle, Markdown, HTML, PDF) | The report body for Confluence, already written |
| Share links | `server/utils/share-links.ts#mintShareLink` (behind `PIWI_SHARE_LINKS_ENABLED`) | A URL a Jira reader without a Piwi account can open |
| Inbox + triage | `shared/handlers/failure-clusters.ts#getOpenFailureClusters`, `bulkTriageClusters`, `ClusterStateLine.vue` | The place a "Create issue" action belongs, with keyboard and bulk precedents |
| PR feedback + Slack | `server/utils/scm/pr-feedback.ts`, `dispatch.ts#sendToSlack` | The surfaces a ticket key should travel to |
| Secrets & SSRF | `server/utils/crypto.ts`, `server/utils/channels.ts#SECRET_CONFIG_FIELDS`, `server/utils/safe-fetch.ts` | Encrypt at rest, never echo, guard user-supplied URLs |

## Design in one page

Four new pieces, one changed one.

```
                   Settings → Integrations (admin)                Project → Integrations (admin)
                   ┌───────────────────────────┐                  ┌──────────────────────────────┐
                   │ integration_connections   │◄─────────────────│ project_integrations         │
                   │ jira · confluence · …     │   binding        │ Jira project key, issue type,│
                   │ base URL, encrypted creds │                  │ labels, owner routes, policy │
                   └─────────────┬─────────────┘                  └──────────────┬───────────────┘
                                 │ factory                                        │
                                 ▼                                                ▼
        ┌──────────────────────────────────────┐        ┌────────────────────────────────────────┐
        │ Provider (server/utils/integrations/) │        │ Trigger                                │
        │ IssueTracker: createIssue, getIssue,  │◄───────│ • a click (cluster, inbox, execution,  │
        │   comment, transition, search, attach │        │   flaky test, run) · MCP create_issue  │
        │ Wiki: createPage, updatePage, attach  │        │ • a policy (cluster.new on default     │
        └──────────────┬───────────────────────┘        │   branch, fix landed, regressed, sync) │
                       │ renders                        └──────────────┬─────────────────────────┘
                       ▼                                               ▼
        ┌──────────────────────────────┐            ┌──────────────────────────────────────────┐
        │ IssueDocument (shared/)      │            │ integration_actions (outbox)             │
        │ one neutral model, built     │            │ create-issue · comment · transition ·    │
        │ from cluster / execution /   │  payload   │ sync-status · create-page · update-page  │
        │ flaky test / run facts       │───────────►│ dedupe key · attempts · backoff · result │
        │ → Markdown · ADF · wiki ·    │            │ swept by server/tasks/integrations/sweep │
        │   Confluence storage         │            └──────────────┬───────────────────────────┘
        └──────────────────────────────┘                           │ result
                                                                   ▼
                                                   entity_links (+ connection_id, external_id, origin)
                                                   → the known-issue chip, the inbox, PR feedback, Slack
```

- **Connections** are the credentials: one row per external system an administrator connected. Global by design.
- **Providers** are the code: one folder per product implementing a small interface, selected through a registry.
- **The document** is the content: one provider-neutral tree built once per entity, rendered per target markup.
- **Actions** are the writes: every outbound mutation is an outbox row, retried, recorded, listable.
- **Entity links** stay the join between Piwi and the outside world; they gain three columns so a link Piwi created
  can be told from one a person pinned, and can be refreshed through its connection.

## The integration layer

### Connections

A new table, mirroring `notification_channels` in spirit (admin-owned destination with a JSON config whose secret
fields are encrypted) but global-only: a connection is instance infrastructure, not a personal preference.

```
integration_connections
  id, provider ('jira' | 'confluence' | 'github-issues' | 'gitlab-issues' | 'linear' | …),
  name, base_url,
  config JSON        -- provider-specific, non-secret (site id, cloud/server flavor, default space…)
  credentials TEXT   -- AES-256-GCM (PIWI_SECRET_KEY) JSON: { email, apiToken } | { token } | { pat }
  status ('unverified' | 'ok' | 'failed'), last_checked_at, last_error,
  managed_by ('db' | 'env'),
  created_at, updated_at
```

- **Test connection** (`POST /api/integrations/connections/:id/test`) calls the provider's `whoAmI()` — Jira
  `GET /rest/api/3/myself` — and records status and the account it resolved to; the settings page shows it.
- **Env-managed connection.** `PIWI_JIRA_BASE_URL`, `PIWI_JIRA_EMAIL`, `PIWI_JIRA_API_TOKEN` (secret) create a
  read-only connection at startup, the way SMTP and AI keys are env-managed today (`EnvManagedBadge`).
  `PIWI_CONFLUENCE_*` do the same and fall back to the Jira values when unset — the same Atlassian site and API token
  serve both products. Registered in `PIWI_ENV_VARS` with `since`, so the configuration reference and the deploy
  manifests pick them up.
- **Secrets never leave the server.** The list and detail endpoints return `config` and a `hasCredentials` flag; the
  credential blob joins `SECRET_CONFIG_FIELDS`-style filtering. Saving with an empty credential keeps the stored one.
- **The dead `atlassian` setting is retired.** `loadAtlassianConfig` reads the Jira connection instead; there is no
  migration because nothing could ever have written the old key.

### Providers

`server/utils/integrations/` — the server-side layer, one folder per product, selected through a registry:

```ts
// shared/integrations/registry.ts — pure metadata the UI and docs render from
export const INTEGRATION_PROVIDERS = {
  jira:       { kind: 'tracker', label: 'Jira',       icon: 'i-simple-icons-jira',       capabilities: ['create', 'comment', 'transition', 'search', 'attach', 'assignable-users', 'webhook'], credentialFields: [...] },
  confluence: { kind: 'wiki',    label: 'Confluence', icon: 'i-simple-icons-confluence', capabilities: ['create-page', 'update-page', 'attach', 'search'], credentialFields: [...] },
  'github-issues': { kind: 'tracker', … capabilities: ['create', 'comment', 'transition', 'search'] },
  …
} as const;
```

```ts
// server/utils/integrations/types.ts
export interface IssueTracker {
  readonly provider: TrackerProviderName;
  whoAmI(): Promise<{ id: string; displayName: string }>;
  listProjects(): Promise<TrackerProject[]>;                       // for the binding form
  listIssueTypes(projectKey: string): Promise<TrackerIssueType[]>;
  searchAssignable(projectKey: string, query: string): Promise<TrackerUser[]>;
  createIssue(input: CreateIssueInput): Promise<TrackerIssue>;      // input.body is an IssueDocument
  getIssue(key: string): Promise<TrackerIssue | null>;              // { key, url, title, status, statusCategory, assignee }
  addComment(key: string, body: IssueDocument): Promise<void>;
  listTransitions(key: string): Promise<TrackerTransition[]>;
  transition(key: string, transitionId: string): Promise<void>;
  search(query: TrackerSearch): Promise<TrackerIssue[]>;           // dedupe: by label + text, provider-translated
  attach?(key: string, file: { name: string; bytes: Uint8Array; mime: string }): Promise<void>;
  issueUrl(key: string): string;
  parseIssueUrl(url: string): { key: string } | null;             // extends link detection for self-hosted hosts
}

export interface Wiki {
  readonly provider: WikiProviderName;
  whoAmI(): Promise<{ id: string; displayName: string }>;
  listSpaces(): Promise<WikiSpace[]>;
  createPage(input: { spaceId: string; parentId?: string; title: string; body: IssueDocument }): Promise<WikiPage>;
  updatePage(pageId: string, input: { title?: string; body: IssueDocument }): Promise<WikiPage>;  // versioned
  getPage(pageId: string): Promise<WikiPage | null>;
  attach?(pageId: string, file: …): Promise<void>;
}
```

`createTracker(db, connectionId)` / `trackerForProject(db, projectId)` mirror `createScmProvider`: resolve the
connection (project binding → the instance's only tracker connection when there is exactly one), decrypt, instantiate.
The SCM-backed trackers (`github-issues`, `gitlab-issues`) wrap the existing `GitHubProvider` / `GitLabProvider` and
reuse the SCM token — no second credential to configure for the most common non-Jira case.

Why classes here when `shared/deploy/*` deliberately uses stateless functions: a tracker carries a base URL, a
credential and a flavor across a dozen calls, and the SCM layer already set the precedent (`ScmProvider`). The
registry stays data; only the per-product client is a class.

### The document model

One neutral tree so the body is written once and every target renders it faithfully:

```ts
// shared/integrations/document.ts
export type DocNode =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'bullets'; items: Inline[][] }
  | { type: 'code'; language?: string; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'facts'; rows: [label: string, value: Inline[]][] }   // the SituationBlock <dl>, in a ticket
  | { type: 'rule' };
export type Inline = string | { text: string; href?: string; code?: boolean; strong?: boolean };
export interface IssueDocument { nodes: DocNode[] }
```

Renderers, all pure and unit-tested against fixtures:

| Renderer | Target | Notes |
|---|---|---|
| `render-markdown.ts` | GitHub, GitLab, Linear, YouTrack, the clipboard | Reuses the fences/tables helpers `shared/export/render-markdown.ts` already has |
| `render-adf.ts` | Jira Cloud (REST v3 `description`, comments) | Atlassian Document Format: `doc/paragraph/heading/codeBlock/bulletList/table/text` with `strong`/`code`/`link` marks. Small, fully covered |
| `render-jira-wiki.ts` | Jira Server / Data Center (REST v2) | `h2.`, `{code}`, `||header||`, `[text|url]` |
| `render-confluence-storage.ts` | Confluence Cloud and Server | XHTML with the `code` structured macro; the same tree the HTML export renders, minus scripts |

The **builders** turn Piwi facts into a document and live next to the facts they read, so a field added to the
fix plan reaches the ticket without a second edit:

- `buildClusterIssue(cluster, fixPlan, opts)` — the default ticket. Title: the cluster's name (AI title, else the
  deterministic one). Body, in the page's reading order: *What happened* (headline, error type, first/last seen,
  occurrences, affected tests with owners, branch and environment of the latest occurrence, commit), *Most likely*
  (diagnosis summary and root cause when one exists, else the story/top clue), *Evidence* (error excerpt in a code
  block, the failing locator, a screenshot attachment when the tracker supports it), *What to do* (suggested patch
  as a diff, the locator replacement with file and line, the verify command, reproduce steps), *Links* (the cluster
  page, the latest execution, an optional share link, the run). Sections degrade independently exactly as the fix
  plan does.
- `buildExecutionIssue(execution, opts)` — one failing test; the same body scoped to that execution and its cluster.
- `buildFlakyTestIssue(flakyTest, opts)` — "Stabilize *title*": flakiness rate, root-cause category, wasted CI
  minutes, the attempt delta when one exists, last failing execution.
- `buildRunIssue(run, opts)` — a release blocker: the run's verdict, new-vs-known failures (each with its cluster's
  existing ticket key when there is one), wasted time.
- `buildReportPage(bundle)` — the export bundle as a Confluence page (see [Confluence](#confluence)).

Every builder takes `opts: { includeDiagnosis, includePatch, includeScreenshot, includeShareLink, siteUrl }` so the
create modal's toggles and the per-project policy set the same knobs.

### Actions: the outbox

`integration_actions` mirrors `heal_actions` column for column — this is the third instance of the same shape, and
the proposal extracts the two shared bits into `server/utils/outbox.ts` (`nextAttempt(attempts) → { status,
scheduledFor }` and the due-rows predicate) rather than a framework: the three sweepers keep their own loops.

```
integration_actions
  id, connection_id (FK, cascade), project_id (FK, cascade),
  kind ('create-issue' | 'comment' | 'transition' | 'attach' | 'sync-status' | 'create-page' | 'update-page'),
  entity_type ('failure_cluster' | 'test_runs_case' | 'test_case' | 'test_run'), entity_id,
  dedupe_key UNIQUE,          -- 'create-issue:failure_cluster:42:conn7' — a second click or a duplicate event is a no-op
  status ('pending' | 'done' | 'failed' | 'skipped'), attempts, scheduled_for, error,
  payload JSON,               -- the rendered document + provider fields, snapshotted so a retry is deterministic
  result JSON,                -- { key, url } | { commentId } | { pageId, version }
  requested_by (FK users, set null), created_at, finished_at
```

- `server/tasks/integrations/sweep.ts` runs every minute like the other two sweepers; `emit`-style callers kick a
  sweep immediately after enqueueing, so a click resolves in one round-trip when the tracker is up and degrades to a
  retry when it is not (Jira Cloud answers `429` with `Retry-After`; the backoff honors it).
- A `create-issue` action's success also **writes the entity link** (`origin: 'created'`, `connection_id`,
  `external_id`) in the same transaction, so the chip appears the moment the key exists.
- `GET /api/integrations/actions?projectId=&status=` lists what Piwi did, with the provider's own error text on
  failures — the same review surface `GET /api/heal-actions` gives auto-heal. The connection page shows the last 50.
- Retention prunes finished actions with the notification history (`server/utils/retention.ts`).

### Entity links become the join

Three columns on `entity_links`, all nullable so existing rows are untouched:

```
connection_id  FK integration_connections ON DELETE SET NULL   -- which connection can read/write this record
external_id    TEXT                                            -- the tracker's stable id (Jira issue id, not the key — keys change on move)
origin         'pinned' | 'created' | 'annotation' | 'reporter' -- who put it there
```

- **Detection learns the project's connection.** `detectProvider(url)` keeps its URL-shape rules; a server-side
  `detectProviderWithConnection(db, url, projectConnectionId)` first asks the `parseIssueUrl` of the connection the
  link's project is bound to, so `https://jira.company.com/browse/XYZ-99` is `jira` once the project is bound to that
  host, and a link to any other site, another connection's included, stays a plain link. The demo and the client keep
  the pure detector.
- **Refresh goes through the connection**, replacing the ad-hoc `loadAtlassianConfig`. `unfurlUrl` becomes: a link
  with a `connection_id` refreshes through `tracker.getIssue(externalId)`; a link without one keeps today's path.
- **Two loose ends close.** The reporter's `relatedIssue` (`'PROJ-12'`) becomes a run link (`origin: 'reporter'`)
  when a tracker connection can resolve the key to a URL. A test annotation `{ type: 'issue' | 'link' }` whose
  description is a bare key is resolved the same way into `test_cases.link`; an absolute URL keeps working.

### Security posture

- **Credentials** encrypt with `PIWI_SECRET_KEY` (`encryptSecret`), are never returned by any endpoint, and are
  redacted from action payloads and error strings before storage (`Authorization` headers never enter `error`).
- **Connection base URLs are administrator-supplied and trusted**, so a Jira Data Center on `10.0.0.5` works. They
  bypass `assertPublicHttpUrl`; every URL a *non-admin* supplies (pinning a link, a webhook) keeps going through
  `safeFetch`. Documented in the operate page and in the help hint.
- **Roles.** Managing connections and bindings: `administrator`. Creating an issue, commenting, linking:
  `administrator` and `reporter` — the same roles that may pin a link today. Reading keys and statuses: any project
  member. Every endpoint declares it in `x-required-roles`; MCP write tools call `assertWriteRole`.
- **Scope.** A connection is global; a *binding* is per project, and every action carries `project_id` so
  `requireProjectAccess` gates it like everything else.
- **Inbound webhooks** (Tier 2) are optional, secret-in-path (`/api/integrations/jira/webhook/<token>`), rate-limited
  with `server/utils/rate-limit.ts`, and only ever *refresh a link* — a webhook cannot create or transition anything.
- **Attachments** honor the export size budget (`shared/export/limits.ts`): one screenshot, capped, never the trace.

## Jira

### Tier 1 — create an issue from a failure (manual)

**Entry points**, each one click plus a preview:

| Where | Entity | Label |
|---|---|---|
| Cluster page, state line | `failure_cluster` | *Create issue* is the primary action when the cluster has no known issue and a tracker is connected; once one exists the chip shows the key and status and the action becomes *Comment* / *Open in Jira* |
| Inbox row and bulk bar | `failure_cluster` | `c` creates for the selected row; the bulk bar creates one issue per selected cluster (dedupe makes a re-run safe) |
| Execution page (failing) | `test_runs_case` | *Create issue* when the execution's cluster has no issue; *Link to <key>* when it has — an execution never spawns a second ticket for a known cluster |
| Flaky leaderboard row | `test_case` | *Create issue* → the "stabilize" ticket |
| Run page (failed) | `test_run` | *File release blocker* |
| MCP | any of the above | `create_issue` — an agent that just read the fix plan files the ticket with it |

**The create modal** (one shared component, `CreateIssueModal.vue`, fed by `GET /api/integrations/issue-draft?entityType=&entityId=`):

- **Title** — editable, prefilled from the builder.
- **Where** — connection (hidden when there is one), Jira project (prefilled from the binding, else a picker over
  `listProjects`), issue type (prefilled, else `listIssueTypes`), labels (binding labels + `piwi` + `piwi-cluster-42`
  — the second is how dedupe search finds it later), priority mapped from `piwi:priority` (`critical → Highest` …),
  assignee (prefilled from the owner route; otherwise a search over `searchAssignable`).
- **What to include** — toggles for diagnosis, patch, screenshot attachment, share link; defaults from the binding.
- **Preview** — the rendered Markdown of the document (`MarkdownPreview`), so what lands in Jira is what was read.
- **Create** → enqueues the action, awaits the immediate sweep, and returns `{ key, url }`; the toast says
  *PROJ-123 created* with *Open* and *Undo* (undo unlinks — it does not delete the Jira issue, and the toast says so).

**Dedupe before creating.** The draft endpoint answers with `existing` when it finds a candidate: a link already on
the entity or on its cluster; a tracker search for the `piwi-cluster-<id>` label, or for the fingerprint's short hash
in a `piwi-fp-<8 hex>` label (survives a cluster merge); and a *fixed before* match whose earlier cluster carried an
issue. The modal then leads with *PROJ-98 already tracks this (Open) — link it instead?* and *Create anyway* second.

**What the ticket carries back.** Every issue Piwi creates ends with a `Piwi-Cluster: 42` trailer line and the
`piwi` label, the way heal commits carry `Piwi-Heal:`, so a human or a JQL filter can find every Piwi-filed issue.

**The key travels.** Once a cluster has a known issue: the inbox row shows the key with the status color (exists);
`cluster.new`/`cluster.fixed`/`cluster.regressed` Slack and email messages name it; the PR feedback comment says
*tracked in PROJ-123* on each failure whose cluster has one; the fix plan and the exports list it under *Links*;
`get_fix_plan` returns `issue: { key, url, status }`.

**Two cheap wins ride along**: the `relatedIssue` reporter option becomes a run link, and bare-key issue annotations
resolve to `test_cases.link` (both need only a connection, no binding).

### Tier 2 — keep the ticket honest

- **Status pull.** `server/tasks/integrations/sync.ts` (every 15 min, `PIWI_INTEGRATIONS_SYNC_MINUTES`) refreshes
  every link with a `connection_id` whose entity is still open: `statusText`, `statusColor`, `title`, assignee. Links
  on resolved clusters refresh daily. `statusCategory` (`new` / `indeterminate` / `done`) is what the policies read;
  the name is what the chip shows.
- **Policies on the binding**, each a checkbox, all off by default:

  | When Piwi observes | Jira action | Piwi action |
  |---|---|---|
  | `cluster.fixed` (fix verification) | Comment: *Fix landed in run #N (commit `abc123`, verified: diagnosis-verified) — every affected test passed* | — (the existing auto-resolve already applies) |
  | `cluster.fixed` and *transition on fix* is on | Transition to the configured status (`Done`, chosen from `listTransitions` at binding time) | — |
  | `cluster.regressed` | Comment: *Regressed in run #N — the fix did not hold*; optional transition (`Reopen`) | — (the existing reopen applies) |
  | New occurrences on an open ticket | One comment per day at most: *Still failing — +12 occurrences in 4 runs since the last note, latest run #N* | — |
  | Ticket moved to `done` | — | The cluster's state line offers *Mark resolved — PROJ-123 is Done*, or resolves automatically when *resolve on ticket close* is on; the triage note records the transition |
  | Ticket reopened while the cluster is resolved | — | The cluster reopens with a note, mirroring `cluster.regressed`'s `reopened` |
  | Cluster merged into another (`mergeFailureClusters`) | Comment on both: *merged into PROJ-124 / absorbed PROJ-123* | The surviving cluster inherits the links |

  Every row above is an outbox action, so it is retried, deduped (`comment:failure_cluster:42:fixed:r1234`) and
  listed.
- **Inbound webhook** (optional): a Jira admin registers `https://piwi.example.com/api/integrations/jira/webhook/<secret>`
  for *issue updated*; the handler looks the issue id up in `entity_links.external_id` and refreshes that one link.
  Polling stays the baseline because Atlassian Cloud usually cannot reach a self-hosted Piwi, and Data Center often
  sits on the same network but behind a proxy nobody wants to open.

### Tier 3 — automatic creation and team routing

- **Per-project binding** (`project_integrations`): connection, Jira project key, issue type, labels, default
  assignee, the include-toggles, the policies above, and **owner routes** — an ordered list of
  `{ owner: '@acme/checkout' | 'alice@…', projectKey?, componentId?, assigneeAccountId?, labels? }`. The cluster's
  owner (`piwi:owner`, else CODEOWNERS, overridden by an assignee) picks the first matching route; the binding's
  defaults fill the rest. This is how "file it with the right team" stops being a human's job.
- **Auto-create policy**, modeled on auto-heal's conservative posture: off by default, per-project, and only when
  *every* guard passes — the cluster is new on the **default branch**, has at least *N* occurrences across at least
  *M* runs (defaults 2 and 2, so a one-off never files), is not classified as flaky by `flaky-classify`, its owner
  matches a route (or *route unmatched owners to the default* is on), no candidate was found by dedupe, and the
  project is under its daily cap (default 5). The action is enqueued from `emitRunNotifications` next to
  `cluster.new`, and the resulting issue is what the `cluster.new` notification then names.
- **A `needs-ticket` inbox queue**: open clusters on the default branch older than the configured age with no known
  issue — the team-process view of the gap in Problem 4. With auto-create on, the queue is what the guards left out.
- **Teams as an entity** (open question 2): a `teams` table — name, owner matchers, members (Piwi users), and
  per-provider identities (Jira project/component/assignee, Slack channel, email) — would make the routes above,
  the notifications' owner filter (free text today), the inbox's *Mine* queue and a per-team analytics cut all read
  one source. The proposal recommends starting with routes on the binding (nothing to migrate, one form) and
  promoting them to a team entity once two consumers beyond Jira want the same mapping.

### Jira Cloud versus Server / Data Center

One provider folder, one `flavor` on the connection, two thin clients behind the same interface:

| | Cloud | Server / Data Center |
|---|---|---|
| Auth | Basic `email:apiToken` | Bearer personal access token (or Basic user:password on old versions) |
| API | REST v3, `/rest/api/3/…`, search at `/search/jql` | REST v2, `/rest/api/2/…`, search at `/search` |
| Rich text | ADF (`render-adf.ts`) | Wiki markup (`render-jira-wiki.ts`) |
| Users | `accountId`; email search restricted by privacy settings | `name`/`key`; email search open |
| Webhooks | Admin-registered, unsigned | Same, plus signed on recent DC versions |

The flavor is detected from the base URL (`*.atlassian.net` → cloud) and overridable. Everything above the client —
documents, actions, policies, UI — is flavor-blind.

## Confluence

Second in priority, and it is the same layer pointed at pages: a wiki connection, the `Wiki` interface, the
Confluence-storage renderer, `create-page` / `update-page` actions, and an entity link (`provider: 'confluence'`,
`origin: 'created'`) back to what was published.

- **Publish an investigation** — the cluster or execution page's *Export* menu gains *Publish to Confluence*: space
  and parent page from the project binding (or a picker over `listSpaces`), the `ExportBundle` rendered through the
  document model (one screenshot attached, the trace listed by name), the page linked back. A post-mortem that reads
  like the dashboard, in the place the team keeps post-mortems.
- **A run report** — *Publish test report* on a run page: verdict, counts, new versus known failures with their ticket
  keys, flaky tests, wasted time, the changes since the last run. Same builder the PDF export uses, different renderer.
- **A living page** — a per-project (or per-team, once teams exist) *Quality digest* page updated in place on a
  schedule: open clusters by owner with ticket keys and ages, the flaky leaderboard, wasted CI minutes, fixes
  verified this week. `update-page` keeps one page id and bumps the version, so the page has a history and a stable
  URL people can bookmark. Modeled on the notifications digest (`mode: 'digest'`, `digestAt`).
- **Runbook lookup** (later) — when a cluster's headline matches a page title in the bound space (CQL `title ~`),
  the cluster page offers *A runbook exists: <title>*. Cheap once the connection exists; not in the first cut.

The Confluence page body is the export bundle, so the size budget and the omission notes already exist.

## Localization

Piwi's dashboard is English, and the teams reading the tickets it files are not always. A ticket is a document
written for a specific audience, so its language is a property of its **destination**, not of the viewer: the Jira
project belongs to a team, and the binding to that project says which language the team reads. Three kinds of text
meet in a ticket, and each is handled differently.

| Text | Examples | Handling |
|---|---|---|
| What Piwi authors | Section headings (*What happened*, *Most likely*), fact labels (*First seen*, *Affected tests*), policy comments (*Fix landed in run #N*), the footer | A typed message catalog per language (`shared/integrations/messages/<locale>.ts`), selected by the binding's `locale`. Dates, numbers and plurals go through `Intl` with that locale. A completeness test keeps every language at parity with `en` |
| Data | Test titles, error text, locators, file paths, the verify command, the patch, commit subjects | Never translated — it is the team's own code and Playwright's own output, quoted verbatim |
| Prose a model wrote | The diagnosis summary and root cause, the AI cluster title | Follows the AI *response language* setting (global, per-project override, `PIWI_AI_LANGUAGE`), injected into every prompt that produces prose a person reads — so the dashboard's diagnosis and the ticket's *Most likely* section agree |

Where the language lives: `integration_connections.config.locale` is the connection's default (a French Atlassian site),
`project_integrations.locale` overrides it per project, the create modal offers a per-issue *Language* select
defaulting from the binding, and the `create_issue` MCP tool takes `locale`. `en` and `fr` ship first; another language
is one catalog file.

**What stays English on purpose.** The deterministic sentences the dashboard computes from the evidence — the
one-line headline, the story, the clues, the state line — are English templates that quote locators and Playwright
terms (`shared/failure-verdict.ts`, `shared/failure-clues.ts`, `shared/cluster-state.ts`, about 1,500 lines). They are
reproduced verbatim in the ticket's *What happened* and *Evidence* sections. Localizing them means localizing the
dashboard, which is a separate decision (there is no i18n layer in the app today); the option of translating just the
ticket's copy of them through the configured model exists but is not built. Jira-side names — issue types, priorities,
statuses, transitions — are whatever the site's administrator named them, in whatever language: Piwi always addresses
them by id, never by an English name, so a French-configured site works unchanged.

## Other trackers that fall out

Each is a provider folder and a registry entry; the UI, the actions, the policies and the docs page's structure are
shared.

| Provider | Credential | Create | Rich text | Notes |
|---|---|---|---|---|
| GitHub Issues | the SCM token already stored | `POST /repos/:o/:r/issues` | Markdown | `GitHubProvider.fetchIssue` exists; add create/comment/close. Closes the loop for teams that live in GitHub |
| GitLab Issues | the SCM token | `POST /projects/:id/issues` | Markdown | Same as above via `GitLabProvider` |
| Linear | API key | GraphQL `issueCreate` | Markdown | Team = Linear team id; states via `workflowStates` |
| Azure DevOps Boards | PAT | `POST …/_apis/wit/workitems/$Bug` (JSON patch) | HTML | The document model needs an HTML renderer — the Confluence one minus macros |
| YouTrack | permanent token | `POST /api/issues` | Markdown | Project short name |

`link-detect.ts` already names `linear`, `notion`, `slack`; the registry keeps those as link-only providers
(detect and unfurl, no create) until someone writes the client.

## Storage and API

**Tables** (both dialects, generated migrations): `integration_connections`, `project_integrations`,
`integration_actions`; `entity_links` + `connection_id`, `external_id`, `origin`; optional `teams` / `team_members`
(Tier 3). Every FK to a project cascades; connection deletion sets links' `connection_id` to null and leaves the URLs.

**Endpoints** (all under `/api/integrations/`, every one with `defineRouteMeta` and `x-required-roles`):

| Route | Role | Purpose |
|---|---|---|
| `GET/POST connections`, `GET/PATCH/DELETE connections/:id`, `POST connections/:id/test` | admin | Manage and verify connections; never return credentials |
| `GET connections/:id/projects`, `…/projects/:key/issue-types`, `…/assignable?project=&q=`, `…/spaces` | admin | Pickers for the binding and the modal (proxied, cached 5 min) |
| `GET/PUT projects/:id/integrations` | admin | The binding(s) for a project |
| `GET issue-draft?entityType=&entityId=` | reporter+ | The prefilled draft plus dedupe candidates |
| `POST issues` | reporter+ | Enqueue `create-issue`; body = the draft with edits; returns `{ actionId, key?, url? }` |
| `POST issues/:linkId/comment` | reporter+ | A manual comment (the same body builder, free text on top) |
| `POST pages` | reporter+ | Publish to Confluence |
| `GET actions?projectId=&status=` | member | The activity list |
| `POST jira/webhook/:token` | public | Refresh one link (Tier 2) |

**MCP tools**: `create_issue`, `comment_on_issue`, `publish_page`; `get_fix_plan` and `get_cluster` gain
`issue`. The docs-drift test's tool count moves with them.

**Env vars** (all `since` the shipping release): `PIWI_JIRA_BASE_URL`, `PIWI_JIRA_EMAIL`, `PIWI_JIRA_API_TOKEN`,
`PIWI_CONFLUENCE_BASE_URL`, `PIWI_CONFLUENCE_EMAIL`, `PIWI_CONFLUENCE_API_TOKEN`, `PIWI_INTEGRATIONS_SYNC_MINUTES`.

**Commit scope**: the new area is the `app` scope for the server and UI (`feat(app): …`), `db` for schema-only
commits, `docs(docs)` for the site; no new commitlint scope is needed.

## UI

- **Settings → Integrations** (new page in `SETTINGS_PAGES`, group *Instance*, admin): one card per provider from the
  registry with its connections, a *Connect* form generated from `credentialFields`, a *Test* button with the
  resolved account and last error, an env-managed badge when the connection comes from the environment, and the last
  50 actions. `HELP_TOPICS` entries for the page, the connection form and the private-host note.
- **Project → Integrations tab** (admin): the binding form — connection, Jira project, issue type, labels, defaults,
  include toggles, policies, owner routes (a small table: owner → project / component / assignee), and for Confluence
  the space and parent page.
- **`CreateIssueModal`** as described; **`IssueChip`** is `LinkChip` with the tracker icon and status color, unchanged
  where it already renders.
- **The activity list** reuses the table conventions (`UTable` slots, mobile card list) and `ErrorText` for provider
  errors.
- Everything follows the typography rules: one primary action per screen — *Create issue* takes it only while the
  cluster has no ticket.

## Demo and desktop

Integrations are server-only, like AI and SCM. The demo ships one canned Jira connection so the docs screenshots and
the modal can be seen: `app/demo/api/integrations.ts` answers the draft with real seeded facts and *creates* `DEMO-<n>`
keys in the in-browser DB, never calling out. The desktop app runs the same server, so a desktop user connects their
Jira the same way; the settings page hides nothing there.

## Documentation and tests

- **Docs**: `apps/docs/features/issue-tracking.md` (Jira, then the other trackers, following the auto-heal page's
  skeleton — what it does exactly, requirements, enable it, limits), `apps/docs/features/confluence.md`, an
  *Integrations* entry under *Use it from elsewhere*, an *Operate → Integrations* page for connections and the
  private-host policy, the generated configuration reference for the env vars, and the `mcp.md` tool table.
- **Unit** (Vitest): every renderer against fixture documents (ADF snapshots checked against the schema's node
  list), every builder against seeded facts, the Jira client with `vi.stubGlobal('fetch')` as `scm-unfurl.test.ts`
  does, dedupe candidate ranking, the policy guards, the backoff helper, `detectProviderWithConnection`.
- **E2E** (Playwright): a mock Jira HTTP server in `tests/utils/` (the `ai-diagnosis.spec.ts` mock-provider pattern)
  driving create → chip → sync → comment → close → cluster prompt; a mock Confluence for publish; role checks; the
  env-managed connection; the MCP tool. Project names registered in `shared/test-project-names.ts`.
- **Screens**: scenes for the settings page, the binding tab, the modal and the chip (`take-feature-screenshots.mjs`).

## Alternatives considered

- **A tracker as a notification channel.** Add `type: 'tracker'` to `notification_channels` and let subscriptions
  (events, project scope, branch and owner filters, digest mode) decide when an issue is created. It reuses the most
  UI and is genuinely elegant for *routing*; it was set aside because creation needs dedupe against existing links,
  a rich per-project configuration (project key, issue type, routes) that does not fit a channel's config, and a
  manual path that subscriptions have no concept of. The binding policy follows auto-heal instead. The idea can still
  be layered later: a subscription filter is a fine *additional* gate.
- **Store the issue on the cluster** (`failure_clusters.issue_key`). Simpler for one tracker and one entity; wrong
  as soon as an execution, a flaky test or a run wants a ticket, or a cluster has a Jira issue and a Confluence
  post-mortem. Entity links already model exactly that.
- **Outbound webhook only** ("use Zapier / n8n"). The webhook channel already exists and stays; it cannot dedupe,
  cannot read status back, and pushes the body-building — the part with the value — onto the user.
- **An Atlassian Connect / Forge app.** Would give signed webhooks, OAuth and a Jira-side panel, at the cost of a
  hosted app registration for a self-hosted product. Basic auth with an API token is what every Jira admin can hand
  out today; OAuth 2.0 (3LO) can be added as a second credential type on the connection without touching anything
  above the client.
- **One `integrations` JSON setting** instead of tables. Fine for one connection; a table is needed the moment there
  are two Jira sites, a per-project binding, and actions to list.
- **Markdown everywhere, converted per target.** Jira Cloud only accepts ADF for v3 descriptions and comments; a
  Markdown-to-ADF converter would drag in a parser and still miss tables. A small neutral tree rendered per target is
  less code and fully testable.

## Open questions

Each with the default the design assumes; a different answer changes the first milestone.

1. **Jira flavor first** — *settled: Cloud only* (decision 1).
2. **Teams** — *settled: owner routes on the project binding* (decision 2).
3. **How automatic** — *settled: manual creation and sync first; the binding form carries the auto-create fields
   disabled by default, the trigger lands in step 4* (decision 3).
4. **What the ticket carries by default.** Diagnosis and patch on; screenshot attachment off (Jira attachment
   permissions vary); share link off unless `PIWI_SHARE_LINKS_ENABLED`. Right defaults?
5. **Where the connection lives.** Env vars for one instance-wide connection *and* DB-managed connections for several,
   or DB only? *Default: both, as every other secret-bearing setting.*
6. **Private hosts.** Trust administrator-supplied base URLs unconditionally, or require an explicit
   `PIWI_INTEGRATIONS_ALLOW_PRIVATE_HOSTS=true` for RFC 1918 targets? *Default: trust admins; document it.*
7. **GitHub / GitLab Issues** — *settled: Jira alone first* (decision 4).
8. **Confluence scope.** Investigation report only, or also the run report and the living digest page? *Default:
   investigation and run report; the digest waits for teams.*
9. **Assignee mapping.** Search assignable users live in the modal (Jira Cloud may hide emails), remember the pick per
   owner on the binding, or ask each Piwi user to store their Jira account id in *Account settings*? *Default: live
   search with remembered routes; a per-user field can follow.*

## Rollout sketch

Each step is a separately mergeable pull request that leaves the app green and useful on its own.

1. **Foundations** — ✅ *shipped.* `integration_connections` + Settings → Integrations (Jira Cloud connect, test, env-managed),
   the provider registry and `IssueTracker` interface with the Jira client (`whoAmI`, `getIssue`, `parseIssueUrl`),
   `entity_links` columns, connection-aware detection and refresh, retire the `atlassian` setting. *Outcome: the
   unfurl that has never worked works, self-hosted Jira links are recognized, nothing writes to Jira yet.*
2. **Create an issue** — ✅ *shipped.* The document model with Markdown and ADF renderers, `buildClusterIssue` /
   `buildExecutionIssue`, the outbox and sweeper, `POST issues` + `issue-draft` with dedupe, the modal on the cluster
   page and the inbox (`c`, bulk), the key on the chip, Slack/email and PR feedback, `create_issue` MCP tool, docs
   page. *Outcome: the headline feature.*
3. **Keep it honest** — ✅ *shipped.* The sync task, the binding form with policies (comment on fix / regression, transition,
   resolve on close), merge handling, the optional webhook, `needs-ticket` queue, and the response-language setting.
   *Outcome: the loop closes both ways.*
4. **Teams and automation** — owner routes, auto-create guards, daily cap ✅ *shipped* (as rules: see
   `shared/integrations/automation.ts`); flaky-test and run tickets; the `relatedIssue` and annotation resolutions if
   not already in step 2.
5. **Confluence** — the wiki interface, the storage renderer, publish investigation and run report, page-in-place
   updates.
6. **The next trackers** — GitHub Issues and GitLab Issues on the SCM token; Jira Data Center; Linear.
