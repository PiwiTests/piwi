---
title: Database
description: "SQLite by default or PostgreSQL for a shared instance, how to switch between them, and where retention and backups are covered."
lang: en-US
---

# Database

Piwi stores runs, test cases, executions, clusters and settings in a relational database. Two backends
are supported: **SQLite** (the default, zero configuration) and **PostgreSQL** (for multi-user or
high-concurrency deployments). Both are exercised by the project's CI on every commit, and migrations
run automatically on startup either way.

Test artifacts — HTML reports, traces, attachments — do **not** live here; they go to
[file storage](./storage).

## SQLite (default)

Nothing to configure. The database file is created at `.data/piwi.db` when the server starts, inside the
directory you mounted as `/app/.data` (container) or the working directory you ran from (`npx`).

Set `PIWI_DATABASE_PATH` to put it somewhere else. Its directory must already exist — Piwi creates `.data/`
itself only when `PIWI_DATABASE_PATH` is unset:

::: code-group

```bash [Docker]
docker run -p 127.0.0.1:3000:3000 -v $(pwd)/.data:/app/.data -e PIWI_DATABASE_PATH=/app/.data/custom.db phenx/piwitests-server:latest
```

```bash [.env]
PIWI_DATABASE_PATH=/custom/path/database.db
```

:::

SQLite allows one writer at a time. Piwi queues its own writes, and waits up to 5 seconds for a lock
held by another process (a script, a second server). That is ample for a team's test volume — a run
submission is a short burst of writes — but if you run several dashboard replicas against one
database, or see `database is locked` under load, move to PostgreSQL.

## PostgreSQL

Set `PIWI_DATABASE_URL` and Piwi uses PostgreSQL instead of SQLite, creating and migrating every table
on startup. PostgreSQL **14+**.

```bash
PIWI_DATABASE_URL=postgresql://user:password@localhost:5432/piwi_dashboard
```

`PIWI_DATABASE_PATH` is ignored while `PIWI_DATABASE_URL` is set. A ready-to-run Compose stack with a
`postgres:17-alpine` service is in the
[deployment guide](./deployment#docker-compose-with-postgresql).

To try it locally against a throwaway server:

```bash
docker run -d -p 5432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=piwi_dashboard postgres:17-alpine
```

## Switching backends

There is **no migration path between SQLite and PostgreSQL** — pointing an instance at a new backend
gives you an empty dashboard, not a converted one. Switch before you accumulate history you care
about, or accept starting fresh. Your file storage is unaffected either way.

## Retention and backups

- **Retention** — the nightly sweep prunes runs older than `PIWI_RETENTION_DAYS`, off by default. See
  [Data retention](./storage#data-retention).
- **Backups** — SQLite has an online-consistent backup recipe, PostgreSQL uses `pg_dump`. Both, plus
  what to copy alongside the database, are in [Backup & restore](./backup-restore).
- **Upgrades apply migrations automatically and they are forward-only.** Read
  [Upgrading](./upgrading) before bumping a version tag.

## Related
- [Configuration reference](/reference/configuration#database) — every `PIWI_DATABASE_*` and retention variable
- [Storage & retention](./storage) — where reports, traces and attachments go
- [Deployment](./deployment) — Compose and Kubernetes, and [one-click deploy](./one-click-deploy) templates
- Changing the schema is a contributor task, not an operator one:
  [CONTRIBUTING.md](https://github.com/PiwiTests/platform/blob/main/CONTRIBUTING.md)
