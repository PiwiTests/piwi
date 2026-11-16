# Credential manager

**Status.** Proposed 2026-11-16, nothing built. The decisions below are recommendations to confirm with the
maintainer; [Open questions](#open-questions) lists the ones that change the design.

**Summary.** Piwi stores the secrets it sends to other services in six places, each with its own copy, its own rules and
no record of its use: a project's SCM token, the instance's SCM token, a project's CI server token, the integration
connections (Jira, Zephyr Scale), the notification channels (a Slack bot token, a webhook signing secret) and the AI
keys. A team with ten projects on one Jenkins pastes the same token ten times, rotates it ten times, and cannot tell
which project started which build with it. This proposal adds a **credential manager**: a **credential** is a named
secret saved once on the instance, bound to the one base URL it may be sent to, shared with the projects allowed to use
it, and referenced by id wherever a secret is needed. Every use goes through one server function, which checks the
credential's scope and destination at the moment of sending and records the use (which credential, which feature,
which project, who started it, where it went, the result). The first consumer is the CI actions; the SCM tokens, the
connections, the channels and the AI keys follow.

## Problem

- **A secret is copied, not shared.** `projects.ci_server_token` and `projects.scm_token` hold one copy per project.
  The same Jenkins or GitHub token is pasted in each project, and a rotation is a visit to each project; a project
  forgotten keeps failing, or keeps an old token alive.
- **One CI server token per project.** A project's CI server token is bound to one base URL
  ([ci-actions.md](../adr/ci-actions.md), D6), so a project whose actions start builds on two CI servers can give a
  credential to one of them only. The save answers 400 when the actions use two base URLs.
- **One SCM token does everything.** The project's SCM token reads the history, posts the pull-request feedback, sets
  the commit status and starts a workflow (`createScmProvider`, `resolveScmToken`). It needs every scope, so a token
  meant to start one workflow can also write comments, and the reverse.
- **No record of use.** Nothing records that a credential was sent: a dispatch keeps its target and its id
  (`failure_clusters.last_rerun_dispatch`), not the credential it carried, nor who asked. An operator who rotates a
  token after an incident cannot list what used it. A refused send (wrong host, private address) leaves a log line at
  best.
- **Each consumer re-implements the rules.** The destination binding (sealed `{ url, token }`), the private-host rule,
  the env-managed variant and the "never returned" rule are written for the CI server token; the SCM token has the host
  allow-list instead; the channels and the AI keys have neither.

## What exists

| Secret                        | Where it is stored                                                                      | Who saves it                              | Rules it follows                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Project SCM token             | `projects.scm_token`, encrypted                                                         | `project:manage`                          | Reads only the pinned repository; GitLab only on listed hosts (`PIWI_SCM_GITLAB_HOSTS`) |
| Instance SCM token            | `app_settings.scm_token`, encrypted                                                     | `settings:manage`                         | Fallback of `resolveScmToken` for every project                                         |
| Project CI server token       | `projects.ci_server_token`, sealed `{ url, token }` (`sealCiServerToken`)               | `project:manage`                          | Sent only under its URL (`credentialFor`); one per project (ci-actions D6)              |
| Instance CI server credential | `PIWI_CI_SERVER_URL`, `PIWI_CI_SERVER_USER`, `PIWI_CI_SERVER_TOKEN`                     | The operator                              | Preset requests only; sends only `PIWI_CI_SERVER_ALLOWED_INPUTS` (ci-actions D7)        |
| Integration connections       | `integration_connections.credentials`, encrypted JSON; `managed_by: 'env'` for env vars | `connections:manage`                      | Instance-level, named, bound to projects through `project_integrations`                 |
| Notification channels         | `notification_channels.config`: webhook `secret`, Slack `token`, encrypted              | Any signed-in user, for their own channel | Never returned                                                                          |
| AI keys                       | The per-role `apiKey` of the AI settings (`server/api/settings/ai.put.ts`), encrypted   | `settings:manage`                         | Env-managed alternative overrides                                                       |

All of them go through `encryptSecret` / `decryptSecret` (`server/utils/crypto.ts`): AES-256-GCM, key derived from
`PIWI_SECRET_KEY`, a save answering 409 without it. `decryptSecret` returns a value without the `v1:` prefix as
plaintext, for values stored before encryption. The integration connections are the closest existing shape: named,
instance-level, checked, env-managed or saved. The S3 and SMTP secrets are the operator's infrastructure, set by
environment variables only, and stay out of this plan.

## Decisions

