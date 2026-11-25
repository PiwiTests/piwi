# Per-user credentials

**Status.** Proposed on 2026-11-25 and reviewed the same day (security, and correctness against the code). Step 1 is
built: per-user CI server credentials (Jenkins), the token form and its test, Account → Credentials, the run dialog's
authorization step, the credential's panel, the demo, the docs (`operate/per-user-credentials.md`) and entry D70 of the
1.0 register. Step 2, OAuth for GitHub, GitLab and Bitbucket, remains, GitHub's part waiting on #1560. It extends
[credential-manager.md](../adr/credential-manager.md): the store, `withCredential`, the destination binding and the log
stand as that record wrote them.

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
  its destination (both columns nullable), scope, `allowedInputs`, `customRequests`, `disabled`. `withCredential`
  (`server/utils/credentials.ts`) is the one function that opens a secret. A write is one log row naming its Piwi user
  and API key; a read (`ci-check`, `ci-list`, `scm-read`) is counted in one row per credential, feature, project,
  result and hour, which names the last caller of the hour (`countRead`).
- **A CI action names its credential** (`target.credentialId`), for its dispatch, its Check and the job listing of its
  editor (credential-manager D10, D15). Every dispatch is started by a person or an API key (`origin` `page`, `mcp`,
  `api`): nothing dispatches on its own. `readiness` (`server/utils/ci-providers/types.ts`) takes no actor, a refused
  credential is found inside `send()`, after `claimCiDispatch` stored the dispatch, and the 10-second repeat guard
  compares the action, the arguments, the branch and the inputs, not who sent them.
- **The CI server request** builds its Basic header from the user and the secret `withCredential` opens
  (`sendWithCredential`, `server/utils/ci-server-dispatch.ts`); its only preset is Jenkins, beside Custom requests.
- **An API key acts as its owner** (`requireAuth`, `server/utils/auth.ts`), and the MCP and Piwi Picker connections
  mint such keys; `requireSessionAuth` refuses a key.
- **Account page** (`app/pages/settings/account.vue`): Connected accounts (sign-in providers), Connected apps (MCP
  clients), run requests, API keys.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **A credential is shared or per-user** (`per_user`), set at creation and never changed. A per-user credential has every field of a shared one (name, service, destination, scope, `allowedInputs`, state, log) except the user name and the secret: each person gives their own user token. Its service is `ci-server` (step 1) or `scm` (step 2).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D2  | **Only a CI action names a per-user credential**, for its dispatch, its Check and its editor's job listing. The project's and the instance's SCM credential, the AI roles, the Jira and Zephyr Scale connections and the Slack channels refuse one with 400: their uses (ingest reads, pull-request feedback, notifications) have no person behind them.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D3  | **Only `credentials:manage` creates, changes or deletes a per-user credential.** It collects other people's secrets, so its destination is one an administrator chose: `canManageCredential` gives a Project admin no right on one, creator or not. A Project admin picks one for their actions as they pick any credential shared with their projects.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D4  | **Only a person signed in to Piwi's page uses their token.** A request through an API key (the API, an MCP agent, Piwi Picker) is refused with code `session-required`, and every route that reads or changes a user token is session-only (`requireSessionAuth`). An action on a per-user credential is offered to a key as unavailable, with that reason.                                                                                                                                                                                                                                                                                                                                                                                                              |
