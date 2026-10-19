# Piwi Dashboard

**Your Playwright results, kept and explained.** CI throws away every report it makes. Piwi keeps them — then groups the failures by root cause, scores the flaky tests, and finds the locator you should have used. Self-hosted, zero telemetry.

📖 [Full documentation](https://piwitests.dev) · 🎮 [Live demo](https://piwitests.dev/demo/) · 💬 [GitHub](https://github.com/PiwiTests/platform)

> **Disclaimer:** Piwi Dashboard is not affiliated with, endorsed by, or connected to Microsoft Corporation.

---

## Quick start

```bash
# Linux / macOS
mkdir -p .data && sudo chown -R 1001:1001 .data # the container runs as non-root UID 1001
docker run -d --name piwi-dashboard -p 127.0.0.1:3000:3000 -v $(pwd)/.data:/app/.data phenx/piwitests-server:latest
```

```powershell
# Windows (PowerShell)
docker run -d --name piwi-dashboard -p 127.0.0.1:3000:3000 -v ${PWD}/.data:/app/.data phenx/piwitests-server:latest
```

Open `http://localhost:3000`. The SQLite database and file storage are created automatically inside `.data/`.

> **Reachable from this machine only.** With authentication off, the default, anyone who reaches the port is an administrator. Publish it on every interface (`-p 3000:3000`) only once [authentication](https://piwitests.dev/operate/authentication) is on.

> **Linux hosts:** without the `chown`, Docker auto-creates `.data` owned by `root` and the container (non-root UID 1001) can't write to it. Docker Desktop on Windows and macOS handles this for you.

Then point the [Playwright reporter](https://piwitests.dev/guide/reporter) at it — one `npm install` and four lines in `playwright.config.ts`, covered in the [getting started guide](https://piwitests.dev/guide/getting-started).

---

## Image details

| Property   | Value                              |
|------------|------------------------------------|
| Base image | `node:24-alpine`                   |
| Platforms  | `linux/amd64`, `linux/arm64`       |
| Image size | ~400 MB                            |
| Run as     | Non-root (`nodejs`, UID 1001)      |
| Data       | `/app/.data` — mount a volume here |

`/app/.data` holds `piwi.db` (the SQLite database, skipped when `PIWI_DATABASE_URL` is set) and `storage/` (HTML reports and trace files, skipped when S3 is configured). Mount it, or everything is lost when the container is re-created (on an upgrade, for example).

### Tags

| Tag | Description |
|-----|-------------|
| `latest` | Latest stable release |
| `MAJOR.MINOR.PATCH` | One exact release — pin this in production |
| `MAJOR.MINOR` | Latest patch of that minor |
| `MAJOR` | Latest release of that major |

The same multi-arch image is mirrored to the GitHub Container Registry as `ghcr.io/piwitests/platform`, which additionally carries an `edge` tag built from `main` (no release testing — not for production).

Read [Upgrading](https://piwitests.dev/operate/upgrading) before bumping a tag: migrations run automatically on startup and are **forward-only**, so rolling back means restoring a backup.

---

## Configuration

Piwi runs with **zero configuration** — set variables only to change a default. The full list, with defaults and which ones the Settings UI can override, is the [configuration reference](https://piwitests.dev/reference/configuration); the [configuration generator](https://piwitests.dev/reference/configuration/generator) builds a ready-to-paste `.env`, Compose, Kubernetes or systemd block in your browser.

The three worth knowing before you expose the container to a network:

| Variable | Why |
|----------|-----|
| `PIWI_AUTH_ENABLED` | Authentication is **off by default**. Set to `true` for anything beyond localhost — see [Authentication](https://piwitests.dev/operate/authentication). |
| `PIWI_AUTH_SECRET` | Signs session cookies. Required when auth is enabled. |
| `PIWI_SECRET_KEY` | Encrypts secrets stored in the database (AI keys, SCM tokens). Unset, saving any of them fails — set it in every deployment. |

Generate a value for the latter two with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

Beyond those: `PIWI_DATABASE_URL` switches to PostgreSQL, `PIWI_STORAGE_TYPE=s3` plus the `PIWI_S3_*` variables switch artifact storage to any S3-compatible service, and `PIWI_RETENTION_DAYS` turns on nightly pruning of old runs. Compose, Kubernetes, PostgreSQL, reverse-proxy and troubleshooting are in the [deployment guide](https://piwitests.dev/operate/deployment); S3-compatible storage is in [Storage](https://piwitests.dev/operate/storage) and backups in [Backup & restore](https://piwitests.dev/operate/backup-restore).

---

## License

FSL-1.1-MIT (fair source): free to use, self-host and modify, at work too; each release becomes MIT two years after it is published. See [License](https://piwitests.dev/guide/license) · [source code on GitHub](https://github.com/PiwiTests/platform)
