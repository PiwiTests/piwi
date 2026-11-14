---
title: Authentication
description: "Turn on sign-in and instance roles, create the first administrator, configure Google and GitHub OAuth, and manage user accounts."
lang: en-US
---

# Authentication

This page covers sign-in, instance roles, OAuth and user accounts; project roles are on [Access, roles and groups](./project-access), keys on [API keys](./api-keys). Sign-in is **off by default**: every request then acts as one administrator. Turn it on before anyone else can reach the instance; the [production checklist](./production-checklist) lists the rest.

## Roles

Every account holds one **instance role**:

| Instance role | What it can do |
|------|-------------|
| **Administrator** | Everything, on every project: users, groups, instance settings, AI providers, Jira connections, storage, tags, creating and deleting projects (a first upload [can create one too](./project-access#all-projects-or-one-project)). Never restricted by project roles. |
| **Member** | Signs in and manages their own profile, API keys, dashboards, notification channels and subscriptions. Everything else comes from their project roles. |

A Member's rights inside a project come from the **project roles** granted to them or their groups ([Access, roles and groups](./project-access)). The Administrator role is granted to a user, never to a group.

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

2. Restart the server. It refuses to start with authentication on and no `PIWI_AUTH_SECRET`, or one shorter than 32
   characters.

## Initial setup

While authentication is on and no administrator exists (even after members signed in through OAuth), the login page
shows a **Create the first admin account** form instead of the sign-in form, which signs you in as the administrator.
A script can make the same call:

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

The endpoint is rate-limited per client address. On an instance reachable from the internet, set `PIWI_SETUP_TOKEN` to
a random value: the form asks for it, and the API call carries it as `"setupToken"`, so a stranger cannot become the
administrator first. The Railway, Render and Coolify [one-click deploy templates](./one-click-deploy) generate it.

## Logging in

Sign in at `/login` with your username or your email address (letter case ignored, verified or not). A username wins
over another account's email, such as the old address a provider-created account kept as its username.

A session is an encrypted cookie that lasts 7 days. It is marked `Secure`, so browser sign-in needs HTTPS, except on `localhost`. Signing out ends the account's sessions in every browser.

## OAuth (Google, GitHub)

Users can also sign in with Google or GitHub; there is no other provider, nor generic OpenID Connect or SAML.

### Configuring OAuth

1. **Register an OAuth application** with each provider you want to use:

   - **Google**: in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an OAuth 2.0 Client ID with the Google callback URL below as an authorized redirect URI.
   - **GitHub**: under **Settings → Developer settings → OAuth Apps** on GitHub, create an OAuth app with the GitHub callback URL below.

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

3. **Restart the server.** The login page shows a **Sign in with …** button for each provider whose `CLIENT_ID` and `CLIENT_SECRET` are both set.

> **Behind a reverse proxy:** set `PIWI_SITE_URL` to your public URL (e.g. `https://piwi.example.com`): the OAuth `redirect_uri` is built from it, else from the request's host, which a proxy may rewrite.

### Restricting who can sign in (allowlists)

By default any account at a configured provider can sign in. To restrict it:

- **`PIWI_OAUTH_ALLOWED_DOMAINS`** — comma-separated email domains (e.g. `example.com,acme.org`). Only **verified** provider emails in these domains may sign in. Applies to all providers.
- **`PIWI_OAUTH_GITHUB_ALLOWED_ORGS`** — comma-separated GitHub org logins. The user must belong to at least one; it requests the `read:org` scope to check membership, private included.

A rejected sign-in returns to the login page, saying why.

### Account linking

A first provider sign-in links an existing account or creates one. Email addresses are compared ignoring case, so `Bob@corp.com` and `bob@corp.com` are the same address, and an address belongs to at most one account.

- If a user with the same **verified** email exists (and isn't linked to a *different* provider), that account is linked. Linking needs proof on both sides: the provider asserts the email is verified, **and** the local account verified it too (a verification link, an accepted invite, or an earlier provider sign-in), so an address someone typed into their own profile cannot capture another person's sign-in.
- If the matching account has **not** verified the address, the sign-in is refused, saying why. The account's owner signs in with its password (or accepts their invite first) and connects the provider from **Settings → Account**.
- If the matching account is **linked to a different provider**, the sign-in is refused: one provider per account.
- Otherwise, a new user is created as a **Member** with no project role and no password, so it always signs in through its provider and sees nothing until it is [granted a role](./project-access#default-is-no-access). An email the provider has not verified never links an account, so GitHub accounts with no verified primary email always get a new account.

The new account stores the provider's email, unverified unless the provider verified it, or **no email** when another account uses it. Its username is its email, else the GitHub login, else `<provider>-<id>`; a taken one gets a number appended (`octocat-2`).

Each later sign-in updates the name, avatar and email from the provider, keeping the email when the provider sends none or one another account uses.

Piwi keeps no provider token: the access token serves the sign-in, then is discarded. The demo has no OAuth.

### Connecting / disconnecting a provider

Signed-in users link a provider from **Settings → Account → Connected accounts**:

- **Connect** attaches the provider identity to the current account; one already linked to another account is refused. An account without an email address takes the provider's, unless another account uses it.
- **Disconnect** removes the link, only when the account has a password, so a provider-only user cannot lock themselves out.

## User management

Administrators manage accounts under **Settings → Users** (`/settings/users`). **Add user** creates one with a
username, an instance role, an optional display name and email, and a password. Without one, the row's **Send invite email**
button mails the user a link to set their own. Each row shows the user's instance role and
[groups](./project-access#groups).

**Settings → Account** takes a profile picture (PNG, JPEG or WebP, under 1 MB, at most 1000×1000 pixels) that
replaces the provider's and that administrators can remove. Only its owner sees it; others see the initials.

An email address belongs to one account, ignoring letter case: creating or editing an account with an address another
account already uses is refused, and **Forgot password?** finds the account whatever the case typed. An upgrade that
finds such duplicates stops until an administrator fixes them: see
[What happens when a new version starts](./upgrading#what-happens-when-a-new-version-starts).

A link Piwi emails, to verify an address, accept an invite or reset a password, works only while the account holds
the address it was sent to; once the address changes, whoever changed it, resend to the new one.

### Email and account recovery

Invitations, address verification and **Forgot password?** need [SMTP](/features/notifications#smtp-configuration).
Without it, invites and verification links are refused, and **Forgot password?** says a link was sent but sends
nothing. Invite and reset emails name the sign-in username.

No administrator can set another account's password: a locked-out account recovers through **Forgot password?**, which
needs SMTP and an email address on the account. Give every administrator an email address, or keep two, so one can
set the other's address to one that receives mail.

### Changing a role

Each row's **Role** column sets the instance role, **Administrator** or **Member**, at once, revoking the user's sessions: the only way to make an account, [OAuth](#oauth-google-github) ones included, an administrator. The **last remaining administrator cannot be demoted**.

## Disabling authentication

Set `PIWI_AUTH_ENABLED=false`, or remove the variable, and restart the server.

With authentication off, the dashboard answers only requests whose `Host` header names an IP address, `localhost`, a
name under `.localhost`, the host of [`PIWI_SITE_URL`](/reference/configuration#general) or a name `PIWI_ALLOWED_HOSTS`
lists (the service name a container or pod calls it by, such as `piwi`, `host.docker.internal`, or `.example.lan` for a whole domain); any other gets
a `403` that lists those addresses. A request with no `Host` comes from no browser and is answered. Over plain HTTP, a
write must also come from the requested host, `PIWI_SITE_URL`'s or a listed one. The entry `*` of `PIWI_ALLOWED_HOSTS`
turns the first check off, and with it the protection against DNS rebinding.

Behind a [reverse proxy](./deployment#reverse-proxy-https), set `PIWI_SITE_URL` and have the proxy
forward the browser's `Host` header (Apache: `ProxyPreserveHost On`): the check reads `Host` alone, never
`X-Forwarded-Host`, so a proxy that sends its own local address instead lets every request through.

## Related

- [Access, roles and groups](./project-access): project roles, groups and the permission grid
- [API keys](./api-keys): authenticating the reporter, CI and scripts
- [Production checklist](./production-checklist): the secrets, TLS and proxy settings to go with it
- [Configuration reference](/reference/configuration#authentication): every authentication and OAuth variable
