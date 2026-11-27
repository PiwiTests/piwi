---
title: Operator token
description: "Let whoever runs Piwi for other people read its usage and show its users a notice, without an account in the instance."
lang: en-US
---

# Operator token

An instance run for other people, by an agency, a platform team or a hosting provider, has two sides. Its users sign
in and own what it holds. Whoever runs the server holds no account in it, yet has to know how much it holds, when it
is busy, and tell its users about a maintenance window. The operator token gives that side those answers and that
banner, and nothing more: no route it opens returns a test result, a name, an email address or a file.

## Set the token

Set [`PIWI_OPERATOR_TOKEN`](/reference/configuration#authentication) to a random string of at least 32 characters,
and restart. Generate one:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Send it as a Bearer token. No session and no API key opens the operator routes, and the token opens nothing else.
Unset, or shorter than 32 characters, the routes answer 404 as if they did not exist. A client network that sends ten
wrong tokens in 15 minutes is refused until the window ends.

## Read the usage

The usage counts the projects, the users, the runs and the stored files, the reporter versions that sent runs lately,
and what a restart would cut right now. [Upgrading](./upgrading#wait-for-the-runs-in-progress) shows how a deployment
script waits on it before it restarts the server.

## Show a notice

A notice is one banner above every page of the dashboard, for every signed-in user or for administrators only: a
maintenance window, a change to the service, a deadline. It is one line of plain text with an optional link, and a
new one replaces it.

<figure>
  <img src="/screenshots/operator-notice.png" alt="A warning banner above the dashboard's Home page announcing a maintenance window, with a link to a status page and a button to dismiss it" />
  <figcaption>A warning notice above the Home page.</figcaption>
</figure>

```bash
node -e "fetch('http://localhost:3000/api/operator/notice',{method:'PUT',headers:{Authorization:'Bearer your_operator_token','Content-Type':'application/json'},body:JSON.stringify({level:'warning',text:'Maintenance on Sunday from 06:00 to 06:30 UTC: uploads wait until it ends.',link:{url:'https://status.example.com',label:'Status page'},expiresAt:'2026-12-06T06:30:00Z'})}).then(r=>r.text()).then(console.log)"
```

- **Who sees it**: every signed-in user, or administrators only. They see it at their next page load: a page already
  open shows it once reloaded.
- **Dismissing it**: an `info` or `warning` notice can be dismissed, which hides it in that browser until another
  notice replaces it. A `critical` one stays.
- **Its end**: nobody sees it after its `expiresAt`, if it has one, or once it is cleared:

```bash
node -e "fetch('http://localhost:3000/api/operator/notice',{method:'DELETE',headers:{Authorization:'Bearer your_operator_token'}}).then(r=>r.text()).then(console.log)"
```

Every field and its limits are in the API reference (`/settings/api` on your instance), under Operator.

## Related

- [Upgrading](./upgrading): wait for the runs in progress before a restart
- [Authentication](./authentication): users, roles and API keys
- [Configuration reference](/reference/configuration#authentication): `PIWI_OPERATOR_TOKEN`
