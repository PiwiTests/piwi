---
title: API keys
description: "Create, use and revoke the long-lived API keys that authenticate the reporter, CI pipelines, scripts and metric scrapers."
lang: en-US
---

# API keys

An API key is a long-lived token tied to one user account, and the recommended way to authenticate CI pipelines, the
Playwright reporter and scripts once [authentication](./authentication) is on. A key carries its owner's access: their
[instance role](./authentication#roles) and the [project roles](./project-access) they hold, directly or through
their groups. A key for a Member with the Uploader role on one project can read that project and upload to it, and
nothing else.

For CI, create a dedicated account: a **Member** with the **Uploader** role on the projects CI reports to (on All
projects if CI should create projects from a new project name), and a key for it. A leaked CI key then cannot triage,
delete or change anything.

With authentication on, every endpoint needs a session cookie or an API key whose owner holds the permission the
endpoint declares (listed per endpoint in the [API docs](https://piwitests.dev/demo/docs)). The exceptions are the
health and version endpoints, the sign-in flows themselves, and live-run streaming, which uses per-run stream tokens.

## Security properties

- Keys are generated with 256 bits of cryptographic entropy (`pd_` prefix + 64-character hex string).
- Only a SHA-256 hash of the key is stored in the database: the plaintext is shown **once** at creation time and is
  never retrievable again.
- Each key displays a short prefix (`pd_xxxxxxxx…`) in the UI for identification without revealing the secret, with
  its creation date and when it was last used.
- Keys are sent as `Authorization: Bearer <key>` or `X-API-Key: <key>` headers.
- Keys can be given an optional expiry date.

## Creating an API key

Every signed-in user manages their own keys under **Settings → Account → API keys**. An administrator can also manage
any user's keys from **Settings → Users**, with the key icon next to the user; that is how you create a key for a
dedicated CI account.

1. Click **Create API key**, enter a descriptive name (e.g. "GitHub Actions"), and set an optional expiry.
2. Click **Generate key**, and copy the key **immediately**: it will never be shown again.
3. Store it as a CI secret (e.g. `PIWI_API_KEY`).

Connecting the [browser extension](/features/extension-connection) creates a key the same way, once you click
**Allow** on the page it opens: it is named after the browser ("Piwi Picker in Chrome on Windows") and listed with the
others.

<figure>
  <img src="/screenshots/user-api-keys.png" alt="A user's API keys dialog: one key named GitHub Actions CI with its prefix, creation date and Never used, a revoke button, and Create API key">
  <figcaption>A user's API keys: each shown by its prefix, with its last use.</figcaption>
</figure>

## Revoking an API key

Click the trash icon next to the key, in the same place you created it. The key stops working immediately.

## Using the API key in the reporter

The reporter reads the key from `PIWI_API_KEY`, in the environment or in the `.env` beside the Playwright config
(`init --api-key` writes it), so the config needs no change: store the key as a CI secret under that name. To read it from
another variable, pass it in the [`wrapConfig`](/guide/reporter#installing-via-wrapconfig) options:

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test'
import { wrapConfig } from '@piwitests/reporter'

export default wrapConfig(defineConfig({ testDir: './tests' }), {
  serverUrl: 'https://your-dashboard.example.com',
  projectName: 'my-project',
  apiKey: process.env.MY_DASHBOARD_KEY,
})
```

## Using the API key in raw HTTP calls

::: code-group

```bash [Linux / macOS]
# Authorization: Bearer header (recommended)
curl -X POST https://your-dashboard.example.com/api/test-runs/submit -H "Authorization: Bearer pd_<your-key>" -H "Content-Type: application/json" -d '{ ... }'

# X-API-Key header (alternative)
curl -X POST https://your-dashboard.example.com/api/test-runs/submit -H "X-API-Key: pd_<your-key>" -H "Content-Type: application/json" -d '{ ... }'
```

```powershell [Windows (PowerShell)]
# Authorization: Bearer header (recommended)
Invoke-RestMethod -Method Post -Uri https://your-dashboard.example.com/api/test-runs/submit `
  -Headers @{ Authorization = 'Bearer pd_<your-key>' } `
  -ContentType 'application/json' -Body '{ ... }'

# X-API-Key header (alternative)
Invoke-RestMethod -Method Post -Uri https://your-dashboard.example.com/api/test-runs/submit `
  -Headers @{ 'X-API-Key' = 'pd_<your-key>' } `
  -ContentType 'application/json' -Body '{ ... }'
```

:::

## Using the reporter with a username and password

As an alternative to API keys, give the reporter the credentials of a dedicated Member with the **Uploader** role,
created in **Settings → Users**: set `PIWI_USERNAME` and `PIWI_PASSWORD` as secrets in your CI provider (or the
`username` and `password` options). The reporter signs in before each upload and uses the resulting session for the
requests that follow. API keys are still preferred for CI: they need no sign-in round-trip, and each one can be revoked
on its own.

## Related

- [Authentication](./authentication): turning sign-in on, roles and user management
- [Access, roles and groups](./project-access): the project roles a key's owner can hold
- [Reporter](/guide/reporter): every reporter option
- [Metrics and rollup export](./metrics): scraping with an API key
