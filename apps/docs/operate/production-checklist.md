---
title: Production checklist
description: "What to set before anyone else can reach a Piwi instance: authentication, secrets, TLS, proxy trust, persistent data and a pinned version."
lang: en-US
---

# Production checklist

A fresh Piwi instance starts as an **open dashboard with authentication off** — right for localhost, wrong for a network. This is the one page that lists what to set before anyone else can reach it. Work down it before you put an instance on a shared address; the detail links go to the pages that explain each step.

## Before you expose it

1. **Turn authentication on.** Set `PIWI_AUTH_ENABLED=true` and a strong `PIWI_AUTH_SECRET` (session-cookie signing key). The server refuses to start with auth enabled and no secret, so this can't half-apply. Then create the first administrator account before you share the URL. See [Authentication](./authentication).
2. **Set the encryption key.** Set `PIWI_SECRET_KEY` so the credentials you store in the dashboard — AI API keys, SCM tokens, webhook secrets — are encrypted with **your** key. Unset, the dashboard refuses to save them. Generate either secret with:

   <<< @/snippets/secret.sh{bash}

3. **Terminate TLS.** Always put the dashboard behind an HTTPS reverse proxy. Mind the two things a proxy gets wrong by default: **upload size** (trace and report uploads reach hundreds of MB) and **SSE buffering** (live runs and browser notifications use long-lived `text/event-stream` responses that must not be buffered). With authentication on, browser sign-in needs HTTPS in any case: the session cookie is `Secure`, so over plain `http://` it only works on `localhost`. See [Deployment → Reverse proxy (HTTPS)](./deployment#reverse-proxy-https).
4. **Tell Piwi it's behind a proxy.** Set `PIWI_TRUST_PROXY=true` so the per-client rate limits on the auth endpoints key on the real client address from `X-Forwarded-For` instead of pooling every request into the proxy's one address. Leave it off when clients connect directly — see the [configuration reference](/reference/configuration#authentication).
5. **Persist and back up the data.** Mount `/app/.data` (or your configured database and storage paths) on a persistent volume, and set up a backup before you accumulate history you care about. See [Backup & restore](./backup-restore).
6. **Pin a version.** Running `latest` lets an unattended `docker pull` move you across a breaking change. Pin an exact tag and bump it deliberately — migrations are forward-only, so the rollback path is *restore a backup*, not "pull the old tag." See [Upgrading](./upgrading).

Never leave the built-in development secrets in place on a real deployment.

## What Piwi already does for you

The defaults are conservative, so the checklist above is short. Without any extra work:

- The container runs as a **non-root** user (`nodejs`, UID 1001).
- Passwords are hashed with **scrypt** and per-password salts; login, initial-setup and password-reset endpoints are **rate-limited** per client address (and failed logins per account), returning `429` with `Retry-After`.
- **API keys** are stored only as SHA-256 hashes and shown once, at creation — a leaked database yields no usable key.
- No other site can frame the dashboard: every response carries `X-Frame-Options: SAMEORIGIN` and
  `frame-ancestors 'self'`. Status badges and report charts are images, so a README or a wiki still shows them.
- Secrets supplied by **environment variable** are never written to the database and never returned by the API; the settings UI shows them read-only with a lock badge.
- Stored credentials are encrypted with **AES-256-GCM** once `PIWI_SECRET_KEY` is set.
- Database **migrations are forward-only** and run on startup, before any request reaches the database; if one fails, every database call fails and `/api/health` returns `503` rather than serving a half-migrated schema.

## Optional, and worth a thought

- **Public share links** are off by default (`PIWI_SHARE_LINKS_ENABLED`). If you turn them on, know that anyone with the link sees the execution or cluster without signing in — see [Share links](/features/share-links).
- **Retention.** Automatic pruning is opt-in; set `PIWI_RETENTION_DAYS` to cap how much run history you keep. See [Storage → Data retention](./storage#data-retention).

## Related

- [Authentication](./authentication) — roles, sign-in and OAuth
- [API keys](./api-keys) — how CI and scripts sign in once authentication is on
- [Deployment](./deployment) — the reverse proxy and the full install
- [Backup & restore](./backup-restore) — what to copy, and how to restore it
- [Privacy & data flow](/guide/privacy) — what is stored, and secrets at rest
- [Configuration reference](/reference/configuration) — every `PIWI_*` variable
- [Security policy](https://github.com/PiwiTests/piwi/blob/main/SECURITY.md) — reporting a vulnerability
