---
title: Credentials
description: "Save a secret Piwi sends to a CI server or a Git host once, bind it to the address it may reach, share it with projects, and read the log of every use."
lang: en-US
---

# Credentials

A credential is a secret Piwi sends to another service, saved once under **Settings → Credentials** and named wherever
it is needed: by a CI server action of [Re-run in CI](/features/ci-rerun), instead of a user, a token and a base URL in
every action, by a project's [source control](/guide/source-control), an AI role or a Jira or Zephyr Scale connection.
A rotation is one change, and every use is logged.

<figure>
  <img src="/screenshots/credentials-settings.png" alt="Settings → Credentials: two Jenkins and two GitHub credentials, a Jenkins one open in a panel with its user, destination, projects, the three CI actions that name it and its log of dispatches and checks">
  <figcaption>Settings → Credentials: a credential's panel, with the CI actions that name it and its log.</figcaption>
</figure>

## What a credential holds

| Field | What it is |
|---|---|
| **Service** | **CI server**, **Source control** for a GitHub, GitLab or Bitbucket token, **AI provider**, **Jira Cloud** or **Zephyr Scale**. |
| **Name** | Unique on the instance, ignoring case; the name the pickers and the log show. |
| **Destination** | The base URL the secret may be sent under (`https://jenkins.example.com/`). A request to any other address, or outside its path, is refused. |
| **User** | The user name sent with the secret as HTTP Basic authentication, when a CI server takes one; for Jira, the account's e-mail. |
| **Secret** | The API token, saved encrypted with `PIWI_SECRET_KEY`, together with the destination, or read from a server variable (below). Never returned by any page, API answer or log. |
| **Projects** | The projects that may name it: a list, or all projects, present and future. |
| **Inputs** | For a CI server, the CI action inputs a request carrying it may send beside the arguments and the dispatch id: every input, or the names listed. |
| **Custom requests** | For a CI server, whether a Custom request may carry it. Off by default: a Custom request can reach any path under the destination, a CI server's script console included. |

Saving a secret needs `PIWI_SECRET_KEY` (see the [production checklist](./production-checklist)); without it, the
form says so and nothing is saved. Changing the destination asks for the secret again, since the secret is sealed with
the one destination it may be sent under.

## A secret from a server variable

An administrator can have a credential read its secret from a variable of the server's environment instead of saving
it: **Secret source** → **Read from a server variable**, then the variable's name. Only a variable named
`PIWI_CREDENTIAL_…` (capitals, digits and `_`) can be named, so no other variable of the server, such as
`PIWI_SECRET_KEY` or a database URL, can be sent anywhere. Set it as the server's other variables are set, from a
secrets store or the container's environment:

```bash [.env]
PIWI_CREDENTIAL_JENKINS=11a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6
```

The variable is read at each use, so changing it and restarting the server is the rotation. Its name is sealed with
the destination like a saved secret, so a new destination is saved with the name again (the form sends it). The
panel says when the variable is not set on the server, and a dispatch is then refused and logged. Only an
administrator may change a credential that reads a variable.

## Who manages them

An administrator (the `credentials:manage` permission) creates, changes, disables and deletes any credential, and is the
only one who may share one with all projects. A Project admin opens **Settings → Credentials** too, and sees there the
credentials they manage: the ones they created, shared only with projects they manage and reading no variable. They
create them there or from a project's **CI** or **Source control** settings. A credential an administrator saved or
changed is the administrator's: a Project admin picks it, and never loosens its rules or undoes a **Disable**. Anyone
who manages a project picks any credential shared with it, for its CI actions or its source control, without ever
reading its secret. See
[Access, roles and groups](./project-access).

**Disable** refuses every use of a credential at once, for an incident, without touching the actions that name it.
**Delete** is refused while something names the credential (a CI action, a project's or the instance's source
control): the answer lists them.

## Using one in a CI action

In **Project → Settings → CI**, a CI server action's editor has a **Credential** picker and a **New credential**
button. The action's base URL may stay empty: it is then the credential's destination. The request preview shows which
credential the request carries, and says when the credential would refuse it.

