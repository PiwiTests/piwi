import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const { runCommit, runOrigin } = await import('#shared/run-eligibility');

const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SQLITE_MIGRATIONS = join(APP_DIR, 'server/database/migrations');
const POSTGRES_MIGRATIONS = join(APP_DIR, 'server/database/migrations-pg');

/** The SQL of the migration that fills `test_runs.origin` (or, with `name`, another column) for the runs stored before it. */
function backfillSql(folder: string, name = 'backfill_run_origin'): string {
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const entry = journal.entries.find((e) => e.tag.endsWith(`_${name}`));
  if (!entry) throw new Error(`no ${name} migration in ${folder}`);
  return readFileSync(join(folder, `${entry.tag}.sql`), 'utf8');
}

/** Metadata the origin is read from: current stamps, what older runs recorded, and values that are no object at all. */
const SHAPES: unknown[] = [
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

describe('the origin backfill', () => {
  test('reads each stored run as runOrigin does on SQLite, and a malformed row as local', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: SQLITE_MIGRATIONS });
    await db.insert(schema.projects).values({ id: 1, name: 'origins' });
    const values = [null, ...SHAPES];
    for (const [i, metadata] of values.entries()) {
      await db
        .insert(schema.testRuns)
        .values({ id: i + 1, projectId: 1, status: 'passed', startTime: new Date(), metadata: metadata as never });
    }
    const malformed = values.length + 1;
    await db
      .insert(schema.testRuns)
      .values({ id: malformed, projectId: 1, status: 'passed', startTime: new Date(), origin: 'probe' });
    await db.run(sql`UPDATE test_runs SET metadata = '{"piwiProbe": tru' WHERE id = ${malformed}`);

    await client.executeMultiple(backfillSql(SQLITE_MIGRATIONS));

    const rows = await db.all<{ id: number; origin: string }>(sql`SELECT id, origin FROM test_runs ORDER BY id`);
    expect(rows.map((r) => r.origin)).toEqual([...values.map((m) => runOrigin(m)), 'local']);
  });

  test.skipIf(!process.env.PIWI_POSTGRES_TEST_URL)(
    'reads each stored run as runOrigin does on PostgreSQL (PIWI_POSTGRES_TEST_URL)',
    async () => {
      const { default: postgres } = await import('postgres');
      const client = postgres(process.env.PIWI_POSTGRES_TEST_URL!, { max: 1, onnotice: () => {} });
      try {
        // A temporary table of the same name is the one the migration's UPDATE reaches in this session.
        await client`CREATE TEMP TABLE test_runs (id integer PRIMARY KEY, metadata jsonb, origin text NOT NULL DEFAULT 'local')`;
        const values = [null, ...SHAPES];
        for (const [i, metadata] of values.entries()) {
          await client`INSERT INTO test_runs (id, metadata) VALUES (${i + 1}, ${metadata === null ? null : client.json(metadata as never)})`;
        }
        await client.unsafe(backfillSql(POSTGRES_MIGRATIONS));
        const rows = await client<Array<{ origin: string }>>`SELECT origin FROM test_runs ORDER BY id`;
        expect(rows.map((r) => r.origin)).toEqual(values.map((m) => runOrigin(m)));
      } finally {
        await client.end();
      }
    },
  );
});

/** The TypeScript files of the code that writes runs: the server, the shared handlers and the demo. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|vue)$/.test(name) ? [path] : [];
  });
}

/** A `metadata` or `origin` property (`key:`, or shorthand) in an object literal. */
const property = (key: string) => new RegExp(`(^|[{,\\s])${key}\\s*[:,}]`, 'm');

/** Metadata the commit is read from: full and short ids, other cases, and values that are none. */
const COMMIT_SHAPES: unknown[] = [
  {},
  'text',
  { scm: { commit: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678' } },
  { scm: { commit: ' a1b2c3d ' } },
  { scm: { commit: 'a1b2c3' } },
  { scm: { commit: 'not-a-commit' } },
  { scm: { commit: 42 } },
  { scm: 'main' },
  { scm: { branch: 'main' } },
];

describe('the commit backfill', () => {
  test('reads each stored run as runCommit does on SQLite', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: SQLITE_MIGRATIONS });
    await db.insert(schema.projects).values({ id: 1, name: 'commits' });
    const values = [null, ...COMMIT_SHAPES];
    for (const [i, metadata] of values.entries()) {
      await db
        .insert(schema.testRuns)
        .values({ id: i + 1, projectId: 1, status: 'passed', startTime: new Date(), metadata: metadata as never });
    }
    const [first] = backfillSql(SQLITE_MIGRATIONS, 'backfill_run_commit').split('--> statement-breakpoint');
    await client.executeMultiple(first!);
    const rows = await db.all<{ commit: string | null }>(sql`SELECT commit_sha AS "commit" FROM test_runs ORDER BY id`);
    expect(rows.map((r) => r.commit)).toEqual(values.map((m) => runCommit(m)));
  });
});

describe('the origin column', () => {
  test('is written by every insert or update of test_runs that writes its metadata, with the commit', () => {
    const missing: string[] = [];
    for (const file of ['server', 'shared', 'app/demo'].flatMap((dir) => sourceFiles(join(APP_DIR, dir)))) {
      const text = readFileSync(file, 'utf8');
      for (const write of text.matchAll(/\.(insert|update)\((?:schema\.)?testRuns\)/g)) {
        const rest = text.slice(write.index);
        const end = rest.search(/;\s*\n/);
        const statement = end === -1 ? rest : rest.slice(0, end);
        if (
          property('metadata').test(statement) &&
          (!property('origin').test(statement) || !property('commit').test(statement))
        ) {
          const line = text.slice(0, write.index).split('\n').length;
          missing.push(`${relative(APP_DIR, file)}:${line}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
