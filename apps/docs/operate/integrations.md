---
title: Integrations
description: "Connect Jira Cloud to the dashboard: the token and permissions it needs, trusted hosts, status sync and the inbound webhook."
lang: en-US
---

# Integrations

Connect an issue tracker and the external links you pin to a run, execution or failure cluster stop being
dead URLs: Piwi fetches the ticket's title and status through the connection and keeps the badge current
when you refresh. Jira Cloud is the supported tracker. This page sets up the connection; filing and syncing
issues from a failure is [Issue tracking (Jira)](/features/issue-tracking).

A connection is instance infrastructure — one row per external system, managed by an administrator, shared
by every project. Nothing is sent to Jira until a connection exists, and credentials are encrypted at rest
with `PIWI_SECRET_KEY`.

<div class="doc-screenshot">
  <img src="/screenshots/integrations-settings.png" alt="Settings → Integrations: a Jira card with a connected system, its verified status, and a test-connection button">
</div>

## Connecting Jira Cloud

Jira Cloud authenticates with an account email and an API token (REST v3, HTTP Basic). **Settings → Integrations →
Connect Jira** (administrator only) walks through it:

1. **Jira site**: paste the address of any Jira page, or type the site name. Piwi reads the site from it
   (`https://your-team.atlassian.net`) and checks it is Jira Cloud.
