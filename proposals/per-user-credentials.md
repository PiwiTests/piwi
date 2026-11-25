# Per-user credentials

**Status.** Proposed on 2026-11-25, nothing built. It extends [credential-manager.md](../adr/credential-manager.md):
the store, `withCredential`, the destination binding and the log stand as that record wrote them.

**Summary.** Every credential is a **shared credential** today: one secret, saved once, sent by every person who
presses a button that names it. A run on CI started from Piwi therefore runs on the CI server in the name of the
account that owns the secret (a service account, `piwi[bot]`), whoever pressed the button, and the CI server applies
that account's rights, not the person's. This proposal adds a **per-user credential**: an administrator configures it
once (the service, the destination, the projects), like any credential, but it holds no secret of its own. Each person
who uses it gives their own secret for it, a **user token**, once, from the run dialog or their account, and tests it
there. A dispatch through it then carries the token of the person who started it, so the CI server shows their name
("Started by user alice") and applies their rights.

## Problem

- **The CI server never knows who asked.** Piwi records who pressed the button (`ci_dispatches.by_user_id`,
  `by_name`), but the request carries the shared secret: Jenkins shows the service account as the user who started the
  build, GitHub the token's owner as the actor who ran the workflow.
- **Piwi's permission stands in for the CI's.** Whoever holds `run:control` on a project starts any job its actions
  name, with the rights of the shared secret, including a job their own CI account may not build.
- **The audit trail stops at Piwi.** The credential log names the Piwi user, the CI server's own log names the service
  account; the two have to be matched by time.
- **A credential per person does not scale.** Each person creating their own credential means as many credentials,
  each to be shared with the right projects, and an action names one credential, so it cannot pick the presser's.

## What exists

- **A credential** (`credentials`, `shared/credentials.ts`): name, service, optional user name, a secret sealed with
  its destination, scope, `allowedInputs`, `customRequests`, `disabled`. `withCredential`
  (`server/utils/credentials.ts`) is the one function that opens a secret; `credential_uses` already records the Piwi
  user (`user_id`) and the API key of each use.
- **A CI action names its credential** (`target.credentialId`), for its dispatch and its Check
  (credential-manager D10, D15). Every dispatch and every Check is started by a person or an API key: nothing
  dispatches on its own.
- **Sign-in with OAuth** (`server/utils/oauth.ts`): Google and GitHub, scopes `read:user user:email`; the access token
  is read for the profile and dropped. Its helpers (`generateState`, `generateCodeVerifier`, `codeChallengeS256`,
  `buildRedirectUri` in `oauth-helpers.ts`) serve any authorization code flow.
- **Account page** (`app/pages/settings/account.vue`): Connected accounts (sign-in providers), Connected apps (MCP
  clients), API keys.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **A credential is shared or per-user** (`per_user`), set at creation and never changed. A per-user credential has every field of a shared one (name, service, destination, scope, `allowedInputs`, state, log) except the secret: each person gives their own user token. Its services are `ci-server` and `scm`.                                                                                       |
