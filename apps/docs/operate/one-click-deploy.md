---
title: One-click deploy
description: "Stand up a Piwi instance on Railway, Render, Fly.io, Koyeb, Coolify or Dokploy from a template, and what to check before you rely on it."
lang: en-US
---

# One-click deploy

If you don't have a server to run Docker on, these templates stand up an instance on a hosting provider
instead. They all provision the same thing: **one container, one persistent volume mounted at
`/app/.data`, and authentication on**. Railway, Render and Coolify also generate `PIWI_SECRET_KEY`,
`PIWI_AUTH_SECRET` and `PIWI_SETUP_TOKEN`; on Fly.io and Koyeb you set them yourself. Beyond that, the difference is the provider's
own volume and pricing model.

The manifests are generated from the same variable registry as the
[configuration reference](/reference/configuration), so they can't drift from what the app actually reads.
The [configuration generator](/reference/configuration/generator) writes the same manifests for your own
choices of variables.

| Provider | How | Persistent volume | Notes |
|---|---|---|---|
| [Railway](#railway) | Button | Yes | Managed PostgreSQL available alongside |
| [Render](#render) | Button | Yes, on a paid instance | Repo-driven; only `PIWI_SITE_URL` is set by hand |
| [Fly.io](#fly-io) | `fly launch` | Yes | One command rather than a button; cheapest always-on option |
| [Koyeb](#koyeb) | Button | Volume attached afterwards | Starts once you set its secrets; see the warning below |
| [Coolify / Dokploy](#coolify-dokploy) | Paste a Compose file | Yes | Onto a server you already own |

Not supported as one-click: **Vercel, Netlify and DigitalOcean App Platform** have no persistent disk, so
Piwi would need PostgreSQL *and* a bring-your-own [S3 bucket](./storage#s3-compatible-storage), at which
point it isn't one click. [Deploy it](./deployment) to a machine with Docker instead.

## Railway

Railway publishes templates from its own dashboard rather than from a file in this repository, so the
template's exact contents live in
[`deploy/railway/template.md`](https://github.com/PiwiTests/platform/blob/main/deploy/railway/template.md)
and the repo ships a [`railway.json`](https://github.com/PiwiTests/platform/blob/main/railway.json) pinning
the health check to `/api/health` and the replica count to 1.

<!-- Replace with the published template URL once the template is live on Railway. -->
> **No button yet.** Until the template is published on Railway, create a service from the
> `phenx/piwitests-server:latest` image, add a volume mounted at `/app/.data`, and copy the variables from
> `deploy/railway/template.md`.

Railway injects `PORT`, which the image honors.

## Render

Render reads [`render.yaml`](https://github.com/PiwiTests/platform/blob/main/render.yaml) straight from the
repository, so the button is genuinely one click:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/PiwiTests/platform)

The blueprint asks for a **paid instance type**, deliberately: Render's free web services have no disk, and
without one the database and every stored trace are discarded on each redeploy. It also sets
`autoDeploy: false` so pushes to this repository don't redeploy your instance.

Set `PIWI_SITE_URL` to the service's public URL after the first deploy, so email links and OAuth callbacks
point at the right origin.

## Fly.io

Fly has no browser button, but [`fly.toml`](https://github.com/PiwiTests/platform/blob/main/fly.toml) makes
it one command plus the secrets:

::: code-group

```bash [Linux / macOS]
fly launch --no-deploy   # accepts the committed fly.toml
fly secrets set PIWI_SECRET_KEY=$(openssl rand -hex 32) PIWI_AUTH_SECRET=$(openssl rand -hex 32) PIWI_SETUP_TOKEN=$(openssl rand -hex 32)
fly deploy
fly ssh console -C "printenv PIWI_SETUP_TOKEN"   # the first-admin form asks for it
```

```powershell [Windows (PowerShell)]
fly launch --no-deploy   # accepts the committed fly.toml
$key = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$auth = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$setup = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
fly secrets set PIWI_SECRET_KEY=$key PIWI_AUTH_SECRET=$auth PIWI_SETUP_TOKEN=$setup
fly deploy
$setup   # the first-admin form asks for it
```

:::

If `fly launch` picks a different app name because yours is taken, update `PIWI_SITE_URL` in `fly.toml` to
match. Autoscaling is deliberately off (`auto_stop_machines = false`, `min_machines_running = 1`): the
notification and retention sweeps run in-process, so a suspended machine silently stops doing scheduled work.

## Koyeb

Koyeb carries the whole service definition in the URL, so nothing needs to be in the repository:

[![Deploy to Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?type=docker&image=docker.io/phenx/piwitests-server:latest&name=piwi&instance_type=small&regions=fra&ports=3000;http;/&env[PIWI_AUTH_ENABLED]=true)

> **The button alone gives you an ephemeral disk.** Koyeb volumes can't be attached from a deploy URL, so
> until you attach one, the database and every stored trace are lost on redeploy. Volumes are region-scoped
> and only standard (not free or eco) instances can mount them:
>
> ```bash
> koyeb volumes create piwi-data --region fra --size 10
> koyeb service update piwi/piwi --volumes piwi-data:/app/.data
> koyeb service update piwi/piwi --checks 3000:http:/api/health
> ```

Set `PIWI_SECRET_KEY`, `PIWI_AUTH_SECRET`, `PIWI_SETUP_TOKEN` and `PIWI_SITE_URL` in the Koyeb console after the first deploy,
because the URL can't generate secrets. With authentication on, the service refuses to start until
`PIWI_AUTH_SECRET` is set. The full command list is kept in
[`deploy/koyeb-deploy-url.txt`](https://github.com/PiwiTests/platform/blob/main/deploy/koyeb-deploy-url.txt).

## Coolify / Dokploy

Both consume a Compose file, so one stack covers them. In Coolify: **Add a new resource → Service →**
paste [`deploy/coolify/docker-compose.yml`](https://github.com/PiwiTests/platform/blob/main/deploy/coolify/docker-compose.yml).
It uses Coolify's magic variables, so the domain and the secrets are generated for you and Traefik routing
and TLS are wired up automatically.

## Before you rely on any of them

- **One instance, always.** Don't scale the service past a single replica. SQLite requires it, and even on
  PostgreSQL the SSE event bus and the cron sweeps are in-process.
- **Budget disk by retention.** Traces and HTML reports dominate: roughly 50–200 MB per run with traces
  enabled. The templates ask for 10 GB; raise it, or set `PIWI_RETENTION_DAYS`, before you fill it.
- **Check the platform's request body limit and response buffering.** Trace and report uploads reach
  hundreds of MB, and live runs use long-lived `text/event-stream` responses; see
  [Reverse proxy (HTTPS)](./deployment#reverse-proxy-https) for what a proxy must allow.
- **Finish the auth setup.** These templates set `PIWI_AUTH_ENABLED=true`, so the first visit shows a
  **Create the first admin account** form. It asks for `PIWI_SETUP_TOKEN`, which the templates generate (read it in
  the platform's environment settings; on Fly.io and Koyeb you set it yourself), so nobody else can create the
  administrator. Complete it before sharing the URL, or provision the admin from a script as
  [Authentication → Initial setup](./authentication#initial-setup) shows.
- **Work down the [production checklist](./production-checklist).** The templates already turn
  authentication on (and, except on Fly.io and Koyeb, generate the secrets); pinning a version and backups
  are still yours to do.

## Related

- [Deployment](./deployment): Docker, Compose, Kubernetes and npx on a machine you run
- [Production checklist](./production-checklist): what to set before anyone else can reach the instance
- [Configuration generator](/reference/configuration/generator): the same manifests, with your own variables
- [Upgrading](./upgrading): pinning a tag and moving to a new one