2. **API token type**: classic or scoped. The form links to
   [Atlassian's API tokens page](https://id.atlassian.com/manage-profile/security/api-tokens), where you sign in as
   the account Piwi should act as, and lists the scopes a scoped token needs.
3. **Account email** and **API token**, plus the token's expiry date if you want a warning two weeks before it.
4. **Check sign-in** calls `GET /rest/api/3/myself` without saving and shows the account, the token kind and the
   projects the account sees, or what to fix. Then **Connect**.

<div class="doc-screenshot">
  <img src="/screenshots/jira-connect-form.png" alt="The Jira connect form: a pasted board URL read down to the site, the scoped-token steps and a passed sign-in check">
</div>

Once connected, a Jira link — `https://your-team.atlassian.net/browse/PROJ-123`, including a self-hosted
host once its connection exists — is recognized as a Jira issue, unfurls with the summary and a status
badge (colored by the issue's status category), and refreshes through the connection.

## Permissions the token needs

An API token, used over HTTP Basic (`email:apiToken`), acts within the permissions of the **account** it belongs to.
So what matters is the Jira permissions of that account, granted **per project** in Jira's permission scheme, on every
project you bind to a Piwi project. Both a **classic** and a **scoped** token work, see
[Classic or scoped token](#classic-or-scoped-token) for the difference.

**Test connection** (`GET /rest/api/3/myself`) needs only a valid token. Every other call maps to one standard
Jira project permission:

| Atlassian permission | Permission key | What it enables in Piwi |
|---|---|---|
| Browse Projects | `BROWSE_PROJECTS` | Unfurl a link, sync a tracked issue's status, title and assignee, list projects and issue types in the pickers, and search (JQL) to dedupe before filing. Prerequisite for everything below. |
| Create Issues | `CREATE_ISSUES` | **Create issue** from a failure cluster. |
| Add Comments | `ADD_COMMENTS` | The write-back policies (fix landed, regressed, still failing, merged). |
| Transition Issues | `TRANSITION_ISSUES` | The *transition on fix* and *reopen* policies. |
| Edit Issues | `EDIT_ISSUES` | [Description updates](/features/issue-automation#comments-and-description-updates). |
| Assign Issues | `ASSIGN_ISSUES` | Set the assignee on a created issue, and list assignable users in the picker. |
| Create Attachments | `CREATE_ATTACHMENTS` | Attach a bug report's screenshots to the issue filed from it. |

For the **full integration**, grant all seven on each bound project. You can drop the ones whose feature you do not
use: `CREATE_ATTACHMENTS` without bug reports, `ASSIGN_ISSUES` without assignees, `ADD_COMMENTS`, `TRANSITION_ISSUES`
and `EDIT_ISSUES` while the [write-back policies](/features/issue-tracking#keep-the-ticket-honest) stay off.
`BROWSE_PROJECTS` on its own is enough for read-only unfurl and status sync.

The assignable-user picker (`GET /rest/api/3/user/assignable/search`) is satisfied by `ASSIGN_ISSUES` on the
project, or by the **Browse users and groups** global permission (`USER_PICKER`).

The [inbound webhook](#registering-the-inbound-webhook) does **not** use this token. A Jira admin registers it in
Jira, and it can only ever refresh a link, so it needs no permission from the Piwi account.

### Classic or scoped token

Both work. A **classic** token authenticates directly against your site (`https://your-team.atlassian.net`). A
**scoped** ("granular") token authenticates only through Atlassian's `https://api.atlassian.com/ex/jira/{cloudId}`
gateway, so Piwi detects that on the first `401`, resolves your site's cloud id from its public `_edge/tenant_info`
endpoint, and routes REST calls through the gateway from then on, with no extra configuration (browse links and link
detection keep using the site URL). The resolved cloud id is stored on the connection once a sign-in check or
**Test connection** finds a scoped token.

A scoped token must additionally carry the scopes **`read:jira-work`** (unfurl, sync, search, the pickers),
**`write:jira-work`** (create, comment, transition, attach) and **`read:jira-user`** (the account check and the
assignable-user picker), on top of the account permissions above.

## Environment-managed vs dashboard-managed

A connection can live in either place:

- **Dashboard-managed** — added on the Integrations page. Editable there; the credential is encrypted in
  the database and never returned by any endpoint. Saving with the token field left blank keeps the stored
  token.
- **Environment-managed** — created from the environment at startup when `PIWI_JIRA_BASE_URL`,
  `PIWI_JIRA_EMAIL` and `PIWI_JIRA_API_TOKEN` are all set. It shows a lock badge and is read-only in the
  dashboard: change it by editing the environment and restarting. The token stays in the environment and
  never enters the database. Without `PIWI_SECRET_KEY` the connect form cannot store a token, so it says so and
  shows these variables filled in from what you typed.

See the [configuration reference](/reference/configuration#integrations) for the variables.

## Trusted base URLs and private hosts

A connection base URL is supplied by an administrator, so Piwi trusts it: a private host such as
`https://jira.internal.example.com` or an RFC 1918 address is reachable without extra configuration. The client speaks
Jira Cloud's REST v3 only. A URL a non-administrator supplies (a pinned link) goes through the SSRF guard that blocks
private hosts. Moving a connection to another site drops its stored credentials.

## Creating issues from a failure

Once a connection exists, Piwi can **file the ticket for you** — a Jira issue whose body is the failure's fix plan,
linked back as the cluster's known issue. See [Issue tracking (Jira)](/features/issue-tracking) for the create flow,
the fields, and how the key travels back into the inbox, notifications and pull-request comments.

A connection carries a **default language** for the tickets filed against it (a French Atlassian site can default them
to French); a project binding overrides it, and the create modal offers a per-issue choice — see
[Language](/features/issue-tracking#language).

## Who can do what

With [authentication](./authentication) on, connections are administrator-only. Binding a project to Jira takes the
Project admin role on that project (`project:manage`), or an administrator. Filing an issue takes the
[Contributor role](./project-access#what-each-role-can-do) or above on the project (`issue:create`).

## Status sync

A background task reads every tracked issue back through its connection and caches the status, title and assignee, so a
closed ticket stops showing as open in the dashboard. It runs **every 15 minutes by default**; set
[`PIWI_INTEGRATIONS_SYNC_MINUTES`](/reference/configuration) (1–1440) to change the cadence; a value of 60 or more is
rounded to whole hours. Each sweep refreshes up to 100 links. Links on an open cluster refresh every sweep; links on
a resolved or ignored cluster refresh at most once a day. A connection that fails to
answer records the error on the connection card and does not stop the sweep. An administrator can run one sweep on
demand through the REST API (see the [API docs](https://piwitests.dev/demo/docs)); the response counts the links it refreshed, failed and skipped.

The two-way **policies** (comment on fix / regression, transition, resolve on close, reopen) are configured per project
on the binding — see [Keep the ticket honest](/features/issue-tracking#keep-the-ticket-honest).

## Registering the inbound webhook

Polling is the baseline because Atlassian Cloud usually cannot reach a self-hosted Piwi. When it can, a Jira admin can
register a webhook so a close or reopen reflects immediately instead of within the sync interval:

1. In **Settings → Integrations**, on the Jira connection, choose **Enable webhook**. Piwi generates a per-connection
   secret, keeps only its digest, and shows the full URL **once**, with a link to the site's webhooks page. Set
   `PIWI_SITE_URL` when Piwi sits behind another address than the one in your browser.
2. In Jira, go to **Settings → System → Webhooks → Create a webhook**, paste the URL, and subscribe it to
   **issue updated** events (optionally scoped by a JQL filter to the bound projects).
3. Piwi looks the issue up by its id in its links and refreshes just that one, applying the resolve/reopen policies.

The webhook is **public but secret-in-path** and rate-limited, and it can only ever *refresh a link* — it can never
create or transition anything. **Regenerate webhook** invalidates the old URL; turning the webhook off is an
administrator call in the REST API (see the [API docs](https://piwitests.dev/demo/docs)).

## Related

- [Issue tracking (Jira)](/features/issue-tracking): filing issues from a failure and keeping them in sync
- [Production checklist](./production-checklist): `PIWI_SECRET_KEY`, which encrypts the stored token
- [Configuration reference](/reference/configuration): the integration variables
