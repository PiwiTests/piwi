#!/usr/bin/env node
/**
 * Seeds the local dev SQLite database from the demo seed SQL.
 *
 * Usage (from application/):
 *   node scripts/seed-dev-from-demo.mjs
 *
 * The dev server must NOT be running while this script runs (DB lock).
 * The script is idempotent: existing rows are skipped on conflict. A missing
 * seed file is generated and a missing or empty dev database is created and
 * migrated first, so a fresh checkout seeds with this one command.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { copyDemoMedia, DEMO_MEDIA_PREFIX, projectMediaPath } from './copy-demo-media.mjs';
import { generateDemoSeedSql } from './lib/dev-server.mjs';

const require = createRequire(import.meta.url);
const { createClient } = require('@libsql/client');

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');
const sqlPath = join(appDir, 'public/demo/seed.sql');
// The server's SQLite path (`PIWI_DATABASE_PATH`, default `.data/piwi.db`).
const dbPath = process.env.PIWI_DATABASE_PATH
  ? resolve(appDir, process.env.PIWI_DATABASE_PATH)
  : join(appDir, '.data/piwi.db');

// The file endpoint reads a row's path inside the storage directory, so the
// seeded evidence binaries must be copied there. Match the server's storage
// root (`PIWI_STORAGE_PATH`, default `.data/storage`).
const storageEnv = process.env.PIWI_STORAGE_PATH || '.data/storage';
const storageDir = isAbsolute(storageEnv) ? storageEnv : join(appDir, storageEnv);
const publicDemoDir = join(appDir, 'public/demo');

if (!existsSync(sqlPath)) {
  console.log('No demo seed yet — generating public/demo/seed.sql…');
  generateDemoSeedSql();
}
const sql = readFileSync(sqlPath, 'utf8');

// The dev schema comes from the Drizzle migrations, not from the seed: run them
// when the database is missing or still empty, then open it for the inserts.
mkdirSync(dirname(dbPath), { recursive: true });
let db = createClient({ url: `file:${dbPath}` });
const schema = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'test_runs'");
if (schema.rows.length === 0) {
  console.log('Dev database has no schema yet — running the migrations…');
  db.close();
  execSync('npm run db:migrate', { cwd: appDir, stdio: 'inherit' });
  db = createClient({ url: `file:${dbPath}` });
}

/**
 * Split a SQL script into statements on `;`, ignoring semicolons that sit
 * inside single-quoted string literals (e.g. a user-agent like
 * `Mozilla/5.0 (iPhone; CPU ...)` or a commit message) and dropping `--` line
 * comments, which the seed uses as section headers. A naive `split(';')`
 * shatters the quoted INSERTs, and a statement that keeps its leading comment
 * no longer starts with `INSERT INTO` — either way rows vanish without an
 * error, so both are handled here rather than by the caller's filter.
 */
