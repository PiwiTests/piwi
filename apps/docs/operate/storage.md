---
title: Storage & retention
description: "Local or S3-compatible storage for reports and traces, data retention, runs kept forever, cleanup, and what trace snapshots cost."
lang: en-US
---

# Storage & retention

Test artifacts (HTML reports, trace files, screenshots, videos, attachments) are written to one of
two backends. Runs, test cases and settings live in the [database](./database) instead. This page also covers how
long runs are kept: [retention](#data-retention), [runs kept forever](#keeping-runs-forever) and manual cleanup.

Every variable below is an ordinary environment variable: pass it to the container, put it in your
`.env`, or set it in your host's dashboard. The
[configuration generator](/reference/configuration/generator) will write the block for you.

## Local storage (default)

Files are stored under `.data/storage/`. No configuration is required.

To customize the path:

```bash
PIWI_STORAGE_TYPE=local
PIWI_STORAGE_PATH=/custom/path/to/storage
```

## S3-compatible storage

Any S3-compatible service can be used: AWS S3, RustFS, DigitalOcean Spaces, Cloudflare R2, and others.

```bash
PIWI_STORAGE_TYPE=s3

PIWI_S3_BUCKET=your-bucket-name
PIWI_S3_REGION=us-east-1

# Optional: static credentials and a custom endpoint for S3-compatible services
PIWI_S3_ACCESS_KEY_ID=your-access-key
PIWI_S3_SECRET_ACCESS_KEY=your-secret-key
PIWI_S3_ENDPOINT=https://s3.example.com
```

### AWS S3

When the static credential variables are omitted, Piwi uses the AWS SDK default credential chain. This supports ECS
task roles, EC2 instance roles, environment credentials and shared AWS configuration without storing access keys in
Piwi. If either static credential variable is set, both are required.

Minimum required IAM permissions. `s3:ListBucket` lets Piwi delete a run's whole prefix; without it, S3 answers a
missing file with `403` instead of `404`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::your-bucket-name"
    }
  ]
}
```

### RustFS

[RustFS](https://rustfs.com) is an open-source (Apache-2.0), S3-compatible object store you can self-host — a common replacement for MinIO.

```bash
PIWI_STORAGE_TYPE=s3
PIWI_S3_ENDPOINT=http://localhost:9000
PIWI_S3_BUCKET=piwi-dashboard
PIWI_S3_REGION=us-east-1
PIWI_S3_ACCESS_KEY_ID=your-access-key
PIWI_S3_SECRET_ACCESS_KEY=your-secret-key
```

Set `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` on the RustFS server to match the credentials above — don't expose the default `rustfsadmin` account to a networked deployment.

Path-style URLs are enabled automatically when `PIWI_S3_ENDPOINT` is set (as required by RustFS and most self-hosted S3-compatible services). Set `PIWI_S3_FORCE_PATH_STYLE=false` to override this behavior.

### DigitalOcean Spaces

```bash
PIWI_STORAGE_TYPE=s3
PIWI_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
PIWI_S3_BUCKET=your-space-name
PIWI_S3_REGION=nyc3
PIWI_S3_ACCESS_KEY_ID=your-spaces-key
PIWI_S3_SECRET_ACCESS_KEY=your-spaces-secret
```

### Cloudflare R2

```bash
PIWI_STORAGE_TYPE=s3
PIWI_S3_ENDPOINT=https://[account-id].r2.cloudflarestorage.com
PIWI_S3_BUCKET=your-bucket-name
PIWI_S3_REGION=auto
PIWI_S3_ACCESS_KEY_ID=your-r2-access-key
PIWI_S3_SECRET_ACCESS_KEY=your-r2-secret-key
```

## Storage management

The **Settings › Storage** page (`/settings/storage`) provides administrators with:

- **Storage analysis** — total storage used and file count, the projects that consume the most space, a breakdown by file kind (traces, screenshots, videos, reports, attachments, visual diffs), storage growth over time, and the actual on-disk storage size (local only) — which also surfaces any untracked files lingering on disk.
- **Cleanup** — permanently delete all test runs older than a configurable number of days (7, 14, 30, 60, 90, 180, or 365 days). [Kept runs](#keeping-runs-forever) are skipped, and so are each project's newest runs when `PIWI_RETENTION_MIN_RUNS` is set. A confirmation dialog is shown before any data is deleted, and the result says how many runs were skipped.

Project admins can also delete runs by hand:

- From the **test run detail page** — **Delete run** in the page's **⋮** menu.
- From the **project detail page** — **Delete run** in a run's **⋮** menu, or tick several runs and choose
  **Delete** in the selection bar.

The dialog lists each run as it is deleted. **Stop**, or leaving the page, ends the deletion after the current run;
a run that could not be deleted stays listed with its error.

A kept run cannot be deleted until it is released; a selection skips kept runs.

### Data retention

A nightly sweep (03:17 server time) handles recurring cleanup:

- **Test-run pruning** — deletes runs older than `PIWI_RETENTION_DAYS` days, including their files, traces, and reports. **Off by default**: deleting history is opt-in, so nothing is pruned until you set the variable. [Kept runs](#keeping-runs-forever) are never pruned, and `PIWI_RETENTION_MIN_RUNS` keeps each project's newest runs whatever their age, so a project that stops reporting keeps its last runs instead of emptying.
- **Analytics rollups** — pruned runs' numbers are moved into the [daily rollups](/features/analytics#where-the-numbers-come-from) in the transaction that deletes them, so the analytics trends keep the days that retention empties; deleting a single run by hand removes its numbers instead. Hand-back outcomes are counted the same way.
- **Notification outbox pruning** — removes sent/failed delivery rows older than `PIWI_RETENTION_NOTIFICATION_DAYS` days (default 30).
- **Report snapshot pruning** — removes the stored [quality reports](/features/quality-reports#report-schedules) older than `PIWI_RETENTION_REPORT_DAYS` days (default 365; 0 keeps them).
- **Diagnosis history capping** — keeps the newest `PIWI_RETENTION_DIAGNOSIS_VERSIONS` versions per AI diagnosis (default 20).
- **Unlinked traces** — deletes a stored trace no execution has linked for a day (an import that left an execution out, an upload that failed halfway), with the shared trace resources only it used.

The manual **Settings › Storage** cleanup remains available for one-off bulk deletes and uses the same deletion logic.

### Keeping runs forever

Some runs are worth more than the rest — a release build, the run that proved a fix, the last green run before a migration. A **kept** run is exempt from retention: neither the nightly sweep nor the manual cleanup deletes it, however old it gets. Its traces, reports and attachments stay with it.

There are three ways to keep a run:

- **From the dashboard** — **Keep forever…** in the run page's **⋮** menu, or in the run's **⋮** menu on the project's runs table. You can add a reason (e.g. _v2.3.1 release_). Any signed-in user with access to the project can keep a run.
- **From the reporter** — set [`keep: true`](/guide/reporter#configuration-options) in the reporter options, or `PIWI_KEEP=true` in the environment, and the run is kept as it arrives. In CI, set it only for the builds worth keeping — on GitHub Actions, for example, only for tag builds (see below).
- **With a release marker** — a [`release` marker linked to the run](/features/timeline-markers#release-markers-keep-their-run) keeps it for as long as the marker exists.

```yaml
- run: npx playwright test
  env:
    PIWI_KEEP: ${{ startsWith(github.ref, 'refs/tags/') }}
