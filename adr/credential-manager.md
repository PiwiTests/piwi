# Credential manager

- Status: accepted
- Date: 2026-11-16

**Status.** Proposed and confirmed 2026-11-16, and built in full. Step 1: the store, the log, Settings → Credentials,
the credential of each CI server action, the environment's CI server credential and the import of the project CI
server tokens, and a secret read from a server variable (D13). Step 2: the SCM credentials of the projects, of the
instance and of the repository-host CI actions, with the import of both SCM tokens (D14 to D17). Step 3: the AI keys
(D18), the Jira and Zephyr Scale connections (D19) and the Slack channels of the instance (D20), each with its import
(D21), and the question a deleted connection or channel asks about its credential (D22). It replaces D6 of [ci-actions.md](ci-actions.md) (one CI server token per project); D7 stands, as the
environment credential's input list.

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
  ([ci-actions.md](ci-actions.md), D6), so a project whose actions start builds on two CI servers can give a
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

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **A credential is an instance-level record**: a unique name, a service, an optional user name, a secret, a **destination** (the base URL it may be sent under), a scope (all projects, or a list) and a state (active or disabled). Consumers store its id, never a copy of the secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D2  | **The secret is write-only.** No API answer, MCP tool, export, page or log holds it, whole or in part. Changing the destination requires entering the secret again, as a CI server token is saved with its URL today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D3  | **Every use goes through one function, `withCredential`**, which checks the state, the project's scope, the destination of the request and the Custom request rule, records the use, opens the secret for that one request and settles the row with its outcome. No other code reads the secret column: `tests/unit/credential-secret-access.test.ts` fails on any other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D4  | **Refusals are recorded like uses.** A send refused because the project is out of scope, the URL is outside the destination or the credential is disabled is a log row with its reason, and the consumer's error names the credential and the reason, never the secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D5  | **Who manages what.** `credentials:manage`, a new instance permission held by Administrators, creates, rotates, disables, deletes and widens the scope of any credential. A Project admin opens Settings → Credentials too, creates credentials shared with the projects they manage, changes the ones they created while shared only with those projects and reading no variable, and picks any credential shared with them. A change by an administrator makes a credential theirs, so a project admin never loosens what an administrator set (allowing a Custom request would reach a CI server's script console with the administrator's token) or undoes a Disable.                                                                                                                                                                                                                                                 |
| D6  | **A use that changes something outside Piwi is one log row** (a dispatch, a comment, an issue, a commit status, a message); **a read is counted** in one row per credential, feature, project and hour. SCM history reads run on every ingest and would otherwise fill the log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D7  | **The log is kept 365 days**, pruned by the nightly sweep (`PIWI_RETENTION_CREDENTIAL_LOG_DAYS`), with no route that deletes or edits a row. A deleted credential keeps its log rows, which name it, in the page's **Log** of every credential.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D8  | **A credential set by environment variables is a read-only credential** (`managed_by: 'env'`), as the env-managed connections are: `PIWI_CI_SERVER_TOKEN` first, then the Jira, Zephyr Scale and AI variables. Its uses are logged like any other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D9  | **Stored secrets are imported once, at startup, and deduplicated.** Each project CI server token becomes a credential scoped to its project, one per user name the actions it served paired with it; tokens equal in value, destination and user become one credential shared with each of their projects. The actions hold its id, an administrator manages it (the database does not say who saved the token), and the old column is emptied. A token that cannot be opened stays, with a warning at each start.                                                                                                                                                                                                                                                                                                                                                                                                        |
| D10 | **A CI action names its credential.** A CI server action holds `credentialId`, which lifts the one-token-per-project limit (ci-actions D6); its base URL defaults to the credential's destination and its user name is the credential's, so the action repeats neither. A GitHub, GitLab or Bitbucket action may hold one too (step 2), else it uses the project's SCM credential. An action without a credential sends the instance's (D8) under its URL. `ciServerToken`, `hasCiServerToken` and `ciServerTokenUrl` leave the project API (`BREAKING CHANGE`): a project no longer has one CI server token for a write to replace.                                                                                                                                                                                                                                                                                      |
| D11 | **The input rule of the instance credential becomes a field of every CI server credential**: `allowedInputs`, the inputs a request carrying it may send (null for every input). The env-managed credential reads `PIWI_CI_SERVER_ALLOWED_INPUTS`; an imported project token gets null, as it sends every input today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D12 | **A Custom request carries a credential only when the credential allows it** (`customRequests`, off by default). A Custom request reaches any path under the destination, a CI server's script console included, so whoever manages the credential decides. An imported project token allows it, as it went with a Custom request before; the env-managed credential never does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D13 | **A secret may be read from a server variable** named `PIWI_CREDENTIAL_*` (`secretEnv`), at each use, instead of being saved. Only `credentials:manage` names one, and only that prefix, so no other variable of the server (`PIWI_SECRET_KEY`, a database URL) can be sent; the name is sealed with the destination like a saved secret. Added on 2026-11-16 at the maintainer's request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D14 | **An SCM credential is sent to its host's API** (service `scm`): its destination is the API of GitHub (`https://api.github.com/`), Bitbucket (`https://api.bitbucket.org/`), the GitLab cloud (`https://gitlab.com/`) or a GitLab host of `PIWI_SCM_GITLAB_HOSTS`, or a path under one that narrows it (`https://api.github.com/repos/acme/`, one owner's repositories). A call's repository API URL must lie under it. The token goes as a bearer token, with no user name.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D15 | **Which credential a repository call carries**: the CI action's, for its dispatch and its Check, when it names one; else the project's (`projects.scm_credential_id`); else the instance SCM credential whose destination holds the repository's API URL, the narrowest first (the `scm_credentials` app setting, a list, since one token serves one host, all shared with all projects); else none, and the call reads the repository as a public one. A refused credential is logged, and the call goes on without it, except a dispatch and the Check of an action that names its own, which are refused.                                                                                                                                                                                                                                                                                                              |
| D16 | **A provider opens its credential once, and logs each write.** Opening a credential for a repository's reads is one counted `scm-read` (D6). Each write (a pull-request comment, a commit status, a heal branch, commit or pull request, a dispatch) goes through `withCredential` again, as one row naming its pull request, commit, branch or CI action, so a Disable stops the next write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D17 | **Both SCM tokens are imported** (D9's rules): a project token becomes a credential bound to the API of the project's repository and shared with it, and waits while the project has no repository or one on an unlisted GitLab host; the instance token becomes one credential per API it could reach (GitHub's, Bitbucket's, the GitLab cloud's and each listed GitLab host's), shared with all projects and listed as the instance's, so no project loses it and no run's metadata picks its destination. Each token moves in a transaction that first takes it from where it was. `scmToken` leaves the project and AI settings APIs (`BREAKING CHANGE`); `hasScmToken` stays, true while a credential is set.                                                                                                                                                                                                        |
| D18 | **An AI key is a credential of the `ai` service**, sent to its provider's endpoint: Anthropic's API, or the base URL of an OpenAI-compatible role, which must lie under the destination. A role of Settings → AI names `credentialId`: its form keeps the key field, and a key typed there creates the role's credential or rotates the one it names, bound to the role's endpoint; the form can also pick a saved one. `reuse` still points at another role. The key is opened only by a call to the model: resolving the configuration for a status or a form never opens it. The calls of one diagnosis, assistant turn or batch of embeddings are one counted `ai-call` read; a refused key fails the call with the credential's reason. Each `PIWI_AI_*_API_KEY` set is a read-only credential of the environment. Confirmed on 2026-11-16: the form keeps its key field. |
| D19 | **A Jira or Zephyr Scale connection names a credential** (`integration_connections.credential_id`, services `jira` and `zephyr-scale`): the Jira e-mail is its user, the API token its secret, and its destination the Jira site or the Zephyr Scale region's API. The connection form keeps its token fields: a token typed there creates the connection's credential or rotates it, and the form can also pick a saved one; **Check** signs in with it before anything is saved. Every request of the tracker client goes through `withCredential`: opening one for a client is a counted read (`integration-read`; Jira's search and bulk read are reads too), and each write (an issue, a comment, a transition, an attachment, a link, a results upload) a row of its own (`integration-write`). `PIWI_JIRA_*` and `PIWI_ZEPHYR_*` become read-only credentials of the environment, as `PIWI_CI_SERVER_*` did. Confirmed on 2026-11-16: the forms keep their key fields.    |
| D20 | **An instance channel's Slack bot token is a credential** (`slack`, sent to `https://slack.com/api/`), named by the channel, and each message sent with it is a log row (`notification`). A personal channel keeps its own token: its owner holds no right on the instance's credentials, and nobody else may use it. A webhook channel's signing secret stays with its channel: it signs the body and is never sent, so it has no destination to bind. Confirmed on 2026-11-16: a personal channel keeps its token.                                                                                                                                                                                                                                                                                                                                                                 |
| D21 | **The stored keys and tokens of step 3 are imported at startup** (D9's rules): each AI role key to a credential bound to its endpoint and named by the role, each connection's token to one of its own, bound to its site or region and named by the connection, each instance Slack channel's token to one named by the channel; equal AI keys or Slack tokens for the same destination share one credential. The old fields stay, emptied once their secret has moved.                                                                                                                                                                                                                                                                                                                                                                                   |
| D22 | **Deleting a connection or a channel asks what becomes of its credential**: delete it too, or keep it under Settings → Credentials. It is deleted only when it is saved in the database and nothing else names it (`deleteCredentialIfUnused`); a channel's, only by an administrator. Added on 2026-11-17 at the maintainer's request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Design

### 1. The record

`CredentialSummary` (`shared/credentials.ts`) is what the API answers, never with the secret: `id`, `name` (unique,
ignoring case), `description`, `service` (`ci-server`, `scm` for a repository host, `ai`, `jira`, `zephyr-scale` or `slack`), `user`, `destination` (the normalized base URL),
`scope` (`{ allProjects: true }` or `{ allProjects: false, projectIds }`), `allowedInputs` (null for every input),
`customRequests` (D12), `secretEnv` and `secretEnvSet` (D13), `disabled`, `managedBy` (`db` or `env`), `createdAt`, `rotatedAt`, `lastUsedAt`, `usedBy` (what names it: CI actions, a project's or the instance's source control, AI roles, Jira and Zephyr Scale connections, Slack channels of the instance) and `canManage`.

Tables, in both schemas:

- `credentials`: the record, the secret in `secret` (sealed `{ destination, secret }`, or `{ destination, env }` for a
  secret read from a variable, so a row edited in the database to another destination or variable does not open),
  `secret_env` for D13, `created_by` for D5.
- `credential_projects`: `(credential_id, project_id)`, deleted with either side.
- `credential_uses`: `credential_id` (set null on delete) and `credential_name`, `feature` (`ci-dispatch`,
  `ci-check`, `scm-read`, `scm-comment`, `scm-status`, `scm-pull-request`, `ai-call`, `integration-read`,
  `integration-write`, `notification`), `project_id`, `user_id`, `api_key_id`, `subject_type` and `subject_id` (the CI action, the pull request, the commit or the branch), `destination`
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

An SCM provider is opened for one repository (`openScmProvider`, `server/utils/scm/index.ts`): it picks the
credential (D15), and `withCredential` opens it as one counted read, building the provider inside `send`; the provider
holds the secret while it lives. Each write method of `ScmProvider` (`postPullRequestComment`, `postCommitStatus`,
`createBranch`, `commitFiles`, `createPullRequest`, `dispatchRerun`) is a wrapper of the base class that runs the
provider's `do…` hook through `write`, inside `withCredential` again with the write's feature and subject. A refused open leaves the provider without a token:
a public repository still reads.

### 3. Pages and routes

- **Settings → Credentials** (`credentials:manage`, and a Project admin for the credentials they manage): the list
  (name, user, projects, the actions that name it, destination, last use), a panel per credential with its fields,
  **Used by**, **Edit or rotate**, **Disable**, **Delete** and its log (**Activity**, filtered by result), and, for an
  administrator, the **Log** of every credential, deleted ones included. Delete is refused while something names the credential (a CI action, a project's or the instance's source control, an AI role, a connection, a Slack channel of the instance), and names them.
- **The CI action editor**: a credential picker listing the ones shared with the project, **New credential** inline
  (shared with the project), and the request preview naming the credential it carries or saying it would refuse.
- **Source control**: the project's **Credential** in its Source control settings, the instance's **SCM
  credentials** in Settings → Source control (credentials shared with all projects), and a GitHub, GitLab or
  Bitbucket action's **Credential**, each with **New credential** inline.
- Routes: `GET/POST /api/credentials` (`?projectId=` lists a project's picker), `GET/PATCH/DELETE /api/credentials/:id`,
  `GET /api/credentials/:id/uses`, `GET /api/credentials/uses` (every credential's log). No MCP tool lists or uses a credential directly; the MCP tool that starts a dispatch
  goes through `withCredential` like the buttons, and its API key is the actor.
- The demo seeds five credentials (two CI server, two GitHub, the Zephyr Scale connection's) and a log, with no secret.

### 4. Consumers, in delivery order

| Consumer                         | Holds                                   | Replaces                                           |
| -------------------------------- | --------------------------------------- | -------------------------------------------------- |
| CI server action                 | `target.credentialId`                   | `projects.ci_server_token`, `ciServerTokenBinding` |
| GitHub, GitLab, Bitbucket action | `target.credentialId`, optional         | The SCM token, for the dispatch only               |
| Project SCM                      | `projects.scm_credential_id`            | `projects.scm_token`                               |
| Instance SCM                     | The `scm_credentials` app setting       | `app_settings.scm_token`                           |
| Jira, Zephyr Scale connection    | `integration_connections.credential_id` | `integration_connections.credentials`              |
| Slack channel of the instance    | `credentialId` in the channel's config  | The encrypted `token`                              |
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
| A Project admin probes other credentials through Check, by id                                | A posted action's credential is checked as a save checks it, one answer for missing and not shared  |
| A token sent to another host than the one it was made for (a project's repository moved)     | The destination check against the repository's API URL at each open (D14)                           |
| A token meant for one workflow dispatch also posting comments and statuses                   | A repository-host CI action names its own credential (D15)                                          |
| A misuse goes unnoticed                                                                      | The log, with refusals (D4, D6); **Disable** stops every use at once while the incident is examined |

## Delivery

1. **The store and the CI actions.** The tables and migrations, `withCredential`, the log and its sweep,
   `credentials:manage`, the routes, Settings → Credentials, the CI action picker, the import of the project CI
   server tokens (D9), the env-managed CI server credential (D8), the demo, the docs (`operate/credentials.md`, the
   CI re-run page), the configuration reference. Supersedes D6 of [ci-actions.md](ci-actions.md).
2. **SCM.** The project and instance SCM credentials, a credential per repository-host CI action, the import of both
   SCM tokens (D14 to D17), the pickers in a project's Source control settings, Settings → Source control and the CI
   action editor, the demo and the docs.
3. **Connections, channels and AI keys.** Their credentials move to the store, env-managed ones included (D18 to
   D21), in three parts: the AI keys, the Jira and Zephyr Scale connections, the instance Slack channels.

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
5. **The forms of step 3 keep their key fields** (D18, D19): a key typed in Settings → AI or a connection form creates
   or rotates the credential behind it, and the form can pick a saved one instead.
6. **A personal channel keeps its own Slack token** (D20); only instance channels' tokens move to credentials.