| D2  | **Only a CI action names a per-user credential**, for its dispatch and its Check. The project's and the instance's SCM credential, the AI roles, the Jira and Zephyr Scale connections and the Slack channels refuse one with 400: their uses (ingest reads, pull-request feedback, notifications) have no person behind them.                                                                          |
| D3  | **Only `credentials:manage` creates, changes or deletes a per-user credential.** It collects other people's secrets, so its destination is one an administrator chose. A Project admin picks one for their actions as they pick any credential shared with their projects (credential-manager D5).                                                                                                      |
| D4  | **How a person gives their user token follows the service.** A CI server (Jenkins has no OAuth server): their user name and API token, in a form. GitHub, GitLab, Bitbucket: an OAuth authorization, the credential holding the OAuth application's client id and client secret (the client secret sealed with the destination, as any credential's secret).                                            |
| D5  | **A user token is saved only after a test** that answers who the service says the person is: Jenkins `whoAmI/api/json` (refused when `anonymous`), GitHub `GET /user`, GitLab `GET /api/v4/user`, Bitbucket `GET /2.0/user`. The name is kept as the token's `remoteUser`. **Test** runs it again at any time; each test is a counted read in the log (feature `credential-test`).                      |
| D6  | **`withCredential` opens the token of the use's actor**: the signed-in person, or the owner of the API key the request came through. No token, an expired one or no person is a refusal with code `user-token-required`, naming the credential, logged like any refusal. A request never carries another person's token, and a per-user credential never falls back to a shared one.                    |
| D7  | **The run dialog asks before it sends.** `GET /api/projects/:id/ci-actions/offered` adds `userToken` to each action (`ready`, `missing`, `expired`, null for a shared credential); for `missing` or `expired` the dialog shows the form or the authorization button, with Test, then dispatches. The refused dispatch of D6 is the backstop, for the API and MCP.                                       |
| D8  | **Account → Credentials** lists the per-user credentials the person can use (shared with a project where they hold `run:control`), each with its state (not authorized, authorized as `alice.martin` on a date, expired, last test failed) and **Authorize**, **Test**, **Remove**. Remove deletes the token and, for OAuth, revokes it at the host when the host offers revocation.                    |
| D9  | **An administrator sees who authorized, never a token.** The credential's panel lists its user tokens (Piwi user, remote user, created, last test and its result, last use) and removes one or all. **Disable** stops every token at once. Changing the destination or the OAuth application deletes every user token, since each was sealed with them, and each person is asked again.                 |
| D10 | **A user token is sealed with its credential, its person and the destination** (`{ credentialId, userId, destination, user, secret }`, or the access token, refresh token and expiry for OAuth), in `credential_user_tokens`, one row per credential and person, deleted with either. A row copied to another person or credential does not open. `credential-secret-access.test.ts` covers its column. |
| D11 | **An OAuth token is refreshed before it expires, one refresh at a time**: the row's `version` is compared and swapped, so two dispatches never spend the same refresh token (GitLab issues a new one at each refresh). A refused refresh (`invalid_grant`) marks the token expired, and the person is asked to authorize again.                                                                         |
| D12 | **The log names the remote user** (`credential_uses.remote_user`) beside the Piwi user, so a row reads "alice (Jenkins: alice.martin)".                                                                                                                                                                                                                                                                 |
| D13 | **A per-user credential never goes with a Custom request** (`customRequests` is false and cannot be set). A Custom request's template is a Project admin's: it would send any person's token to a path they chose, a CI server's script console included. `allowedInputs` applies as on a shared credential.                                                                                            |
| D14 | **Without sign-in, there is no per-user credential.** An instance with authentication off has one virtual user: the form does not offer the choice, and a save answers 400.                                                                                                                                                                                                                             |

## Design

### 1. The record

- `credentials.per_user` (boolean, default false). On a per-user credential, `secret` is null for the token method
  and holds the OAuth client secret for the OAuth method; `oauth_client_id` holds the client id; `user` is null (each
  person gives their own); `token_help_url` is an optional link to the page where a person creates their token (for
  Jenkins, their user's Security page).
- `credential_user_tokens`: `id`, `credential_id` (cascade), `user_id` (cascade), `remote_user`, `secret` (sealed, D10),
  `expires_at` (OAuth), `version`, `created_at`, `tested_at`, `test_ok`, `test_detail`, `last_used_at`; unique on
  `(credential_id, user_id)`. Both schemas, with their migrations.
- `credential_uses.remote_user` (D12).
- `CredentialSummary` adds `perUser`, `userTokens` (how many people authorized) and, for the caller, `myToken`
  (`{ state, remoteUser, testedAt }`), never a secret.

### 2. Using it

`withCredential` runs the existing checks in their order (disabled, scope, destination, Custom request), then, for a
per-user credential, loads the actor's row: none, expired, or no person (an instance credential use, a call with no
user) is a `CredentialRefusedError` with `code: 'user-token-required'`. Otherwise it opens the token, refreshes it
first when it expires within a minute (D11), and calls `send` with it. The CI server request builds its Basic header
from the token's user and secret, as it does from a shared credential's. An SCM provider opened for a dispatch or a
Check with a per-user credential holds the person's token for that one write.

The dispatch route answers the refusal as 403 with `data.code` and `data.credential` (`{ id, name }`); the run dialog
opens the authorization step on it. An MCP dispatch answers the same refusal as text telling the person to authorize
the credential in Piwi: no MCP tool takes a secret.

### 3. Giving a user token

- **Token method**: the form shows the credential's name, its destination in full and who created it ("Your token is
  sent only to `https://ci.example.com/`"), the user name (prefilled with the Piwi user name) and the API token, with
  **Test and save**. The route tests first (D5) and saves only on success, keeping the service's answer for a failure.
