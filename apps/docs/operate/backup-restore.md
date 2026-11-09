---
title: Backup & restore
description: "What to back up for a Piwi instance, how to take a consistent copy of the database and storage, and how to restore it."
lang: en-US
---

# Backup & restore

Piwi's migrations are **forward-only** — once a new version has migrated your database, an older version will not run against it correctly. So a backup is not just insurance against disk loss; it is the *only* rollback path. Take one before every version bump.

## What to back up

The data lives in two places — back up both, together:

1. **The database** — the SQLite file `.data/piwi.db` (the default), or your PostgreSQL database.
2. **File storage** — `.data/storage/` (HTML reports, traces, attachments), unless you keep artifacts in [S3](./storage#s3-compatible-storage), in which case the bucket is your storage backup.

Keep the server's `PIWI_SECRET_KEY` as well, stored apart from the backups (a password manager, your secret store): the AI keys, SCM and Jira tokens and webhook secrets in the database are encrypted with it. Restored under another key, they cannot be read, and each must be entered again. `PIWI_AUTH_SECRET` only signs session cookies: a new one signs everyone out.

The two must be consistent with each other: a database row points at a stored trace, so a backup that captures one without the other can dangle. The simplest way to guarantee consistency is to stop the container before copying; the online methods below avoid the downtime.

## Backing up

::: code-group

```bash [SQLite (online, no downtime)]
# Consistent SQLite snapshot without stopping the server, plus the storage dir
sqlite3 .data/piwi.db ".backup '.data/piwi-backup.db'"
tar czf piwi-backup.tar.gz -C .data piwi-backup.db storage
```

```bash [PostgreSQL]
pg_dump "$PIWI_DATABASE_URL" > piwi-db.sql
tar czf piwi-storage.tar.gz -C .data storage   # skip if artifacts are in S3
```

```powershell [Windows (stop first)]
# Stop the container for a consistent copy, then archive .data
Compress-Archive -Path .data -DestinationPath piwi-backup.zip
```

:::

If artifacts are in S3, lean on the bucket's own durability and versioning rather than copying `.data/storage/`. Keep the database backup and the storage backup from the *same moment* so they agree.

## Restoring

Restoring is also how you roll back after an upgrade goes wrong — the rollback path is "restore your backup", never "pull the old tag" against an already-migrated database.

1. **Stop the container.**
2. **Restore the database and `.data/storage/`** from a backup pair taken at the same time. For SQLite, delete any leftover `.data/piwi.db-wal` and `.data/piwi.db-shm` files (the server runs SQLite in write-ahead-log mode, and a stale log would be replayed onto the restored file), put `piwi-backup.db` back as `.data/piwi.db` and unpack the storage archive; on a Linux host, hand the restored files back to the container's user with `sudo chown -R 1001:1001 .data`. For PostgreSQL, restore the dump into an empty database (`psql "$PIWI_DATABASE_URL" < piwi-db.sql`).
3. **Start the version the backup was taken on**, with the same `PIWI_SECRET_KEY`. A backup from version *N* must be restored under version *N* (or newer, which will migrate it forward) — not an older one.

Then confirm the running version at **Settings → About**, and that recent runs are present. See [Upgrading](./upgrading) for the full version-change story and the checks that tell you a migration landed.

## The desktop app

The [desktop build](/features/desktop) bundles its own server, and its database and storage live in a per-machine data directory *outside* the app bundle, migrated on first launch exactly as the server does — so the same forward-only rule applies. Back up that data directory before a major version jump; a newer build will migrate it, an older one cannot open it.

## When to back up

- **Before every version bump** — this is the one that matters, because it is the only rollback path.
- **On a schedule** matched to how much history you would hate to lose — nightly is plenty for most teams.
- Retention pruning deletes runs permanently; if you want a longer tail than your [retention window](./storage#data-retention) keeps, a periodic backup is where that history lives.

## Related

- [Upgrading](./upgrading) — forward-only migrations and verifying an upgrade
- [Deployment](./deployment) — the volume layout and resource sizing
- [Database](./database) — SQLite versus PostgreSQL
- [Storage → Data retention](./storage#data-retention) — what the nightly sweep prunes
