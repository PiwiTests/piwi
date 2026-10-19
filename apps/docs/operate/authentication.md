---
title: Authentication
description: "Turn on sign-in and instance roles, create the first administrator, configure Google and GitHub OAuth, and manage user accounts."
lang: en-US
---

# Authentication

The dashboard supports optional sign-in with role-based access control. Authentication is **disabled by default**: every endpoint then behaves as a single administrator. Turn it on before anyone else can reach the instance; the [production checklist](./production-checklist) lists the rest of what to set.

## Roles

Every account holds one **instance role**:

| Instance role | What it can do |
|------|-------------|
| **Administrator** | Everything, on every project: users, groups, instance settings, AI providers, Jira connections, storage, tags, creating and deleting projects. Never restricted by project roles. |
| **Member** | Signs in and manages their own profile, API keys, dashboards, notification channels and subscriptions. Everything else comes from their project roles. |

What a Member can do inside a project comes from the **project roles** (Viewer, Contributor, Maintainer, Project admin, Uploader) granted to them or to one of their groups, on that project or on all projects: see [Access, roles and groups](./project-access). The Administrator role is granted to a user, never to a group.

## Enabling authentication

1. Set these variables wherever you configure the server (the container's environment, `.env`, or your host's
   dashboard):

   ```bash
   PIWI_AUTH_ENABLED=true
   PIWI_AUTH_SECRET=your-auth-secret-here  # signs session cookies
   PIWI_SECRET_KEY=your-secret-key-here    # encrypts stored credentials (AI keys, SCM tokens)
   ```

   Generate a strong random value for each secret (run it twice):

   <<< @/snippets/secret.sh{bash}

2. Restart the server. It refuses to start with authentication on and no `PIWI_AUTH_SECRET`.

## Initial setup

When authentication is enabled and no administrator exists yet, opening the dashboard lands on the login page, which shows a **Create the first admin account** form in place of the sign-in form. Fill it in and you are signed in as the administrator, with no API call needed.

For provisioning an instance from a script, the same step is available as an API call:

::: code-group

```bash [Linux / macOS]
curl -X POST http://localhost:3000/api/auth/setup -H "Content-Type: application/json" -d '{"username": "admin", "password": "your-secure-password", "name": "Administrator"}'
```

```powershell [Windows (PowerShell)]
$body = @{ username = 'admin'; password = 'your-secure-password'; name = 'Administrator' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/setup `
  -ContentType 'application/json' -Body $body
```

:::

Both go through the same setup endpoint, rate-limited per client address and open while no administrator exists, even after members signed in through OAuth.

On an instance reachable from the internet, set `PIWI_SETUP_TOKEN` to a random value before you start it: the form then
asks for that value, and the API call carries it as `"setupToken"`, so a stranger who opens the URL first cannot
create the administrator. The [one-click deploy templates](./one-click-deploy) generate it.

## Logging in

Sign in at `/login`. Sessions are stored in encrypted cookies and last for 7 days. The session cookie is marked `Secure`, so browser sign-in needs HTTPS — over plain `http://` it only works on `localhost`.

## OAuth (Google, GitHub)

Users can sign in with Google or GitHub instead of a username and password.

### Configuring OAuth

1. **Register an OAuth application** with each provider you want to use:

   - **Google**: Go to the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an OAuth 2.0 Client ID, and add the Google callback URL below to the authorized redirect URIs.
   - **GitHub**: Go to **Settings → Developer settings → OAuth Apps** on GitHub, create a new OAuth app, and set its callback URL to the GitHub one below.

   ```text
   https://your-domain.com/api/auth/oauth/google/callback
   https://your-domain.com/api/auth/oauth/github/callback
   ```

2. **Set the credentials** alongside the other variables:

   ```bash
   PIWI_OAUTH_GOOGLE_CLIENT_ID=your-google-client-id
   PIWI_OAUTH_GOOGLE_CLIENT_SECRET=your-google-client-secret
   PIWI_OAUTH_GITHUB_CLIENT_ID=your-github-client-id
   PIWI_OAUTH_GITHUB_CLIENT_SECRET=your-github-client-secret
   ```

   Only configure the providers you actually want to use. OAuth buttons appear automatically on the login page when both a provider's `CLIENT_ID` and `CLIENT_SECRET` are set.

3. **Restart the server.** The login page now shows **Sign in with Google** and/or **Sign in with GitHub** buttons above the password form.

> **Behind a reverse proxy:** set `PIWI_SITE_URL` to your public URL (e.g. `https://piwi.example.com`). The OAuth `redirect_uri` is built from it, so it stays consistent with the value you registered even when the proxy rewrites the request host. Without it the redirect URI is inferred from the incoming request.

