import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { APP_DIR, backfillSql, ORIGIN_SHAPES, SQLITE_MIGRATIONS } from './run-backfill';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const { runCommit, runOrigin } = await import('#shared/run-eligibility');

describe('the origin backfill', () => {
  test('reads each stored run as runOrigin does on SQLite, and a malformed row as local', async () => {
    const client = createClient({ url: ':memory:' });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: SQLITE_MIGRATIONS });
    await db.insert(schema.projects).values({ id: 1, name: 'origins' });
    const values = [null, ...ORIGIN_SHAPES];
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
