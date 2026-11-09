/**
 * What the run backfill tests share: the SQL of a backfill migration and the stored metadata shapes it reads. The SQLite
 * side runs in `run-origin-column.test.ts`, the PostgreSQL side in `run-origin-column-pg.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const SQLITE_MIGRATIONS = join(APP_DIR, 'server/database/migrations');
export const POSTGRES_MIGRATIONS = join(APP_DIR, 'server/database/migrations-pg');

/** The SQL of the migration that fills `test_runs.origin` (or, with `name`, another column) for the runs stored before it. */
export function backfillSql(folder: string, name = 'backfill_run_origin'): string {
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const entry = journal.entries.find((e) => e.tag.endsWith(`_${name}`));
  if (!entry) throw new Error(`no ${name} migration in ${folder}`);
  return readFileSync(join(folder, `${entry.tag}.sql`), 'utf8');
}

/** Metadata the origin is read from: current stamps, what older runs recorded, and values that are no object at all. */
export const ORIGIN_SHAPES: unknown[] = [
  {},
  [],
  'text',
  42,
  { scm: { branch: 'main' } },
  { ci: { provider: 'GitHub Actions' } },
  { ci: 'GitHub Actions' },
  { ci: [] },
  { import: { source: 'upload' } },
  { import: { source: 'upload' }, ci: { provider: 'Jenkins' } },
  { piwiProbe: true },
  { piwiProbe: 1 },
  { piwiProbe: 'true' },
  { piwiFlakeLab: { experimentId: 'exp-1', armId: 'control' } },
  { piwiFlakeLab: [] },
  { piwiFlakeLab: true },
  { piwiProbe: true, piwiFlakeLab: { experimentId: 'exp-1' } },
  { piwiOrigin: { kind: 'editor' } },
  { piwiOrigin: { kind: 'ci-rerun', ref: 'a1b2c3' }, ci: { provider: 'GitHub Actions' } },
  { piwiOrigin: { kind: 'bisect', ref: '12' } },
  { piwiOrigin: { ref: '12', kind: 'reproduce' } },
  { piwiOrigin: { kind: 'someday' }, ci: { provider: 'Jenkins' } },
  { piwiOrigin: { kind: 7 } },
  { piwiOrigin: {} },
  { piwiOrigin: 'ci' },
  { piwiOrigin: [], import: { source: 'upload' } },
  { piwiFlakeLab: { experimentId: 'exp-1' }, piwiOrigin: { kind: 'flake-lab', ref: 'exp-1' } },
  { piwiOrigin: { kind: 'import' }, import: { source: 'upload' } },
  { customData: { piwiProbe: true, ci: { provider: 'nested' } } },
];