- **OAuth method**: **Authorize** redirects to the host with `state` and PKCE where the host supports it, the redirect
  URI being `{PIWI_SITE_URL}/api/credentials/:id/authorize/callback`; the credential's form shows that URI to register
  with the OAuth application. The callback exchanges the code, tests, saves and returns to the page that started it.
  - **GitHub**: the GitHub App of [#1560](https://github.com/PiwiTests/piwi/issues/1560), its permission **Actions:
    write**, installed on the repositories the actions dispatch to. One app serves both kinds of credential: its
    installation tokens the shared uses, in the app's `[bot]` name (#1560), its user access tokens the per-user ones,
    in the person's name, limited to the repositories both the installation and the person reach. Piwi asks for no
    scope, since an OAuth App would need `repo`, which reaches every private repository of the person. The token lasts
    8 hours and refreshes for 6 months.
  - **GitLab**: an OAuth application with the `api` scope, the only one that creates a pipeline; one application per
    host, each host listed in `PIWI_SCM_GITLAB_HOSTS`. The token lasts 2 hours.
  - **Bitbucket**: an OAuth consumer with `pipeline:write`.

### 4. Pages and routes

- **Settings → Credentials**: the create form offers **Shared** or **Per user** (D1, D3, D14); a per-user credential's
  panel lists its user tokens (D9) and shows the administrator's own token with Authorize and Test.
- **Account → Credentials** (D8), and the authorization step of the run dialog (D7), share one component.
- **The CI action editor**: the credential picker marks a per-user credential; Check runs with the token of whoever
  presses it and, without one, offers to authorize.
- Routes: `GET /api/credentials/mine` (the per-user credentials the caller can use, with their token's state),
  `PUT /api/credentials/:id/token` (test and save, token method), `POST /api/credentials/:id/token/test`,
  `DELETE /api/credentials/:id/token`, `GET /api/credentials/:id/authorize` and `.../authorize/callback` (OAuth),
  `GET /api/credentials/:id/tokens` and `DELETE /api/credentials/:id/tokens/:userId` (`credentials:manage`).
- The demo seeds a per-user Jenkins credential with two user tokens, the demo user's among them, and its log.

## Security

| Threat                                                                                      | What stops it                                                                                            |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A Project admin creates a per-user credential aimed at a server they own, to collect tokens | Only `credentials:manage` creates or changes one (D3); the form shows the destination in full            |
| A Project admin's Custom request sends a person's token to a CI server's script console     | A per-user credential never goes with a Custom request (D13)                                             |
| A request carries another person's token                                                    | The token is the actor's (D6), and sealed with the person's id (D10)                                     |
| A token row copied in the database to another person, credential or destination             | The seal holds all three (D10)                                                                           |
| Two dispatches refresh one OAuth token at once and the second spends a revoked token        | Compare and swap on `version` (D11)                                                                      |
| A broad OAuth token at rest (GitLab `api`)                                                  | Sealed, write-only, sent only under its destination, revoked on Remove (D8); the docs name the scope     |
| A Piwi user starts a job their CI account may not build                                     | The CI server applies the person's rights; its refusal is shown with the service's message               |
| A person leaves                                                                             | Their tokens are deleted with their account (D10); **Disable** stops all of them during an incident (D9) |

## Delivery

1. **The token method, for CI server actions.** The column, the table and their migrations, `withCredential`, the
   routes, Account → Credentials, the run dialog's authorization step, Check, the credential's panel, the demo, the
   docs (`operate/credentials.md`, `features/ci-rerun.md`), the generated API reference.
2. **The OAuth method, for GitHub, GitLab and Bitbucket actions**: the OAuth application fields, the authorization
   and its callback, the refresh (D11), the revocation, the setup of each host in the docs. GitHub's part needs the
   GitHub App of [#1560](https://github.com/PiwiTests/piwi/issues/1560) first; GitLab and Bitbucket do not wait on it.

## Not in this plan

- **A fallback to a shared credential** when a person has no token: an action that names a per-user credential runs in
  the presser's name or not at all.
- **Per-user credentials for reads, pull-request feedback, AI keys or connections** (D2).
- **OAuth to a CI server**: Jenkins has no OAuth server; a Jenkins behind a single sign-on proxy keeps the token method.
- **The presser's name on the run's page**: Piwi already knows it from the dispatch (`by_name`); showing it on the run
  matched to a dispatch is a separate change, useful with shared credentials too.

## Open questions

1. **Does a request through an API key, an MCP agent's included, carry its owner's token?** Proposed: yes (D6), since
   the key already acts as its owner in Piwi and the log names the key. The alternative refuses it, so only a person
   in the page starts a build in their name.
2. **Only administrators create a per-user credential (D3)?** The alternative lets a Project admin create one for
   their projects, at the risk the first row of the security table names.
3. **No fallback to a shared credential?** Proposed: none, so a build never runs in another name than the presser's
   without them seeing it.
4. **GitHub through the app of #1560 only?** Proposed: yes, one app registration for the `[bot]` uses and the
   per-user ones. The alternative accepts a separate OAuth App, at the cost of the `repo` scope.
