---
title: Issue tracking (Jira)
description: "File a Jira issue from a failure with the fix plan as its body, keep it linked as the cluster's known issue, and keep its status in sync."
lang: en-US
---

# Issue tracking (Jira)

<Needs reporter admin />

An investigation ends with what a ticket needs: a headline, the affected tests and owners, the diagnosis, a
validated patch, the verify command. **Create issue** makes it a Jira issue: the body is the fix plan, the issue
is linked back as the cluster's *known issue*, and the key travels wherever the failure appears.

It is **off until an [administrator connects Jira](/operate/integrations#connecting-jira-cloud)**.

<div class="doc-screenshot">
  <img src="/screenshots/create-issue-modal.png" alt="The Create issue modal on a failure cluster: an editable title, the Jira project and issue-type fields, include toggles, and a preview of the fix-plan body">
</div>

## What it does, exactly

- **Create issue** appears on a failure cluster, on a failing execution, on each inbox row (plus the `c` key and a
  *Create issues* button in the inbox bulk bar), and on a [bug report](./bug-reports#filing-it-in-jira). The cluster's
  **Issue** line and an execution's **Cluster** line offer *Create issue* and *Link an issue* until the cluster has a
  ticket, then name it, its summary on hover; the ⋮ menu offers *Open PROJ-123*.
- The issue **body is the fix plan**, rendered to Atlassian Document Format: *What happened*, *Most likely*, *Evidence*,
  *What to do* (patch, locator replacement, verify command, reproduce steps), *Related issues* fixed before and *Links*
  back to Piwi. Every section degrades independently.
- Each issue carries the labels `piwi`, `piwi-cluster-<id>` and `piwi-fp-<hash>` and a `Piwi-Cluster: <id>` trailer
  for JQL.
- **Filing is deduped by cluster** — a second click, a duplicate event, a [rule](./issue-automation) or a create from
  another of its executions names the issue already filed; once that link is removed or the issue is Done, the next create files a new one, and a
  Done issue stays linked. Before creating, the modal surfaces any issue that already tracks the failure (a pinned
  link, a matching label, or a *fixed-before* match) and leads with *link it instead*.
- Creating an issue is a **durable outbox action**: attempted immediately, retried with backoff if Jira is down (the
  cluster and execution pages show *Filing queued*, with a retry), and recorded: the cluster's **Activity** lists each
  write Piwi makes to the issue. A create Jira refuses outright (a missing or invalid field) fails at once, with
  Jira's reason atop the modal and on the Issue or Cluster line; creating again replaces it.

## The key travels

A cluster's **known issue** is its most recently linked ticket; earlier ones stay among its links, which an execution's
*Details* also lists. Its key follows the failure everywhere:

- the cluster's **Issue** line and a failing execution's **Cluster** line, the **inbox row** and the execution's row in
  the **run's test list** show the key with its status; the **search** (Ctrl K) finds the cluster from the key;
- `cluster.new`, `cluster.fixed` and `cluster.regressed` **Slack** messages name it, as does the `cluster.new` email;
- the **pull-request feedback** comment says *tracked in PROJ-123* on each failure whose cluster has one;
- the **fix plan** lists it under *Links*, and the `get_cluster` / `get_fix_plan` MCP tools return it.

<div class="doc-screenshot">
  <img src="/screenshots/cluster-issue-line.png" alt="A failure cluster's situation block with its Issue line naming the Jira issue the cluster is tracked in">
</div>

## Keep the ticket honest

Once a cluster carries a known issue, Piwi keeps the two in step. A background sync
([`PIWI_INTEGRATIONS_SYNC_MINUTES`](/reference/configuration), default 15 min) reads each tracked issue back and caches
its status, title and assignee (open clusters every sweep, resolved ones daily). Per-project **policies**, all **off by
default**, each a durable deduped outbox action, write back as the cluster evolves:

| When Piwi observes | What Piwi does |
|---|---|
| A cluster's **fix lands** (stopped failing or diagnosis verified) | Comments *Fix landed in run #N …*, and with *transition on fix* moves the issue. |
| A cluster **regresses** | Comments *Regressed in run #N …*, and optionally reopens the issue. |
| **New occurrences** on an open ticket | At most one note a day or a week: *Still failing — +N occurrences in 3 runs …*, with what is new. |
| A cluster is **merged** | With *comment on merge*, notes it on both issues; the survivor inherits the links. |
| The **ticket moves to Done** | With *resolve on close*, resolves the cluster unless its fix regressed. Otherwise, once the latest finished run no longer fails and the fix did not regress, the next step is *Mark the cluster resolved — PROJ-123 is Done*; while it fails, the Issue or Cluster line offers *File a new issue*. |
| The **ticket is reopened** | With *reopen on ticket reopen*, reopens a resolved cluster with a note. |

Both status policies act on a **move** of the ticket, so a cluster a person reopened or resolved stays as they set it.

Every comment is written in the [ticket's language](#language), for the [runs that
write](./issue-automation#the-runs-that-write); [Issue automation](./issue-automation) adds diagnosis comments and
description updates. A Jira admin can register an optional
[inbound webhook](/operate/integrations#registering-the-inbound-webhook) so a close or reopen shows at once; it only
refreshes a link. The failure inbox gains a **Needs ticket** queue — open clusters on
the default branch, older than the binding's age (default 2 days), with no issue.

## The project binding

A Project admin or an administrator binds the project under **Project → Settings → Issue tracker**: the connection, Jira project and issue
type, default labels and assignee, the [ticket language](#language), what a ticket carries, the policies above, and
**owner routes** — mapping a cluster's owner (`@acme/checkout`, an email) to a Jira project, component, assignee and
labels. The create-issue draft picks the first matching route.

<div class="doc-screenshot">
  <img src="/screenshots/project-integration-binding.png" alt="The project's Issue tracker settings: connection, Jira project and issue type, labels, the runs that write to the ticket, sync-policy switches, an owner-routes table, and automatic creation with one rule">
</div>

## Required Jira fields

Piwi reads the issue type's create screen and asks for every required field Jira does not fill, such as a
*Severity* or a *Team*:

- The project binding's **Jira fields** block lists them; a value set there fills every issue filed from the project.
- The create modal shows them under **Required by Jira**, prefilled from those defaults, and keeps *Create* disabled
  until each has a value. A search in both adds any other field, custom ones included. A field pointing at an
  issue, such as the *Parent*, searches Jira; a team is typed as its id.
- The [`create_issue` MCP tool](/reference/mcp-tools#create_issue) refuses early, naming each missing field, its id and
  what it takes; an agent passes them in `fields`.

Transitions are checked the same way: for *transition on fix* and the reopen transition, the binding suggests the
transitions an issue offers and asks for their required fields, such as a *Resolution*; a move that would leave one
empty fails at once, naming it. A requirement no screen shows, such as a workflow validator, comes back as Jira's
refusal naming the field, which the modal then asks for.

<div class="doc-screenshot">
  <img src="/screenshots/create-issue-required-fields.png" alt="The Create issue modal with a Required by Jira block: Severity prefilled with Major from the project settings, an empty Team field, and the footer saying Jira still needs Team">
</div>

## Requirements

- A connected **Jira Cloud** site — see [Operate → Integrations](/operate/integrations#connecting-jira-cloud).
- **`PIWI_SITE_URL`** set, so the issue body's links resolve back to the dashboard.
- The **Contributor** [role](/operate/project-access#what-each-role-can-do) or above to create or link an issue; anyone
  who reads the project sees the key and status.

## Enable it

The modal prefills its fields from the [project binding](#the-project-binding), else offers pickers over the
connected site; toggles choose what the body carries (diagnosis and patch on, [share link](/features/share-links) off).
A share link needs the **Maintainer** role and is created when the issue is filed.
From an AI agent, the [`create_issue` MCP tool](/reference/mcp-tools#create_issue) files the same ticket once the
binding names a Jira project and issue type.

## Language

A ticket's language follows its **destination**: the **project binding**'s language, else the **connection**'s default
(a French Atlassian site can default every ticket to French), else **English**. The create modal offers a per-issue *Language* select and the `create_issue` MCP tool takes a
`locale`. **English and French ship.**

Only the copy **Piwi authors** is translated: headings, fact labels, policy comments, dates and counts. Your data
(test titles, errors, locators, paths, commands, the patch) is **never** translated. The model's
prose follows the separate [AI response-language setting](/features/ai-diagnosis#response-language), so a French ticket's
*Most likely* section reads in French too.

## Limits

- **Jira Cloud only** (REST v3, email + API token).
- A ticket's body is a **snapshot** at creation, unless [description updates](./issue-automation#comments-and-description-updates)
  are on for an issue Piwi filed.
- The dashboard's deterministic sentences (headline, story, clue, state line) are **English templates**, so they
  stay English even in a French ticket.
- Attachments honor the [export size budget](/features/offline-export); the trace is never attached.

## Try it in the demo

<DemoExamples />

## Related

- [Issue automation](./issue-automation): tickets filed by rule
- [Failure clusters & the inbox](./failure-clusters): what a ticket tracks
