---
title: Deployment
description: "Run Piwi Dashboard with Docker, Docker Compose, Kubernetes, npx or a one-click host (Railway, Render, Fly.io, Koyeb, Coolify), then add health checks and HTTPS through a reverse proxy."
lang: en-US
---

# Deployment

Piwi is one Node.js server with its data in one directory. Run it as a Docker container (recommended), with Docker Compose, on Kubernetes or with `npx`, then put an HTTPS proxy in front of it.

## Docker (recommended)

### Quick start

::: code-group

<<< @/snippets/docker-run.sh [Linux / macOS]

<<< @/snippets/docker-run.ps1 [Windows (PowerShell)]

:::

The dashboard will be available at `http://localhost:3000`.

> **Linux hosts:** without the `chown`, Docker auto-creates `.data` owned by `root` and the container (non-root UID 1001) can't write to it. Docker Desktop on Windows/macOS handles this automatically. See [Permission issues with volumes](#permission-issues-with-volumes) if you hit a permission error.

### Registries

The same multi-arch image is published to two registries; use whichever your organization prefers:

::: code-group

```bash [Docker Hub]
docker pull phenx/piwitests-server:latest
```

```bash [GHCR]
docker pull ghcr.io/piwitests/platform:latest
```

:::

GHCR additionally carries an **`edge`** tag rebuilt from every push to `main`. It's useful for trying a
fix before its release; don't run it in production: it has had no release testing and can change under you.

### Available tags

| Tag | Description | Docker Hub | GHCR |
|-----|-------------|:---:|:---:|
| `latest` | Latest stable release | ✅ | ✅ |
| `MAJOR.MINOR.PATCH` | One exact release (e.g. `0.26.1`) | ✅ | ✅ |
| `MAJOR.MINOR` | Latest patch of that minor (e.g. `0.25`) | ✅ | ✅ |
| `MAJOR` | Latest release of that major (e.g. `0`) | ✅ | ✅ |
| `edge` | Built from every push to `main` | — | ✅ |