Proposed 2026-11-16; to confirm.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **A credential is an instance-level record**: a unique name, a service, an optional user name, a secret, a **destination** (the base URL it may be sent under), a scope (all projects, or a list) and a state (active or disabled). Consumers store its id, never a copy of the secret.                                                                  |
| D2  | **The secret is write-only.** No API answer, MCP tool, export, page or log holds it, whole or in part. Changing the destination requires entering the secret again, as a CI server token is saved with its URL today.                                                                                                                                    |
| D3  | **Every use goes through one function, `useCredential`**, which checks the state, the project's scope and the destination of the request, then records the use. No other code decrypts a credential: a unit test fails on any other read of the secret column.                                                                                           |
| D4  | **Refusals are recorded like uses.** A send refused because the project is out of scope, the URL is outside the destination or the credential is disabled is a log row with its reason, and the consumer's error names the credential and the reason, never the secret.                                                                                  |
| D5  | **Who manages what.** `credentials:manage`, a new instance permission held by Administrators, creates, rotates, disables, deletes and widens the scope of any credential. A Project admin creates credentials scoped to the projects they manage and picks any credential shared with them; they never widen a scope.                                    |
| D6  | **A use that changes something outside Piwi is one log row** (a dispatch, a comment, an issue, a commit status, a message); **a read is counted** in one row per credential, feature, project and hour. SCM history reads run on every ingest and would otherwise fill the log.                                                                          |
| D7  | **The log is kept 365 days**, pruned by the nightly sweep (`PIWI_CREDENTIAL_LOG_DAYS`), with no route that deletes or edits a row. A deleted credential keeps its log rows, which name it.                                                                                                                                                               |
| D8  | **A credential set by environment variables is a read-only credential** (`managed_by: 'env'`), as the env-managed connections are: `PIWI_CI_SERVER_TOKEN` first, then the Jira, Zephyr Scale and AI variables. Its uses are logged like any other.                                                                                                       |
| D9  | **Stored secrets are imported once, at startup, and deduplicated.** Each project CI server token and SCM token becomes a credential scoped to its project; secrets equal in value and destination become one credential shared with each of their projects. The consumers then hold its id, and the old column is emptied.                               |
| D10 | **A CI action names its credential.** A CI server action holds `credentialId`, which lifts the one-token-per-project limit (ci-actions D6); a GitHub, GitLab or Bitbucket action may hold one too, else it uses the project's SCM credential. `ciServerToken` on `PATCH /api/projects/:id` stays as a shortcut that writes the project's own credential. |
| D11 | **The input rule of the instance credential becomes a field of every CI server credential**: `allowedInputs`, the inputs a request carrying it may send (null for every input). The env-managed credential reads `PIWI_CI_SERVER_ALLOWED_INPUTS`; an imported project token gets null, as it sends every input today.                                    |

## Design

### 1. The record

```ts
type CredentialService =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "ci-server"
  | "jira"
  | "zephyr-scale"
  | "slack"
  | "webhook"
  | "ai";

interface CredentialSummary {
  id: number;
  name: string; // unique on the instance, ignoring case
  description: string | null;
  service: CredentialService;
  /** The user name a Basic credential pairs with the secret; not secret, shown. */
  user: string | null;
  /** The base URL the secret may be sent under: normalized origin and path prefix, no query. */
  destination: string;
  scope: { allProjects: true } | { allProjects: false; projectIds: number[] };
  /** CI server only: the inputs a request carrying this credential may send; null for every input. */
  allowedInputs: string[] | null;
  state: "active" | "disabled";
  managedBy: "db" | "env";
  createdBy: number | null;
  createdAt: string;
  /** When the secret was last replaced. */
  rotatedAt: string;
  lastUsedAt: string | null;
  /** What references it: the CI actions, projects, connections, channels and AI roles, by name. */
  usedBy: CredentialReference[];
}
```

Tables, in both schemas:

- `credentials`: the record, the secret in `secret` (sealed `{ destination, secret }`, so a row edited in the
  database to another destination does not open).
- `credential_projects`: `(credential_id, project_id)`, deleted with either side.
- `credential_uses`: `credential_id` (set null on delete) and `credential_name`, `feature` (`ci-dispatch`, `ci-check`,
  `scm-read`, `scm-write`, `jira`, `zephyr`, `slack`, `webhook`, `ai`), `project_id`, `user_id`, `api_key_id`,
  `subject_type` and `subject_id` (the CI action and the dispatch id, the cluster, the channel), `destination` (origin and
  path, never the query), `result` (`ok`, `failed`, `refused`), `reason`, `count`, `created_at`.

The service decides which pickers list a credential (a CI server action lists `ci-server` credentials) and which check
**Check** runs; it never widens what the destination allows.

### 2. Using a credential

```ts
/** The secret, for one send to `url`, after the checks; records the use. Throws a `CredentialRefused` with the reason. */
async function useCredential(
  db: DbClient,
  input: {
    credentialId: number;
    feature: CredentialFeature;
    projectId: number | null;
    url: string;
    actor: { userId: number | null; apiKeyId: number | null } | "system";
    subject?: { type: string; id: string | number };
  },
): Promise<{
  user: string | null;
  secret: string;
  allowedInputs: string[] | null;
  done: (result: UseResult) => Promise<void>;
}>;
```

The order is fixed: the credential exists and is active; the project is in its scope (a project of a credential shared
with all projects always is); `url` is under its destination (`isUnderBaseUrl`, the function `credentialFor` uses
today); then the secret is opened and the use is written as started. The consumer calls `done` with the outcome of its
request, which completes the row. A send keeps the transport rules it has today: `safeFetch` and the private-host rule
of `PIWI_CI_SERVER_HOSTS` for a CI server, the pinned repository and `PIWI_SCM_GITLAB_HOSTS` for SCM. A redirect to a
URL outside the destination is not followed with the credential.