Each dispatch and each **Check** checks the credential again before anything is sent: still active, shared with the
project, and holding the request's URL under its destination, and allowing a Custom request when the action sends one.

## What names a credential

- **A CI action**: a CI server action's requests, or the dispatch and the **Check** of a GitHub, GitLab or Bitbucket
  action ([Re-run in CI](/features/ci-rerun)).
- **Source control**: a project's repository calls, else the instance's, with a GitHub, GitLab or Bitbucket token sent
  to the host's API ([Source control](/guide/source-control#set-the-credential)).
- **An AI role**: the key of a role of **Settings → AI**, sent to its provider ([AI provider](/guide/ai-provider#api-keys)).
- **A Jira or Zephyr Scale connection**: its API token, sent to the Jira site or the Zephyr Scale region's API
  ([below](#jira-and-zephyr-scale-connections)).

Whatever names it, a credential is checked and logged as this page says; each page says what its feature sends and
how the secrets saved before credentials existed were moved.

## The CI server credential of the environment

The operator can set one CI server credential through the environment: `PIWI_CI_SERVER_URL`, `PIWI_CI_SERVER_USER` and
`PIWI_CI_SERVER_TOKEN`. It shows on the page as a read-only credential, shared with all projects, and is sent by a CI
server action that names no credential, only with a preset's request under `PIWI_CI_SERVER_URL`, and with only the
inputs `PIWI_CI_SERVER_ALLOWED_INPUTS` lists. Its uses are logged like any other. See the
[configuration reference](/reference/configuration).

A CI server token stored on a project (`projects.ci_server_token`) is moved to a credential at startup: bound to the
URL it was saved with, shared with its project, allowed with a Custom request and every input, and named by the CI
server actions it served. Two projects holding the same token for the same URL and user share one credential. An
administrator manages it, since the database does not say who saved the token. A token that cannot be opened (a
changed `PIWI_SECRET_KEY`) stays where it is, with a warning in the log at each start.

## Jira and Zephyr Scale connections

The token typed in a connection's form under **Settings → Integrations** is saved as its credential, named after it,
shared with all projects and sent only under the Jira site (the Atlassian gateway of a scoped token counts as the
site) or the Zephyr Scale region's API. A token typed later rotates it; **Saved credential** picks another. Opening a
connection (a picker, a sync, a check) is a counted read; each write (an issue, a comment, a transition, an
attachment, a results upload, a link) is a row of its own.

`PIWI_JIRA_*` and `PIWI_ZEPHYR_*` make a read-only credential of the environment for their connection, which reads the
token from the variable. A token a connection held before credentials existed is moved at startup to a credential of
its own, named after the connection.

## The log

A credential's panel lists its uses, newest first, and the page's **Log**, for an administrator, those of every
credential, a deleted one and the environment's included:

- **What**: a CI dispatch or a Check, with the CI action it was for; a repository read, a commit status, a
  pull-request comment or an auto-heal write, with its commit, pull request or branch; an AI model call; a read or a
  write of a Jira or Zephyr Scale connection.
- **Where**: the project, and the request's origin and path (never its query).
- **Who**: the user who started it, and the API key when it came through one (an MCP tool, a script); for counted
  Checks, the last of the hour.
- **How it ended**: `sent` until the service answers, then `ok` or `failed` with the reason; `refused` when the
  credential's rules stopped it before anything was sent, with the reason.

A dispatch or another write is one row. A Check or a repository read only reads, so the reads of a project are counted
in one row per result and hour. The secret is masked in any reason a service's answer holds. The log is kept 365 days, or
`PIWI_RETENTION_CREDENTIAL_LOG_DAYS` (0 keeps it forever), by the nightly sweep; a deleted credential's rows stay in the
page's **Log**, under its name, until then.

## Related

- [Re-run in CI](/features/ci-rerun): the CI actions that name a credential
- [Source control](/guide/source-control): what reads and writes a repository with an SCM credential
- [Jira Cloud](./integrations) and [Zephyr Scale](./zephyr-scale): the connections that name a credential
- [Access, roles and groups](./project-access): who holds `credentials:manage` and `project:manage`
- [Production checklist](./production-checklist): `PIWI_SECRET_KEY`, which encrypts every secret
