---
title: Per-user credentials
description: "Run a CI action on Jenkins, GitLab or Bitbucket in the name of whoever starts it from Piwi, with their own token and rights, through one credential an administrator sets up once."
lang: en-US
---

# Per-user credentials

A per-user credential runs a CI action in the name of whoever starts it. A shared [credential](./credentials) sends
one secret, so Jenkins shows its account (a `piwi-bot`) as the user who started every build and applies that account's
rights. A per-user credential holds no user and no secret: an administrator sets it up once, each person gives their
own Jenkins user name and API token for it, and a build started from Piwi shows "Started by user alice" and runs with
Alice's rights.

<figure>
  <img src="/screenshots/credentials-per-user.png" alt="A per-user Jenkins credential's panel: it acts as whoever starts an action, each person's own token, the three people who gave theirs with their Jenkins account and its state, one refused by Jenkins, and its log with Quinn's dispatch and Jordan's, which Jenkins refused">
  <figcaption>A per-user credential's panel: who gave their token, as which Jenkins account, and its log.</figcaption>
</figure>

## Set one up

In **Settings → Credentials**, **New credential**, service **CI server**, then **Who it acts as** → **Per user**. Only
an administrator (the `credentials:manage` permission) creates or changes one, and creates it only while sign-in is
on: it collects other people's tokens, so its destination is one an administrator chose. The destination is https, or
a host `PIWI_CI_SERVER_HOSTS` lists, since a token is never sent in the clear. Its fields are a shared credential's
without the user and the secret, plus an optional link to the page where a person creates their token (Jenkins: their
user's **Security** page).

A Project admin then picks it in a CI server action's **Credential**, as any credential shared with the project. It
never goes with a Custom request. To bound what a token can build, give the credential a folder as its destination
(`https://jenkins.example.com/job/qa/`): an action outside it is refused.

## Give your token

Each person gives their token once, under **Account → Credentials**, or in the run dialog the first time they start an
action on it. The form says where the token goes and who set the credential up. Piwi tests the token before saving it,
by reading Jenkins' `whoAmI` at the root of the destination, and keeps the account Jenkins names.

- **An API token only**: 32 or 34 hexadecimal characters, as Jenkins makes them. An account password, which Jenkins
  also takes, is refused and never stored.
- **One account per person**: a token for a Jenkins account another person already gave is refused, so a shared
  service account cannot be saved as someone's own.
- **10 tests per person and credential in 10 minutes**, and a failed test says only that Jenkins refused the token,
  did not recognize it as a signed-in user, could not be reached, or is on a private address `PIWI_CI_SERVER_HOSTS`
  does not list, never Jenkins' own answer.

**Test** sends the saved token again; **Remove** takes it out of Piwi. A removed token stays valid on Jenkins: revoke
it there too.

## GitLab and Bitbucket

A per-user **Source control** credential runs a GitLab pipeline or a Bitbucket custom pipeline in the name of whoever
starts it. Each person authorizes it once at the host, in a popup, instead of typing a token: the host shows the
pipeline as theirs, and its rights apply. A GitHub destination cannot be per user: the form offers it for GitLab and
Bitbucket only.

- **Set it up**: register an OAuth application, on GitLab (scope `api`, on gitlab.com or a host
  `PIWI_SCM_GITLAB_HOSTS` lists) or on Bitbucket (an OAuth consumer with the Account read, Repositories read and
  Pipelines write permissions), with the callback URL the credential form shows. Then create the credential with
  service **Source control**, the host's API as destination, **Per user**, and the application's client id and
  secret. The secret is sealed with the host's token endpoint and sent only to its OAuth endpoints (token and
  revocation).
- **Authorize**: **Authorize with GitLab** (or Bitbucket) under **Account → Credentials**, or in the run dialog. The
  authorization is bound to you and the credential, used once, and expires after 10 minutes; Piwi then reads the
  account the token belongs to and keeps it.
- **Refresh and revocation**: an access token is refreshed when it is used within 5 minutes of its expiry, and marked
  refused when the host refuses the refresh. **Remove**, an administrator's removal and the deletion of an account
  revoke a GitLab token at GitLab; Bitbucket offers no revocation, so revoke it in Bitbucket's settings.

A per-user source control credential serves CI actions only, never a project's or the instance's source control.

## What runs in your name

- **Only from a signed-in page.** An API key, an MCP agent included, never starts an action in someone's name: the
  request is refused before anything is sent.
- **Only your own token.** A person without one is asked for it before the dispatch is sent or stored; a token is
  never sent for anyone else.
- **Only the action you saw.** The run dialog shows the job, the fixed inputs and your Jenkins account, and a dispatch
  refuses an action changed since the dialog showed it.
- **A token Jenkins refuses** (401) is marked refused and no longer sent, until you give it again or a test passes.

The action editor's credential picker says which credential runs in the starter's name; its **Check** and job
listings read with the editor's own token.

## What an administrator sees

The credential's panel lists who gave a token, with their Jenkins account, its state and its last use, never the
token, and removes one or all. **Disable** stops every token at once. A new destination removes every token, each
sealed with the one it leaves. The log names each use's person, and their Jenkins account for a use of their saved
token, and counts each person's reads in rows of their own.

## Related

- [Credentials](./credentials): the fields, the checks and the log every credential shares
- [CI actions](/features/ci-actions): the CI server action that names the credential
- [CI re-run](/features/ci-rerun): the run dialog that asks for your token
- [Access, roles and groups](./project-access): who holds `credentials:manage`