Pin a specific version in production, and read [Upgrading](./upgrading) before you bump it, because
migrations are forward-only. Browse the published tags on
[Docker Hub](https://hub.docker.com/r/phenx/piwitests-server/tags) or
[GHCR](https://github.com/PiwiTests/platform/pkgs/container/platform).

### Image details

| Property | Value |
|----------|-------|
| Base image | `node:24-alpine`, pinned by digest |
| Image size | ~400 MB |
| Platforms | `linux/amd64`, `linux/arm64` |

### Volumes

Everything the server keeps lives under `/app/.data`, the volume the quick start mounts: the SQLite database
(`piwi.db`) and file storage (`storage/`, HTML reports and traces). Mount it on persistent storage, or point the
[database](./database) and [storage](./storage) elsewhere.

### Environment variables

The server reads three process-level variables directly:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Set automatically |
| `HOST` | `0.0.0.0` | Listen on all interfaces. The Docker image sets `NITRO_HOST=0.0.0.0`, which takes precedence — override the bind address there with `NITRO_HOST`. `npx @piwitests/server` defaults to `127.0.0.1` |
| `PORT` | `3000` | Application port |

Everything else is a `PIWI_*` variable, listed with its default and whether the Settings UI can override it in the generated [configuration reference](/reference/configuration). The [configuration generator](/reference/configuration/generator) turns your choices into a ready-to-paste block from the same registry.

## One-click deploy

No server to run Docker on? Templates for Railway, Render, Fly.io, Koyeb and Coolify / Dokploy stand up the same
single container with a persistent volume and authentication on. [One-click deploy](./one-click-deploy) covers each
provider and what to check before you rely on it.

## Docker Compose

The repository ships a ready-to-use [`docker-compose.yml`](https://github.com/PiwiTests/platform/blob/main/docker-compose.yml) with commented options (secret key, auth, PostgreSQL). Minimal version:

```yaml
services:
  piwi-dashboard:
    image: phenx/piwitests-server:latest
    ports:
      - "127.0.0.1:3000:3000" # "3000:3000" once authentication is on
    volumes:
      - ./.data:/app/.data
    restart: unless-stopped
```

Run with:

```bash
docker compose up -d
```

### Docker Compose with PostgreSQL

For production deployments requiring a robust relational database:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: piwi
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: piwi
    volumes:
      - pg-data:/var/lib/postgresql/data
    restart: unless-stopped

  piwi-dashboard:
    image: phenx/piwitests-server:latest
    ports:
      - "127.0.0.1:3000:3000" # "3000:3000" once authentication is on
    volumes:
      - ./.data:/app/.data   # still used for report/trace file storage
    environment:
      - PIWI_DATABASE_URL=postgresql://piwi:change-me@postgres:5432/piwi
    depends_on:
      - postgres
    restart: unless-stopped

volumes:
  pg-data:
```

Run with:

```bash
docker compose up -d
```

## Kubernetes

Example deployment manifest:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: piwi-dashboard
spec:
  replicas: 1
  strategy:
    type: Recreate   # never two pods at once, not even during a rollout
  selector:
    matchLabels:
      app: piwi-dashboard
  template:
    metadata:
      labels:
        app: piwi-dashboard
    spec:
      containers:
      - name: piwi-dashboard
        image: phenx/piwitests-server:latest
        ports:
        - containerPort: 3000
        readinessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 20
          periodSeconds: 30
        volumeMounts:
        - name: data
          mountPath: /app/.data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: piwi-dashboard-data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: piwi-dashboard-data
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: piwi-dashboard
spec:
  selector:
    app: piwi-dashboard
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer
```

## npm / npx (quick local run)

For a quick local run without Docker, the server is published to npm as
[`@piwitests/server`](https://www.npmjs.com/package/@piwitests/server). It bundles the
prebuilt server and needs only **Node.js 22+**:

```bash
npx @piwitests/server
```

The dashboard will be available at `http://localhost:3000`.

The server creates the same `.data/` layout **in the current working directory**, so run the command from the
same directory each time to keep your data. It reads the same environment variables as the Docker image; for
example, to change the port:

::: code-group

```bash [Linux / macOS]
PORT=8080 npx @piwitests/server
```

```powershell [Windows (PowerShell)]
$env:PORT='8080'; npx @piwitests/server
```

:::

It listens on `127.0.0.1` only, so other machines cannot reach it: with authentication off, the default, anyone who
reaches the port is an administrator. To serve other machines, turn [authentication](./authentication) on and set
`HOST=0.0.0.0`.

Docker remains the recommended path for production: it ships a pinned Node runtime, runs as a non-root user and
isolates the environment.

## Health checks

`GET /api/health` verifies database connectivity and returns `200 {"status":"ok","database":"ok"}` when healthy, `503 {"status":"error","database":"unreachable"}` otherwise — use it for load-balancer targets, uptime monitors, and container orchestration. The Docker image ships a built-in `HEALTHCHECK` against it, so `docker ps` shows `healthy`/`unhealthy` out of the box. The version endpoint additionally reports the running version and database backend ([Upgrading](./upgrading#verifying-the-upgrade-landed)).

## Reverse proxy (HTTPS)

Always put a TLS-terminating reverse proxy in front of the dashboard for anything beyond localhost. Two working examples — mind the **upload size** (trace/report uploads can reach hundreds of MB) and **SSE streaming** (live runs and browser notifications use long-lived `text/event-stream` responses that must not be buffered).

**Caddy** (automatic HTTPS):

```text
piwi.example.com {
    reverse_proxy localhost:3000
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name piwi.example.com;

    # ssl_certificate     /etc/letsencrypt/live/piwi.example.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/piwi.example.com/privkey.pem;

    client_max_body_size 500m;   # trace + report uploads

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Live streaming + notifications use Server-Sent Events:
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

When auth is enabled, set `PIWI_SITE_URL` to the public HTTPS URL so email links and OAuth callbacks point at the right origin, and set `PIWI_TRUST_PROXY=true` (step 4 of the [production checklist](./production-checklist#before-you-expose-it)).

## Resource requirements

Piwi is a single Node.js process and runs comfortably on small machines:

| Deployment | Guideline |
|---|---|
| RAM | ~300 MB idle; 1 GB is comfortable headroom for large uploads and AI diagnosis |
| CPU | 1 vCPU is enough for a team; ingest is I/O-bound |
| Disk | The real variable — traces and HTML reports dominate. Budget by retention: e.g. ~50–200 MB per run with traces enabled. Prune old runs from **Settings → Storage** |
| Scaling | Run a single replica. SQLite requires it; with PostgreSQL the SSE event bus is still in-process, so keep one instance |

## Security

Before you put an instance on a shared address, work down the [production checklist](./production-checklist).

## Troubleshooting

### Permission issues with volumes

On **Linux hosts**, the bind-mounted directory must be writable by the container's UID 1001:

```bash
mkdir -p .data
sudo chown -R 1001:1001 .data   # match the container's non-root UID 1001
docker run -p 127.0.0.1:3000:3000 -v $(pwd)/.data:/app/.data phenx/piwitests-server:latest
```

> On Windows and macOS, Docker Desktop manages volume permissions automatically — no `chown` is needed. Just run the container with `-v ${PWD}/.data:/app/.data` (PowerShell).

### Database locked

SQLite doesn't support concurrent writes well. For high-concurrency deployments, run a single instance or switch to PostgreSQL by setting `PIWI_DATABASE_URL`.

### Port already in use

Map to a different host port:

::: code-group

```bash [Linux / macOS]
docker run -p 8080:3000 -v $(pwd)/.data:/app/.data phenx/piwitests-server:latest
```

```powershell [Windows (PowerShell)]
docker run -p 8080:3000 -v ${PWD}/.data:/app/.data phenx/piwitests-server:latest
```

:::

The dashboard will be available at `http://localhost:8080`.

## Related

- [One-click deploy](./one-click-deploy): templates for hosting providers
- [Production checklist](./production-checklist): what to set before anyone else can reach the instance
- [Backup & restore](./backup-restore): what to copy, and how to restore it
- [Upgrading](./upgrading): moving to a new version
