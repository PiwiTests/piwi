# Credential manager

**Status.** Proposed and confirmed 2026-11-16. Step 1 of the [Delivery](#delivery) is built: the store, the log,
Settings → Credentials, the credential of each CI server action, the environment's CI server credential and the import
of the project CI server tokens. It replaces D6 of [ci-actions.md](../adr/ci-actions.md) (one CI server token per
project); D7 stands, as the environment credential's input list. Steps 2 and 3 remain.

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

Confirmed with the maintainer on 2026-11-16; [Answered questions](#answered-questions) records the choices.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **A credential is an instance-level record**: a unique name, a service, an optional user name, a secret, a **destination** (the base URL it may be sent under), a scope (all projects, or a list) and a state (active or disabled). Consumers store its id, never a copy of the secret.                                                                                                                                                                                                                                                                                                                                              |
| D2  | **The secret is write-only.** No API answer, MCP tool, export, page or log holds it, whole or in part. Changing the destination requires entering the secret again, as a CI server token is saved with its URL today.                                                                                                                                                                                                                                                                                                                                                                                                                |
| D3  | **Every use goes through one function, `withCredential`**, which checks the state, the project's scope, the destination of the request and the Custom request rule, records the use, opens the secret for that one request and settles the row with its outcome. No other code reads the secret column: `tests/unit/credential-secret-access.test.ts` fails on any other.                                                                                                                                                                                                                                                            |
| D4  | **Refusals are recorded like uses.** A send refused because the project is out of scope, the URL is outside the destination or the credential is disabled is a log row with its reason, and the consumer's error names the credential and the reason, never the secret.                                                                                                                                                                                                                                                                                                                                                              |
| D5  | **Who manages what.** `credentials:manage`, a new instance permission held by Administrators, creates, rotates, disables, deletes and widens the scope of any credential. A Project admin creates credentials shared with the projects they manage, changes the ones they created while shared only with those projects, and picks any credential shared with them. A credential an administrator saved stays theirs, so a project admin never loosens its rules (allowing a Custom request would let them reach a CI server's script console with the administrator's token).                                                       |
| D6  | **A use that changes something outside Piwi is one log row** (a dispatch, a comment, an issue, a commit status, a message); **a read is counted** in one row per credential, feature, project and hour. SCM history reads run on every ingest and would otherwise fill the log.                                                                                                                                                                                                                                                                                                                                                      |
| D7  | **The log is kept 365 days**, pruned by the nightly sweep (`PIWI_CREDENTIAL_LOG_DAYS`), with no route that deletes or edits a row. A deleted credential keeps its log rows, which name it.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D8  | **A credential set by environment variables is a read-only credential** (`managed_by: 'env'`), as the env-managed connections are: `PIWI_CI_SERVER_TOKEN` first, then the Jira, Zephyr Scale and AI variables. Its uses are logged like any other.                                                                                                                                                                                                                                                                                                                                                                                   |
| D9  | **Stored secrets are imported once, at startup, and deduplicated.** Each project CI server token and SCM token becomes a credential scoped to its project; secrets equal in value and destination become one credential shared with each of their projects. The consumers then hold its id, and the old column is emptied.                                                                                                                                                                                                                                                                                                           |
| D10 | **A CI action names its credential.** A CI server action holds `credentialId`, which lifts the one-token-per-project limit (ci-actions D6); its base URL defaults to the credential's destination and its user name is the credential's, so the action repeats neither. A GitHub, GitLab or Bitbucket action may hold one too (step 2), else it uses the project's SCM credential. An action without a credential sends the instance's (D8) under its URL. `ciServerToken`, `hasCiServerToken` and `ciServerTokenUrl` leave the project API (`BREAKING CHANGE`): a project no longer has one CI server token for a write to replace. |
| D11 | **The input rule of the instance credential becomes a field of every CI server credential**: `allowedInputs`, the inputs a request carrying it may send (null for every input). The env-managed credential reads `PIWI_CI_SERVER_ALLOWED_INPUTS`; an imported project token gets null, as it sends every input today.                                                                                                                                                                                                                                                                                                                |
| D12 | **A Custom request carries a credential only when the credential allows it** (`customRequests`, off by default). A Custom request reaches any path under the destination, a CI server's script console included, so whoever manages the credential decides. An imported project token allows it, as it went with a Custom request before; the env-managed credential never does.                                                                                                                                                                                                                                                     |

## Design

### 1. The record

`CredentialSummary` (`shared/credentials.ts`) is what the API answers, never with the secret: `id`, `name` (unique,
ignoring case), `description`, `service` (`ci-server` in step 1), `user`, `destination` (the normalized base URL),
`scope` (`{ allProjects: true }` or `{ allProjects: false, projectIds }`), `allowedInputs` (null for every input),
`customRequests` (D12), `disabled`, `managedBy` (`db` or `env`), `createdAt`, `rotatedAt`, `lastUsedAt`, `usedBy` (the
CI actions that name it) and `canManage`.

Tables, in both schemas:

- `credentials`: the record, the secret in `secret` (sealed `{ destination, secret }`, so a row edited in the
  database to another destination does not open), `created_by` for D5.
- `credential_projects`: `(credential_id, project_id)`, deleted with either side.
- `credential_uses`: `credential_id` (set null on delete) and `credential_name`, `feature` (`ci-dispatch`,
  `ci-check`), `project_id`, `user_id`, `api_key_id`, `subject_type` and `subject_id` (the CI action), `destination`
  (origin and path, never the query), `result` (`sent`, `ok`, `failed`, `refused`), `reason`, `count`, `created_at`,
  `last_at`.

The service decides which pickers list a credential; it never widens what the destination allows.

### 2. Using a credential

`withCredential(db, use, send, failure?)` (`server/utils/credentials.ts`) takes the credential's id, the feature, the
project, the URL, whether the request is a Custom one, the actor (user and API key) and the subject. It reads the
credential afresh, so a disable or a scope change applies to the next use, and refuses in a fixed order: disabled, not
shared with the project, URL outside the destination, a Custom request it does not allow (`credentialRefusal`,
`shared/credentials.ts`). A refusal is a log row and a `CredentialRefusedError`; `send` is never called. Otherwise a use
that changes something outside Piwi is written as `sent`, the secret is opened for `send` alone, and the row is settled
`ok` or `failed`; a read is added to the row of its credential, feature, project, result and hour. A failure's text is
masked (the secret, its Basic pairs and its URL encoding) before it is stored or thrown.

A CI server request plans its credential without the secret (`ciServerCredential`, `prepareCiServerRequest`), then
`withCredential` builds it again with the secret inside `send`. The transport rules stay: `safeFetch`'s public-address
check and the private-host rule of `PIWI_CI_SERVER_HOSTS`, and no redirect is followed.

### 3. Pages and routes

- **Settings → Credentials** (`credentials:manage`): the list (name, user, projects, the actions that name it,
  destination, last use), and a panel per credential with its fields, **Used by**, **Edit or rotate**, **Disable**,
  **Delete** and its log (**Activity**, filtered by result). Delete is refused while a CI action names the credential,
  and names them.
- **The CI action editor**: a credential picker listing the ones shared with the project, **New credential** inline
  (shared with the project), and the request preview naming the credential it carries or saying it would refuse.
- Routes: `GET/POST /api/credentials` (`?projectId=` lists a project's picker), `GET/PATCH/DELETE /api/credentials/:id`,
  `GET /api/credentials/:id/uses`. No MCP tool lists or uses a credential directly; the MCP tool that starts a dispatch
  goes through `withCredential` like the buttons, and its API key is the actor.
- The demo seeds two credentials and a log, with no secret.

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

| Threat                                                                                       | What stops it                                                                                       |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A Project admin aims a shared credential at a server they own (a CI action's base URL)       | The destination check at send (D3); changing the destination needs the secret (D2)                  |
| A Project admin uses a credential not shared with their project, by id through the API       | The scope check at send, not only in the picker; the refusal is logged (D4)                         |
| The secret leaks through an answer, an export, a log or an error from the remote side        | Write-only (D2); the secret and its Basic encoding are masked in any stored or shown error text     |
| A database dump                                                                              | AES-256-GCM under `PIWI_SECRET_KEY`; this table refuses a value without the `v1:` prefix            |
| A row edited in the database to another destination                                          | The destination is sealed with the secret and compared when it opens                                |
| Project inputs steer a job through a credential the operator shared                          | `allowedInputs` on the credential (D11)                                                             |
| A Project admin loosens the rules of an administrator's credential shared with their project | Only its creator or `credentials:manage` changes it (D5)                                            |
| A Custom request reaches a CI server's script console with a shared credential               | `customRequests`, off by default (D12)                                                              |
| A misuse goes unnoticed                                                                      | The log, with refusals (D4, D6); **Disable** stops every use at once while the incident is examined |

## Delivery

1. **The store and the CI actions.** The tables and migrations, `withCredential`, the log and its sweep,
   `credentials:manage`, the routes, Settings → Credentials, the CI action picker, the import of the project CI
   server tokens (D9), the env-managed CI server credential (D8), the demo, the docs (`operate/credentials.md`, the
   CI re-run page), the configuration reference. Supersedes D6 of [ci-actions.md](../adr/ci-actions.md), recorded
   when this proposal moves to `adr/`.
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

## Answered questions

Answered by the maintainer on 2026-11-16.

1. **The repetition is the CI actions'.** Each CI server action names a base URL and a user, and the project's one token
   applies to one base URL: D10 moves both into the credential the action picks.
2. **Reads are counted by the hour** (D6).
3. **The log is kept 365 days** (D7), with its own variable.
4. **A Project admin creates credentials scoped to their projects** (D5).