| D5  | **Each press shows the target and carries its digest.** For an action on a per-user credential the run dialog shows the job path (step 2: the repository, the workflow or pipeline and the branch), the fixed inputs and the account it acts as ("as `alice.martin` on Jenkins"); the dispatch sends the `targetDigest` of what was shown, and an action changed since answers 400 `action-changed`. An administrator narrows what a token can reach by giving the credential a folder as destination (`https://ci.example.com/job/tests/`).                                                                                                                                                                                                                             |
| D6  | **A person gives their token in a form for a CI server** (Jenkins has no OAuth server): their user name and API token. The token must have an API token's form (32 hexadecimal characters, or 34 starting with `11`), so an account password, which Jenkins also takes in a Basic header, is never stored. GitHub, GitLab and Bitbucket take an OAuth authorization (D19).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D7  | **A token is saved only after a test, at one fixed URL per service**: Jenkins `whoAmI/api/json` at its root (the destination cut before its first `job/` segment), refused when it answers `anonymous` or not `authenticated`; GitHub `https://api.github.com/user`; GitLab `/api/v4/user` on its host; Bitbucket `https://api.bitbucket.org/2.0/user`. The test goes through `withCredential` with the token not yet saved (`candidate`), which accepts that URL for the feature `credential-test` alone, masks the token and logs the test, and only where a dispatch would send it: over https, or to a host `PIWI_CI_SERVER_HOSTS` lists.                                                                                                                                                                                                                            |
| D8  | **A test is rate-limited and says little**: 10 per person and credential in 10 minutes, and its answer is `ok` with the account name, `refused` (401 or 403), `anonymous` (no signed-in user named) or `unreachable`, with no text of the service, so the form cannot be used to guess passwords against an internal CI server.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D9  | **One CI account serves one person per credential.** A token whose account another Piwi user already authorized for the credential is refused, so a shared service token cannot be saved as a person's own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D10 | **`withCredential` opens the actor's token.** For a per-user credential it runs the checks of a shared one, then loads the row of the actor: no person, an API key, no row or a row not `ready` is a `CredentialRefusedError` with a `code` (`session-required`, `user-token-required`), logged like any refusal. A request never carries another person's token, and a per-user credential never falls back to a shared one.                                                                                                                                                                                                                                                                                                                                            |
| D11 | **A missing token is refused before the dispatch is stored.** `readiness` and the offered route take the actor; each offered action adds `userToken` (`ready`, `missing`, `invalid`, null for a shared credential), `credential` (`{ id, name, account }` of a per-user one) and `code`, the refusal the run dialog answers by asking for the token. A dispatch refused for its token answers 400 with `data.code` (the "cannot be sent" of the 1.0 register's D69) and stores no `ci_dispatches` row. The repeat guard also compares `by_user_id` for a per-user credential.                                                                                                                                                                                                                                                                         |
| D12 | **A token is `ready` or `invalid`.** A failed test, or a 401 the service answers to a use, marks it `invalid` (and, step 2, a refused OAuth refresh); only a `ready` token is sent, and the run dialog asks again for an `invalid` one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D13 | **The action editor lists with the editor's own token**, cached per person for a per-user credential, so one person is never shown the jobs another's account sees; the credential picker marks a per-user credential, and without a token the listing answers that the editor gives theirs first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D14 | **Account → Credentials** lists the per-user credentials the person may use (shared with a project where they hold `run:control`) and every one they hold a token for, each with its state and **Authorize**, **Test**, **Remove**. Remove deletes the token from Piwi; a Jenkins API token stays valid in Jenkins, so the page links to where the person revokes it.                                                                                                                                                                                                                                                                                                                                                                                                    |
| D15 | **An administrator sees who authorized, never a token.** The credential's panel lists its user tokens (Piwi user, CI account, state, created, tested, last used) and removes one or all. **Disable** stops every token at once. Changing the destination deletes every user token, since each was sealed with it, and each person is asked again.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D16 | **A user token is sealed with its credential, its person and the destination** (`{ credentialId, userId, destination, user, secret }`), in `credential_user_tokens`, one row per credential and person, deleted with either. A row copied to another person or credential does not open. `credential-secret-access.test.ts` also guards `credentialUserTokens.secret`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| D17 | **The log names the person and their CI account**: `credential_uses.remote_user` beside `user_id`, and a counted read of a per-user credential is grouped by person as well, so a row never names someone else's account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D18 | **A per-user credential never goes with a Custom request** (`customRequests` is false and cannot be set): a Custom request's template is a Project admin's, and it would send any person's token to a path they chose, a CI server's script console included. `allowedInputs` applies as on a shared credential.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D19 | **Without sign-in, there is no per-user credential.** A create answers 400 while authentication is off, and an existing one is offered as unavailable ("needs sign-in") until it is on again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D20 | **OAuth (step 2).** The credential holds the OAuth application's client id and client secret, sealed with the service's token endpoint (GitHub `https://github.com/login/oauth/access_token`, GitLab `/oauth/token` on its host, Bitbucket `https://bitbucket.org/site/oauth2/access_token`), never one from input. Authorization runs in a popup, so the run dialog keeps its state; its `state` is kept on the server, single-use, bound to the person, the credential, the PKCE verifier and a return path checked by `safeReturnPath`. A token is refreshed only when opened, 5 minutes before it expires, never in a write gate, and a 401 retries once from the row read again. Remove, an account's deletion and every bulk removal revoke the token at the host. |

## Design

### 1. The record

- `credentials.per_user` (boolean, default false) and `credentials.token_help_url` (an optional link to the page
  where a person creates their token: for Jenkins, their user's Security page). On a per-user credential `secret`,
  `secret_env` and `user_name` are null (step 2 puts the OAuth client secret in `secret`, sealed with its token
  endpoint, and the client id in `oauth_client_id`).
- `credential_user_tokens`: `id`, `credential_id` (cascade), `user_id` (cascade), `remote_user` (the account the test
  answered), `secret` (sealed, D16), `state` (`ready`, `invalid`), `created_at`, `tested_at`, `last_used_at`; unique
  on `(credential_id, user_id)`, index on `user_id`. Both schemas, with generated migrations.
- `credential_uses.remote_user` (D17).
- `CredentialSummary` and `CredentialOption` add `perUser`, `tokenHelpUrl` and, for a manager, `userTokens` (how many
  people authorized); never a secret.

### 2. Using it

`withCredential` runs the existing checks in their order (disabled, scope, destination, Custom request), then, for a
per-user credential, the checks of D10. It opens the token, sends, and marks the token `invalid` when the consumer's
`unauthorized(value)` says the service answered 401 (the CI server's `sendWithCredential` passes it). A test passes
the token typed in the form as `candidate`: the same checks run, the fixed URL of D7 stands in for the destination
check, the log row is written, the token is masked in anything kept, and the row is saved only when the test answered
`ok`.

The dispatch path asks first (D11): `ciDispatch` passes the actor to `readiness`, which answers, for a per-user
credential, `{ available: false, userToken, code }` without building the request; `ciOffered` returns the same per
action. The run dialog shows the authorization form (D14's component) for `missing` or `invalid`, then dispatches with
the `targetDigest` the offered route gave (D5). `withCredential` refuses again at the send (D10), for a token removed
in between. An MCP dispatch answers the refusal as text: the action runs in the presser's name, so start it from
Piwi's page.

### 3. Giving a user token

The form shows the credential's name, its destination in full, who created it ("Your token is sent only to
`https://ci.example.com/`, set by Alex"), the user name (prefilled with the Piwi user name), the API token and, when
the credential has one, the link to where the token is created, with **Test and save**. The route tests first (D7),
answers as D8 says, refuses an account another person authorized (D9), and saves on success.

### 4. Pages and routes

- **Settings → Credentials**: the create form offers **Shared** or **Per user** for a CI server credential, to an
  administrator, while sign-in is on (D1, D3, D19); a per-user credential's panel lists its user tokens (D15) and the
  administrator's own, with Authorize and Test.
- **Account → Credentials** (D14) and the run dialog's authorization step (D11) share one component.
- **The CI action editor**: the credential picker marks a per-user credential; Check and the job listing run with the
  editor's token (D13) and, without one, answer that the editor gives theirs first.
- Routes, all session-only: `GET /api/credentials/mine` (the per-user credentials the caller may use or holds a token
  for, with their token's state), `PUT /api/credentials/:id/token` (test and save), `POST /api/credentials/:id/token/test`,
  `DELETE /api/credentials/:id/token`, and for `credentials:manage` `GET /api/credentials/:id/tokens` and
  `DELETE /api/credentials/:id/tokens` (all) or `.../tokens/:userId` (one).

### 5. The demo

The seed adds a per-user Jenkins credential shared with the demo projects, with tokens for two of the demo's people
(the default one among them) and their log. Its handlers mirror every route; a test sends nothing and answers `ok`
with the person's user name, and a dispatch answers the refusal for a person without a token.

## Security

| Threat                                                                                      | What stops it                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Project admin points an action at a job the presser never meant to build (`prod/deploy`)  | The dialog shows the job, its fixed inputs and the account, and the digest refuses a change since (D5); a folder destination bounds the jobs (D5) |
| A Project admin creates a per-user credential aimed at a server they own, to collect tokens | Only `credentials:manage` creates or changes one (D3); the form shows the destination and its creator (§3)                                        |
| A Project admin's Custom request sends a person's token to a CI server's script console     | A per-user credential never goes with a Custom request (D18)                                                                                      |
| An agent, or a leaked API key, starts builds in its owner's name                            | Only a signed-in session uses a token; the token routes are session-only (D4)                                                                     |
| The test form is used to guess passwords against an internal CI server                      | Rate limit, an answer with no service text (D8), and only an API token's form is accepted (D6)                                                    |
| A test, or the OAuth flow, sends a secret outside the destination unchecked                 | Fixed URLs per service, through `withCredential`, checked, masked and logged (D7, D20)                                                            |
| A shared service token saved as a person's own                                              | One CI account per person and credential (D9); the panel and the log name the account (D15, D17)                                                  |
| A request carries another person's token                                                    | The token is the actor's (D10), sealed with the person's id (D16)                                                                                 |
| A token row copied in the database to another person, credential or destination             | The seal holds all three (D16)                                                                                                                    |
| A log row names the wrong person or account                                                 | Counted reads grouped by person for a per-user credential (D17)                                                                                   |
| A person's identical dispatch answered with another person's build                          | The repeat guard compares who sent it (D11)                                                                                                       |
| The job listing shows one person what another's account sees                                | Listed with the editor's token and cached per person (D13)                                                                                        |
| A login-CSRF binds an attacker's account to a person's row (step 2)                         | Single-use `state` on the server, bound to the person and the credential (D20)                                                                    |
| A person leaves, or loses their rights                                                      | Tokens are deleted with their account; Account → Credentials lists every token held; **Disable** stops all (D14, D15, D20)                        |

## Delivery

1. **Per-user credentials for CI server actions.** The columns, the table and their migrations, `withCredential`,
   the routes, Account → Credentials, the run dialog's authorization step and target, Check and the job listing, the
   repeat guard, the credential's panel, the demo, the docs (`operate/per-user-credentials.md`, linked from
   `operate/credentials.md` and `features/ci-rerun.md`), the generated API reference, and entry D70 of the
   [1.0 register](1.0-stabilization.md).
2. **OAuth for GitHub, GitLab and Bitbucket actions** (D20): the OAuth application fields, the popup and its callback,
   the refresh, the revocation, the setup of each host in the docs. GitHub uses the GitHub App of
   [#1560](https://github.com/PiwiTests/piwi/issues/1560) (its user access tokens, with **Actions: write** and
   **Contents: read**, which Check needs to read the workflow file), and waits on it; GitLab takes an application with
   the `api` scope, Bitbucket a consumer with `pipeline:write` and `account`.

## Not in this plan

- **A key that may use its owner's token**: an opt-in on one API key, set in a signed-in session. D4 refuses every
  key.
- **A fallback to a shared credential** when a person has no token: an action that names a per-user credential runs in
  the presser's name or not at all.
- **Per-user credentials for reads, pull-request feedback, AI keys or connections** (D2).
- **OAuth to a CI server**: Jenkins has no OAuth server; a Jenkins behind a single sign-on proxy keeps the form.
- **The presser's name on the run's page**: Piwi already knows it from the dispatch (`by_name`); showing it on the run
  matched to a dispatch is a separate change, useful with shared credentials too.
