---
title: Upgrading
description: "What happens when a new Piwi version starts, how to upgrade safely, why there is no downgrade, and what to do when an upgrade goes wrong."
lang: en-US
---

# Upgrading

Piwi is pre-1.0. Patch and minor releases can carry breaking changes, and the database schema moves
with them. Upgrading is normally a one-line change — but it's a one-way door, so it's worth knowing
what happens before you pull a new tag.

## The short version

1. Read the [changelog](https://github.com/PiwiTests/piwi/blob/main/CHANGELOG.md) for the versions
   you're skipping, looking for **⚠ BREAKING CHANGES**.
2. **Back up** the database and file storage ([how](./backup-restore)).
3. Pull the new tag and restart.
4. Check the logs for `migrations completed successfully`, then confirm the version at
   **Settings → About**.

## What happens when a new version starts

On boot, before any request can touch the database (requests that need it wait for these steps):

1. **Database migrations run automatically** — SQLite or PostgreSQL, whichever you're on. There is no
   separate migrate command and nothing to run by hand. Before migrating, Piwi compares the migrations
   the database has recorded with the ones this version ships (see
   [A database that ran another build](#a-database-that-ran-another-build)).
2. **Failure clusters are re-fingerprinted** if the fingerprint algorithm changed in this release.
   This is non-destructive: existing clusters are updated in place, and clusters that now collide are
   merged rather than dropped, so your triage statuses and notes survive.

Step 2 logs an error and continues if it fails. **Step 1 does not.** If a migration fails, the
process keeps running but every database call fails with the migration error and `GET /api/health`
returns `503`, so the container reports unhealthy — nothing is served against a half-migrated schema.
That's deliberate: a loud failure you can restore from beats silent corruption.

On the upgrade that adds project roles, a migration turns each Reporter account into a Member with the Maintainer role
on the projects it could open, and each User account into a Member with the Viewer role, so nobody gains or loses a
right (see [Upgrading from the three roles](./project-access#upgrading-from-the-three-roles)). A database from before
project access existed gets the same roles on all projects, as that upgrade granted.

On the upgrade that makes email addresses unique ignoring case, a migration first looks for users whose addresses
differ only by letter case (`Bob@corp.com` and `bob@corp.com`), such as a second account an OAuth sign-in created for
someone who already had one. Piwi never merges accounts on its own: if it finds any, the migration fails like any
other (see above) with an error that says so, lists the user ids on PostgreSQL, and changes nothing. Fix it in the
database, then restart:

```sql
-- The users that share an address
SELECT id, username, email FROM users
WHERE lower(email) IN (SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1);

-- For every user but one of each address
UPDATE users SET email = NULL, email_verified = 0 WHERE id = <id>;
```

When one is an account an OAuth sign-in created by mistake, clear its address, then delete it from **Settings →
Users** once the server runs: the person's next sign-in with that provider links their original account, if it verified
its address.

The same upgrade refuses invite, password reset and verification links emailed before it: send them again.

## A database that ran another build

Releases only ever add migrations, in date order. A database that also ran a build from outside the
releases (a development branch, a preview image) can hold migrations this version does not ship, and
be missing some it does. On startup Piwi logs `The migration history of this database does not match
this build`, lists what differs, and repairs it in a single transaction:

- the migrations the database lacks are applied, including any dated before the latest one it ran;
- tables, columns, indexes and constraints the other build already created are kept, completed with
  the columns this version declares, and indexes are rebuilt from this version's definition;
- a unique index this version does not declare is dropped, since it would reject rows Piwi writes;
- the result is checked against the schema this version expects, then the migrations the other build
  recorded are removed from the history.

The log ends with `Migration history repaired` and the next start is a normal one. If the result would
still differ from the expected schema — a column only the other build has, `NOT NULL` without a
default, for instance — nothing is changed, and it fails like any migration (see above) with `Migration
history repair failed` and the difference it found: restore a backup, or start from an empty database.

A database that is only **ahead** of this version, as after starting an older version on it, gets a
single warning, `applied migration(s) are not in this build`, and nothing else: see below.

## Downgrading is not supported

Migrations are **forward-only** — there are no down migrations. Once a new version has migrated your
database, an older version will not run against it correctly, and starting one may make things worse.

So the rollback path is not "pull the old tag", it's **restore your backup**:

1. Stop the container.
2. Restore the database and `.data/storage/` from the backup you took before upgrading.
3. Start the previous version's tag.

This is the entire reason step 2 of the short version isn't optional.

## Pin a version

Running `latest` in production means an unattended `docker pull` can move you across a breaking change.
Pin the exact version and bump it deliberately:

```yaml
# docker-compose.yml
services:
  piwi:
    image: phenx/piwitests-server:0.26.1   # not :latest
```

The available tag patterns — and the GHCR mirror — are in
[Deployment → Available tags](./deployment#available-tags).

## Verifying the upgrade landed

Three ways, in increasing order of automation:

- **Settings → About** shows the running version, the build SHA, the Node.js version the server was
  built with, and which database backend is active.
- The version endpoint returns the version, build SHA and database backend as JSON, along with the
  Node.js version actually running — no authentication required:

  ```bash
  curl -s http://localhost:3000/api/version
  ```

- `GET /api/health` is the readiness probe — it verifies database connectivity and returns 503 when
  the database isn't reachable, which is what you want a container orchestrator watching.

In the startup logs, the lines worth grepping for are `Running <dialect> migrations from …` and
`migrations completed successfully` — plus `Migration history repaired` after a
[repair](#a-database-that-ran-another-build).

## Upgrading the reporter

The reporter and the dashboard version independently, and you do **not** have to upgrade them in
lockstep:

- A **newer reporter against an older server** degrades gracefully — if the server doesn't understand
  streaming, the reporter falls back to batch submission on its own.
- An **older reporter against a newer server** keeps working; wire fields are added, not repurposed.

That said, features land in pairs. Locator healing needs both a reporter that captures snapshots and a
server that ranks them, so if a new capability doesn't appear, matching the two versions is the first
thing to try.

```bash
npm install --save-dev @piwitests/reporter@latest
```

## Upgrading the desktop app

The [desktop build](/features/desktop) bundles its own server, so installing a newer build upgrades both. Its
database lives outside the app bundle and is migrated on first launch, exactly as the server does —
which means the same forward-only rule applies. Back up its data directory before a major jump.
On Windows an in-app update closes the app as soon as the download finishes and hands over to the
installer, which reopens it when done. The `.exe` installer runs without a window; the `.msi` one shows a
progress bar.

## If an upgrade goes wrong

**The container is unhealthy after upgrading** (`/api/health` returns `503` and anything that reads data fails). Check
the logs for `Migration error`. The schema is mid-flight or incompatible; restore your backup and open an
[issue](https://github.com/PiwiTests/piwi/issues) with the error. If the error starts with
`Migration history repair failed`, the database ran another build and could not be brought in line
automatically ([details](#a-database-that-ran-another-build)); it was left as it was.

**The dashboard loads but data looks wrong.** Don't downgrade — restore the backup instead, then
report what you saw. Downgrading on a migrated database compounds the problem.

**The Windows desktop installer says "Error opening file for writing".** Up to version 0.37, an
in-app update could leave the app's bundled server running — a `node.exe` in the install folder,
`%LOCALAPPDATA%\Piwi Dashboard` for the `.exe` — and the installer could not replace the files it
holds. Installers from later versions stop it first. If you hit it, don't choose **Ignore**, which
leaves an old file behind: in Task Manager's **Details** tab, end the `node.exe` whose
**Open file location** is that folder, then choose **Retry**.

**Failure clusters look reorganized.** Expected after a fingerprint-algorithm change: clusters that now
share a root cause have merged. Triage state is carried across the merge.

## Related
- [Backup & restore](./backup-restore) — what to back up and how
- [Deployment → Available tags](./deployment#available-tags) — what to pin
- [Changelog](https://github.com/PiwiTests/piwi/blob/main/CHANGELOG.md) — breaking changes per release