```

A kept run shows a lock next to its number in the runs table and a **Kept** mark in its header; its **Details** say who kept it, when and why. The runs table's **Kept runs only** box lists every kept run of the project, however far back. **Settings › Storage** shows how many runs are kept and how much storage their own files hold.

A Project admin can **release** a run (**Release keep** in the same menus), which puts it back under retention. A kept run cannot be deleted until it is released. Scripts can keep and release runs through the API; see the [API docs](https://piwitests.dev/demo/docs).

### Space reclamation

Deleting runs removes rows and stored files, but giving the freed pages back to the filesystem depends on the backend:

- **SQLite** — databases created by recent versions have `auto_vacuum=INCREMENTAL` enabled, so the cleanup endpoint reclaims space automatically. Databases created before that (where `PRAGMA auto_vacuum` reports `0`) need a one-off full rebuild: call the cleanup API with `{ "olderThanDays": ..., "vacuum": true }` to run a blocking `VACUUM` after the delete. Expect it to take a while on large databases.
- **PostgreSQL** — freed space is reused by PostgreSQL's autovacuum; no manual action is needed.

## Storage architecture

Files are stored under relative paths (e.g. `project-1/run-123/index.html`), so the same layout works on either
backend. What happens to them is automatic and needs no configuration:

- **Traces are split and compressed.** Each trace's network resources, screenshots and screencast frames go to a
  shared pool, stored once per project and freed as soon as no trace references them; the rest of the trace, and
  every text resource, is compressed. Reconstructed traces, the evidence views and offline exports see the original
  bytes.
- **Failure evidence is stored once.** The ARIA snapshot, source snippet and stack frames of a failure are stored
  once per project and shared by every execution that fails the same way.

The one capture choice that visibly changes storage growth is the `screen` trace snapshot, below.

## Trace snapshots

A Playwright 1.63 trace can record an **aria tree** and a **screenshot** before and after every action (`trace: { snapshots: { dom, aria, screen } }`). Those files ride inside the trace ZIP — `aria/<callId>-<phase>.json` and `screenshots/<callId>-<phase>.png` — and the dashboard keeps them with the rest of the trace, so the [Screen tab and the filmstrip](/features/evidence#aria-and-screen-snapshots) read them straight back.

The two kinds cost very differently:

- **`aria`** adds one small JSON tree per action per phase — a few hundred bytes each, negligible next to the trace it rides in. [`wrapConfig`](/guide/reporter#installing-via-wrapconfig) turns it on by default on Playwright 1.63+.
- **`screen`** adds a **PNG per action per phase** — by far the trace's biggest cost, growing with the page size and the number of actions. It stays **opt-in**: enable it only when you want the filmstrip and the before/after screenshots, and pair it with [data retention](#data-retention) so the extra bytes are swept. Enable it with `use: { trace: { mode: 'retain-on-failure', snapshots: { dom: true, aria: true, screen: true } } }`.

Identical screenshots, common between consecutive actions and across runs, are stored once in the shared pool.

## Related
- [Database](./database) — SQLite versus PostgreSQL, and what lives there instead
- [Configuration reference](/reference/configuration#storage) — every `PIWI_STORAGE_*` and `PIWI_S3_*` variable
- [Backup & restore](./backup-restore) — copying the storage directory alongside the database
- [Offline export](/features/offline-export) — taking one investigation out of storage entirely
