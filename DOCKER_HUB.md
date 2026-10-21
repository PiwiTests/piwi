# Piwi Dashboard

**Your Playwright results, kept and explained.** CI throws away every report it makes. Piwi keeps them, every run, trace and HTML report, then groups the failures by root cause, scores the flaky tests, and finds the locator you should have used. Self-hosted, zero telemetry.

📖 [Documentation](https://piwitests.dev) · 🎮 [Live demo](https://piwitests.dev/demo/) · 🚀 [Deployment guide](https://piwitests.dev/operate/deployment) · 💬 [Source and releases on GitHub](https://github.com/PiwiTests/platform)

![The Piwi dashboard, light and dark: every project's health, the failing ones first, and the live activity across them](https://piwitests.dev/screenshots/home.png)

Everything in the image serves four jobs: **keep the history** every CI run deletes, **explain the failures** (forty red tests become the three root causes behind them, each flaky test gets a score and the CI minutes it wastes), **hand back a fix** (ranked replacement locators from the last passing run, and an optional AI diagnosis read against your git diff) and **find what your tests miss**. [What Piwi does](https://piwitests.dev/guide/what-piwi-does) has the whole picture.

> **Disclaimer:** Piwi Dashboard is not affiliated with, endorsed by, or connected to Microsoft Corporation. Playwright is a trademark of Microsoft Corporation.

---

## Run it

```bash
# Linux / macOS
mkdir -p .data && sudo chown -R 1001:1001 .data # the container runs as non-root UID 1001
docker run -d --name piwi -p 127.0.0.1:3000:3000 -v $(pwd)/.data:/app/.data phenx/piwitests-server:latest
```

```powershell
# Windows (PowerShell)
docker run -d --name piwi -p 127.0.0.1:3000:3000 -v ${PWD}/.data:/app/.data phenx/piwitests-server:latest
```

Open `http://localhost:3000`. The SQLite database and the file storage are created inside `.data/` on the first request; nothing to configure.

> **Reachable from this machine only.** With authentication off, the default, anyone who reaches the port is an administrator. Publish it on every interface (`-p 3000:3000`) only once [authentication](https://piwitests.dev/operate/authentication) is on.

> **Linux hosts:** without the `chown`, Docker creates `.data` owned by `root` and the container (non-root UID 1001) cannot write to it. Docker Desktop on Windows and macOS handles this for you ([details](https://piwitests.dev/operate/deployment#permission-issues-with-volumes)).

Then connect a Playwright project in one command, and run it:

```bash
npx @piwitests/reporter init --server-url http://localhost:3000 --project my-project
npx playwright test
```

`init` installs the reporter, wraps your `playwright.config` and adds the capture fixtures; the run streams into the dashboard while it executes. [Getting started](https://piwitests.dev/guide/getting-started) covers the rest, [Reporter](https://piwitests.dev/guide/reporter) the manual setup.

With Compose, the same thing is the [`docker-compose.yml`](https://github.com/PiwiTests/platform/blob/main/docker-compose.yml) of the repository, with the PostgreSQL variant commented in place:

```yaml
services:
  piwi:
    image: phenx/piwitests-server:latest
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - ./.data:/app/.data
    restart: unless-stopped
```

Kubernetes manifests and the one-click hosts are in the [deployment guide](https://piwitests.dev/operate/deployment#kubernetes).

---

## The image

| Property | Value |
|---|---|
| Base image | `node:24-alpine`, pinned by digest |
| Platforms | `linux/amd64`, `linux/arm64` |
| Size | about 400 MB |
| Runs as | non-root (`nodejs`, UID 1001) |
| Port | `3000` (`PORT` changes it) |
| Data | `/app/.data`: mount a volume here |
| Health check | `GET /api/health` every 30 s, which also verifies the database |
| Footprint | about 300 MB of RAM idle, 1 vCPU; disk follows the traces and reports, 50 to 200 MB per run ([resource requirements](https://piwitests.dev/operate/deployment#resource-requirements)) |

`/app/.data` holds `piwi.db` (the SQLite database, unused once `PIWI_DATABASE_URL` points at PostgreSQL) and `storage/` (HTML reports and traces, unused once S3 is configured). Mount it, or everything is lost when the container is re-created, on an upgrade for example.

### Tags

| Tag | Description |
|---|---|
| `latest` | Latest stable release |
| `MAJOR.MINOR.PATCH` | One exact release: pin this in production |
| `MAJOR.MINOR` | Latest patch of that minor |
| `MAJOR` | Latest release of that major |

The same multi-arch image is mirrored to the GitHub Container Registry as `ghcr.io/piwitests/platform`, which additionally carries an `edge` tag built from `main` (no release testing: not for production).

---

## Before you expose it

The command above gives you an open dashboard with authentication off, which is fine on localhost and not fine on a network. Three things to set before anyone else can reach it:

| Variable | Why |
|---|---|
| `PIWI_AUTH_ENABLED=true` | Turns on accounts and roles ([authentication](https://piwitests.dev/operate/authentication)) |
| `PIWI_AUTH_SECRET` | Signs the session cookies; required once authentication is on |
| `PIWI_SECRET_KEY` | Encrypts the credentials stored in the database (AI keys, SCM tokens). Unset, the dashboard refuses to save them: set it in every deployment |

Generate a value for either secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Put HTTPS in front with a [reverse proxy](https://piwitests.dev/operate/deployment#reverse-proxy-https). The full list, with the trust-proxy flag, backups and version pinning, is the [production checklist](https://piwitests.dev/operate/production-checklist).

---

## Configuration

Piwi runs with **zero configuration**: set a variable only to change a default. The full list, with each default and whether the Settings UI can override it, is the [configuration reference](https://piwitests.dev/reference/configuration); the [configuration generator](https://piwitests.dev/reference/configuration/generator) builds a ready-to-paste `.env`, Compose, Kubernetes or systemd block in your browser.

Beyond the three above: `PIWI_DATABASE_URL` switches to PostgreSQL, `PIWI_STORAGE_TYPE=s3` plus the `PIWI_S3_*` variables move the reports and traces to any S3-compatible service ([storage](https://piwitests.dev/operate/storage)), and `PIWI_RETENTION_DAYS` turns on nightly pruning of old runs. Backups are in [Backup & restore](https://piwitests.dev/operate/backup-restore).

---

## Upgrading

Pin a version tag and keep a backup of `.data/`. Migrations run automatically on startup and are **forward-only**: rolling back means restoring a backup, not pulling the old tag. Read [Upgrading](https://piwitests.dev/operate/upgrading) before bumping a tag. Piwi is pre-1.0: a minor release can carry breaking changes.

---

## License

FSL-1.1-MIT (fair source): free to use, self-host and modify, at work too; each release becomes MIT two years after it is published. See [License](https://piwitests.dev/guide/license) · [source code on GitHub](https://github.com/PiwiTests/platform)