function splitSqlStatements(script) {
  const out = [];
  let cur = '';
  let inString = false;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (ch === "'") {
      // A doubled '' inside a string is an escaped quote, not a terminator.
      if (inString && script[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      inString = !inString;
      cur += ch;
      continue;
    }
    if (!inString && ch === '-' && script[i + 1] === '-') {
      const eol = script.indexOf('\n', i);
      if (eol === -1) break;
      i = eol - 1;
      continue;
    }
    if (ch === ';' && !inString) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// The seed ends with a block that shifts every timestamp from the generator's
// fixed anchor to load time, so "2 hours ago" reads as 2 hours ago in the dev
// DB too. It is the only non-INSERT part this script runs — the surrounding
// DDL builds the demo SPA's in-browser database, while the dev schema comes
// from the Drizzle migrations.
const REBASE_START = 'CREATE TEMP TABLE _rebase';
const rebaseAt = sql.indexOf(REBASE_START);
if (rebaseAt === -1) throw new Error(`no timestamp rebase block in ${sqlPath} — regenerate it with app:seed:demo`);

// Data rows are `INSERT INTO … VALUES (…)`. The seed's schema section also
// carries `INSERT INTO … SELECT` statements that copy rows into the `__new_*`
// tables of SQLite's table-rebuild dance; those belong to the demo SPA's own
// schema build and have no counterpart here.
const statements = splitSqlStatements(sql.slice(0, rebaseAt))
  .map((s) => s.trim())
  .filter((s) => s.startsWith('INSERT INTO') && /\bVALUES\s*\(/i.test(s));

const rebaseStatements = splitSqlStatements(sql.slice(rebaseAt))
  .map((s) => s.trim())
  .filter((s) => /^(CREATE TEMP TABLE|UPDATE|DROP TABLE)\b/.test(s));

console.log(`Seeding ${statements.length} INSERT statements into ${dbPath}...`);
let ok = 0,
  existing = 0,
  skip = 0;
for (const stmt of statements) {
  // Plain INSERT + classify the error: only a UNIQUE/PK conflict means "already
  // present" (idempotent re-seed). A NOT NULL or CHECK violation is silently
  // swallowed by OR IGNORE, which would misreport a broken row as a duplicate
  // and suppress the timestamp rebase, so those must surface as failures.
  await db
    .execute(stmt)
    .then((res) => (res.rowsAffected > 0 ? ok++ : existing++))
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('UNIQUE constraint failed')) {
        existing++;
      } else {
        skip++;
        console.error(' skip:', message);
      }
    });
}

// A partial load leaves the dev DB missing whole projects and runs, which shows
// up as an empty or wrong-looking screen rather than an error.
if (skip > 0) {
  console.error(`Done. ${ok} inserted, ${skip} failed — the dev database is incomplete.`);
  process.exit(1);
}

// The file endpoint serves only paths inside a project's folder: move each
// seeded `demo/…` media row under its project's folder, then copy the committed
// binaries to the paths the rows now name. Both steps are idempotent, so a
// re-run also heals a database seeded before and a storage directory wiped since.
const seededMedia = await db.execute({
  sql: `SELECT f.id, f.path, r.project_id AS projectId FROM files f
        JOIN test_runs r ON r.id = coalesce(
          f.test_run_id,
          (SELECT c.test_run_id FROM test_runs_cases c WHERE c.id = f.test_runs_case_id)
        )
        WHERE f.path LIKE ?`,
  args: [`${DEMO_MEDIA_PREFIX}%`],
});
for (const row of seededMedia.rows) {
  await db.execute({
    sql: 'UPDATE files SET path = ? WHERE id = ?',
    args: [projectMediaPath(row.projectId, row.path), row.id],
  });
}
const storedMedia = await db.execute("SELECT DISTINCT path FROM files WHERE path LIKE 'project-%/demo/%'");
const copied = copyDemoMedia(
  publicDemoDir,
  storageDir,
  storedMedia.rows.map((row) => String(row.path)),
);
console.log(`Demo media: ${copied} file(s) copied into ${storageDir}.`);

// The seeded runs bypass the ingest hook, so the next server start recomputes
// the daily rollups of every stored run (the backfill runs once per setting).
const rollupsTable = await db.execute(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'analytics_daily_rollups'",
);
if (rollupsTable.rows.length > 0) {
  await db.execute("DELETE FROM app_settings WHERE key = 'analytics_rollups_backfilled_at'");
}

// The rebase adds a fixed delta to every timestamp, so it may only run over a
// load that brought in the whole seed. Re-running it against rows that already
// carry a shift would push them into the future.
if (existing > 0) {
  console.log(`Done. ${ok} inserted, ${existing} already present — timestamps left as they are.`);
  console.log('Delete .data/piwi.db and re-run to reseed with timestamps rebased to now.');
} else {
  console.log(`Rebasing timestamps to now (${rebaseStatements.length} statements)...`);
  for (const stmt of rebaseStatements) await db.execute(stmt);
  console.log(`Done. ${ok} inserted, timestamps rebased to now.`);
}