### Restricting who can sign in (allowlists)

By default any account at a configured provider can sign in (and a new **Member** account with no access is created). To restrict access:

- **`PIWI_OAUTH_ALLOWED_DOMAINS`** — comma-separated email domains (e.g. `example.com,acme.org`). Only **verified** provider emails in these domains may sign in. Applies to all providers — ideal for limiting Google Workspace sign-in to your company domain.
- **`PIWI_OAUTH_GITHUB_ALLOWED_ORGS`** — comma-separated GitHub org logins. The user must be a member of at least one. Enabling this requests the `read:org` scope so membership (including private) can be checked.

Rejected sign-ins are returned to the login page with an explanatory message.

### Account linking

A first sign-in with a provider either links an existing account or creates a new one. Email addresses are compared ignoring case, so `Bob@corp.com` and `bob@corp.com` are the same address, and an address belongs to at most one account.

- If a user with the same **verified** email exists (and isn't already linked to a *different* provider), the existing account is linked to the provider. Linking needs proof on both sides: the provider must assert the email is verified, **and** the local account must have verified it too (through the verification link, an accepted invite, or an earlier provider sign-in). This stops an attacker-controlled public email, or an address someone typed into their own profile, from capturing another person's sign-in.
- If the matching account has **not** verified the address, the sign-in is refused with an explanatory message instead of being linked. The account's owner signs in with its password (or accepts their invite first) and connects the provider from **Settings → Account**.
- If the matching account is **already linked to a different provider**, the sign-in is refused: one provider is linked per account, so sign in with the original method instead.
- Otherwise, a new user is created as a **Member** with no project role and no password, so it always signs in through its provider and sees nothing until it is [granted a role](./project-access#default-is-no-access). An email the provider has not verified never links an account, so GitHub accounts with no verified primary email always get a new account.

The new account stores the provider's email, unverified unless the provider verified it, or **no email** when another account already uses that address. Its username is its email, else the GitHub login, else `<provider>-<id>`; a taken one gets the first free number appended (`octocat-2`, `octocat-3`, …).

Each later sign-in updates the account's name, avatar and email from the provider. The email stays as it is when the provider sends none, or one another account already uses.

The dashboard does not keep the provider's tokens: the access token is used once to read the profile, then discarded. OAuth is not available in demo mode.

### Connecting / disconnecting a provider

Signed-in users can link a provider explicitly from **Settings → Account → Connected accounts**:

- **Connect** starts the OAuth flow in "link" mode and attaches the provider identity to the current account (rather than creating a new one). A provider identity already linked to another account is refused. An account without an email address takes the provider's, unless another account already uses it.
- **Disconnect** removes the link. It's only allowed when the account also has a password set, so a provider-only user can't lock themselves out — set a password first.

## User management

Administrators manage accounts under **Settings → Users** (`/settings/users`). **Add user** creates one with a
username, password, instance role and optional display name and email. Each row shows the user's instance role and the
[groups](./project-access#groups) they belong to.

An email address belongs to one account, ignoring letter case: creating or editing an account with an address another
account already uses is refused, and **Forgot password?** finds the account whatever the case typed. An upgrade that
finds such duplicates stops until an administrator fixes them: see
[What happens when a new version starts](./upgrading#what-happens-when-a-new-version-starts).

A link Piwi emails, to verify an address, accept an invite or reset a password, works only while the account still
holds the address it was sent to. Once the address changes, by its owner, an administrator or a provider sign-in, the
links already sent are refused: send a new one to the new address.

### Changing a role

Each row's **Role** column is an inline selector for the instance role: pick **Administrator** or **Member** to change it immediately (the user's active sessions are revoked so the change takes effect at once). This is the only way to make an account an administrator, including accounts created through [OAuth](#oauth-google-github), which always start as a **Member** with no access. The **last remaining administrator cannot be demoted**, so an instance can never be left without one.

What a Member can do in each project is set by [project roles](./project-access), and the keys that let CI and scripts sign in are [API keys](./api-keys).

## Disabling authentication

Set `PIWI_AUTH_ENABLED=false`, or remove the variable, and restart the server. Every endpoint is then accessible
without authentication.

## Related

- [Access, roles and groups](./project-access): project roles, groups and the permission grid
- [API keys](./api-keys): authenticating the reporter, CI and scripts
- [Production checklist](./production-checklist): the secrets, TLS and proxy settings to go with it
- [Configuration reference](/reference/configuration#authentication): every authentication and OAuth variable