Before an error text from the remote side is stored or shown (a connection's `last_error`, a dispatch's message), every
occurrence of the secret and of its Basic encoding is replaced by `****`.

### 3. Pages and routes

- **Settings → Credentials** (`credentials:manage`): the list (name, service, destination, scope, state, last used),
  and a page per credential with its references (**Used by**), its log (**Activity**, filterable by project, feature
  and result) and **Check**, **Rotate**, **Disable**, **Delete**. Delete is refused while something references the
  credential, and names the references.
- **Pickers**: the CI action form, the project's SCM field, the connection form, the channel form and the AI settings
  each pick a credential of their service, with **New credential** inline (scoped to the project for a Project admin).
- Routes: `GET/POST /api/credentials`, `GET/PATCH/DELETE /api/credentials/:id`, `POST /api/credentials/:id/check`,
  `GET /api/credentials/:id/uses`. A Project admin's `GET /api/credentials?projectId=` lists the credentials in that
  project's scope, without their scope or log. No MCP tool lists or uses a credential directly; the MCP tools that
  start a dispatch go through `useCredential` like the buttons, and their API key is the actor.
- The demo seeds three credentials and their activity, with no secret.

### 4. Consumers, in delivery order

| Consumer                         | Holds                                   | Replaces                                           |
| -------------------------------- | --------------------------------------- | -------------------------------------------------- |
| CI server action                 | `target.credentialId`                   | `projects.ci_server_token`, `ciServerTokenBinding` |
| GitHub, GitLab, Bitbucket action | `target.credentialId`, optional         | The SCM token, for the dispatch only               |
| Project SCM                      | `projects.scm_credential_id`            | `projects.scm_token`                               |
| Instance SCM                     | The `scm_credential` app setting        | `app_settings.scm_token`                           |
| Jira, Zephyr Scale connection    | `integration_connections.credential_id` | `integration_connections.credentials`              |
| Slack and webhook channel        | `credentialId` in the channel's config  | The encrypted `token` and `secret`                 |
| AI role                          | `credentialId` in the role              | The encrypted `apiKey`                             |

## Security

| Threat                                                                                 | What stops it                                                                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A Project admin aims a shared credential at a server they own (a CI action's base URL) | The destination check at send (D3); changing the destination needs the secret (D2)                  |
| A Project admin uses a credential not shared with their project, by id through the API | The scope check at send, not only in the picker; the refusal is logged (D4)                         |
| The secret leaks through an answer, an export, a log or an error from the remote side  | Write-only (D2); the secret and its Basic encoding are masked in any stored or shown error text     |
| A database dump                                                                        | AES-256-GCM under `PIWI_SECRET_KEY`; this table refuses a value without the `v1:` prefix            |
| A row edited in the database to another destination                                    | The destination is sealed with the secret and compared when it opens                                |
| Project inputs steer a job through a credential the operator shared                    | `allowedInputs` on the credential (D11)                                                             |
| A misuse goes unnoticed                                                                | The log, with refusals (D4, D6); **Disable** stops every use at once while the incident is examined |

## Delivery

1. **The store and the CI actions.** The tables and migrations, `useCredential`, the log and its sweep,
   `credentials:manage`, the routes, Settings → Credentials, the CI action picker, the import of the project CI
   server tokens (D9), the env-managed CI server credential (D8), the demo, the docs (`operate/credentials.md`, the
   CI re-run page), the configuration reference. Supersedes D6 and D7 of [ci-actions.md](../adr/ci-actions.md) with a
   new ADR when it ships.
2. **SCM.** The project and instance SCM credentials, a credential per repository-host CI action, the import of both
   SCM tokens.
3. **Connections, channels and AI keys.** Their credentials move to the store, env-managed ones included.

## Not in this plan

- **External secret managers** (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault). `managed_by` leaves room for
  a third source that resolves the secret at use; the log and the checks stay the same.
- **Rotating `PIWI_SECRET_KEY`.** No secret can be re-encrypted under a new key today. One table makes a re-encryption
  command simple, as a separate change.
- **The secrets of the team's CI jobs** (`PIWI_API_KEY` in each workflow): Piwi does not hold them. Trusting the CI's
  OIDC token at upload, so a job needs no Piwi secret, is a separate proposal.
- **The S3 and SMTP secrets**, which stay environment variables.

## Open questions

1. **Is the repetition the one this plan removes?** It reads "repeated in each job" as each project and each CI action
   needing its own copy of the CI server or SCM token. If it means the secrets each CI job's YAML must carry to reach
   Piwi, the answer is the OIDC proposal of [Not in this plan](#not-in-this-plan), not this one.
2. **One log row per read, or reads counted by the hour** (D6)?
3. **Log retention**: 365 days (D7), or follow `PIWI_RETENTION_DAYS`?
4. **May a Project admin create a credential scoped to their project** (D5)? Refusing it takes away what they can do
   today, saving their project's tokens.
