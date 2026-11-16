---
title: Credentials
description: "Save a secret Piwi sends to another service once, bind it to the address it may reach, share it with projects, and read the log of every use."
lang: en-US
---

# Credentials

A credential is a secret Piwi sends to another service, saved once under **Settings → Credentials** and named wherever
it is needed. A CI server action of [Re-run in CI](/features/ci-rerun) picks one instead of repeating a user, a token
and a base URL in every action and every project, and a rotation is one change. Every use is logged.

## What a credential holds

| Field | What it is |
|---|---|
| **Name** | Unique on the instance, ignoring case; the name the pickers and the log show. |
| **Destination** | The base URL the secret may be sent under (`https://jenkins.example.com/`). A request to any other address, or outside its path, is refused. |
| **User** | The user name sent with the secret as HTTP Basic authentication, when the service takes one. |
| **Secret** | The API token, saved encrypted with `PIWI_SECRET_KEY`, together with the destination, or read from a server variable (below). Never returned by any page, API answer or log. |
| **Projects** | The projects whose CI actions may name it: a list, or all projects, present and future. |
| **Inputs** | The CI action inputs a request carrying it may send beside the arguments and the dispatch id: every input, or the names listed. |
| **Custom requests** | Whether a Custom CI server request may carry it. Off by default: a Custom request can reach any path under the destination, a CI server's script console included. |

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
the destination like a saved secret, so changing the destination asks for the name again. The panel says when the
variable is not set on the server, and a dispatch is then refused and logged. Only an administrator may change a
credential that reads a variable.

## Who manages them

An administrator (the `credentials:manage` permission) creates, changes, disables and deletes any credential, and is the
only one who may share one with all projects. A Project admin creates credentials from a project's **CI** settings,
shares them with the projects they manage, and changes the ones they created while they are shared only with those
projects. A credential an administrator saved stays the administrator's: a Project admin picks it, and never loosens its
rules. Anyone who manages a project's CI actions picks any credential shared with that project, without ever reading
its secret. See [Access, roles and groups](./project-access).

**Disable** refuses every use of a credential at once, for an incident, without touching the actions that name it.
**Delete** is refused while a CI action names the credential: the answer lists them.

## Using one in a CI action

In **Project → Settings → CI**, a CI server action's editor has a **Credential** picker and a **New credential**
button. The action's base URL may stay empty: it is then the credential's destination. The request preview shows which
credential the request carries, and says when the credential would refuse it.

Each dispatch and each **Check** checks the credential again before anything is sent: still active, shared with the
project, and holding the request's URL under its destination, and allowing a Custom request when the action sends one.

## The instance credential

The operator can set one CI server credential through the environment: `PIWI_CI_SERVER_URL`, `PIWI_CI_SERVER_USER` and
`PIWI_CI_SERVER_TOKEN`. It shows on the page as a read-only credential, shared with all projects, and is sent by a CI
server action that names no credential, only with a preset's request under `PIWI_CI_SERVER_URL`, and with only the
inputs `PIWI_CI_SERVER_ALLOWED_INPUTS` lists. Its uses are logged like any other. See the
[configuration reference](/reference/configuration).

A CI server token stored on a project, as the **CI** section held one before credentials, is moved to a credential at
startup: bound to the URL it was saved with, shared with its project, allowed with a Custom request and every input as
the token was, and named by the CI server actions it served. Two projects holding the same token for the same URL and
user share one credential.

## The log

A credential's panel lists every use, newest first:

- **What**: a CI dispatch, or a Check, with the CI action it was for.
- **Where**: the project, and the request's origin and path (never its query).
- **Who**: the user who started it, and the API key when it came through one (an MCP tool, a script).
- **How it ended**: `sent` until the CI server answers, then `ok` or `failed` with the status; `refused` when the
  credential's rules stopped it before anything was sent, with the reason.

A dispatch is one row. A Check only reads, so the Checks of a project are counted in one row per result and hour. The
secret is masked in any reason a CI server's answer holds. The log is kept 365 days, or `PIWI_CREDENTIAL_LOG_DAYS`
(0 keeps it forever), by the nightly sweep; a deleted credential's rows stay under its name until then.

## Related

- [Re-run in CI](/features/ci-rerun): the CI actions that name a credential
- [Access, roles and groups](./project-access): who holds `credentials:manage` and `project:manage`
- [Production checklist](./production-checklist): `PIWI_SECRET_KEY`, which encrypts every secret
