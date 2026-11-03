import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  applyMigrations,
  classifyStatement,
  compareMigrationHistory,
  diffSchema,
  isSchemaOnly,
  readJournal,
  readLatestSnapshot,
  snapshotShape,
  type JournalMigration,
  type MigrationTarget,
  type SchemaShape,
} from '../../server/database/migration-history';
import { sqliteMigrationTarget } from '../../server/database/migration-targets';
import {
  buildSnapshot,
  quietLog,
  repairScenarios,
  sqliteDatabase,
  sqliteFixture,
  writeFolder,
} from './migration-repair';

const sqliteFolder = fileURLToPath(new URL('../../server/database/migrations', import.meta.url));
const postgresFolder = fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url));

function migration(tag: string, createdAt: number, hash = tag): JournalMigration {
  return { tag, createdAt, hash, statements: [] };
}

describe('compareMigrationHistory', () => {
  test('sorts the journal against the recorded rows', () => {
    const journal = [migration('a', 1), migration('b', 2), migration('c', 3), migration('d', 5), migration('e', 6)];
    const applied = [
      { hash: 'a', createdAt: 1 },
      { hash: 'b-before-edit', createdAt: 2 },
      { hash: 'from-another-branch', createdAt: 4 },
      { hash: 'd', createdAt: 5 },
    ];
    const history = compareMigrationHistory(applied, journal);
    expect(history.orphaned).toEqual([{ hash: 'from-another-branch', createdAt: 4 }]);
    expect(history.skipped.map((m) => m.tag)).toEqual(['c']);
    expect(history.pending.map((m) => m.tag)).toEqual(['e']);
    expect(history.changed.map((m) => m.tag)).toEqual(['b']);
  });

  test('leaves everything pending on a fresh database', () => {
    const history = compareMigrationHistory([], [migration('a', 1), migration('b', 2)]);
    expect(history).toEqual({
      orphaned: [],
      skipped: [],
      pending: [migration('a', 1), migration('b', 2)],
      changed: [],
    });
  });
});

describe('classifyStatement', () => {
  test.each([
    ['CREATE TABLE `graph_edges` (\n\t`id` integer)', { kind: 'create-table', table: 'graph_edges' }],
    ['CREATE TABLE IF NOT EXISTS "public"."users" ("id" serial)', { kind: 'create-table', table: 'users' }],
    [
      'CREATE UNIQUE INDEX `idx_a` ON `graph_edges` (`project_id`) WHERE "graph_edges"."branch" is null;',
      { kind: 'create-index', index: 'idx_a', table: 'graph_edges' },
    ],
    [
      'CREATE INDEX IF NOT EXISTS "idx_b" ON "probes" USING btree ("project_id");',
      { kind: 'create-index', index: 'idx_b', table: 'probes' },
    ],
    [
      'ALTER TABLE `projects` ADD `route_origins` text;',
      { kind: 'add-column', table: 'projects', column: 'route_origins' },
    ],
    [
      'ALTER TABLE "projects" ADD COLUMN "capabilities" jsonb;',
      { kind: 'add-column', table: 'projects', column: 'capabilities' },
    ],
    [
      'ALTER TABLE "probes" ADD CONSTRAINT "probes_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")',
      { kind: 'add-constraint', table: 'probes', constraint: 'probes_project_id_fk' },
    ],
    [
      '\n-- Custom SQL migration file\nALTER TABLE Projects ADD Color text',
      { kind: 'add-column', table: 'projects', column: 'color' },
    ],
    ['ALTER TABLE `a` ADD PRIMARY KEY (`id`)', { kind: 'other' }],
    ['ALTER TABLE `__new_runs` RENAME TO `runs`;', { kind: 'other' }],
    ['UPDATE `test_runs` SET `passed` = 0;', { kind: 'other' }],
  ])('%s', (statement, expected) => {
    expect(classifyStatement(statement)).toEqual(expected);
  });

  test('tells a schema-only migration from one that changes data', () => {
    const schemaOnly = { ...migration('a', 1), statements: ['ALTER TABLE `a` ADD `b` text;', '\n'] };
    const withData = { ...migration('b', 2), statements: ['ALTER TABLE `a` ADD `b` text;', 'UPDATE `a` SET `b` = 1;'] };
    expect(isSchemaOnly(schemaOnly)).toBe(true);
    expect(isSchemaOnly(withData)).toBe(false);
  });
});

describe('committed migrations', () => {
  test.each([
    ['sqlite', sqliteFolder],
    ['postgres', postgresFolder],
  ])('date every %s migration after the one before it', (_dialect, folder) => {
    const journal = readJournal(folder);
    const outOfOrder = journal.filter((entry, i) => i > 0 && entry.createdAt <= journal[i - 1]!.createdAt);
    expect(outOfOrder.map((entry) => entry.tag)).toEqual([]);
  });

  test('build a fresh SQLite database that matches the latest snapshot', async () => {
    const client = createClient({ url: ':memory:' });
    const target = sqliteMigrationTarget(client, () => migrate(drizzle(client), { migrationsFolder: sqliteFolder }));
    await target.migrate();
    const differences = diffSchema(
      snapshotShape(readLatestSnapshot(sqliteFolder), 'sqlite'),
      await describeSchema(target),
    );
    expect(differences).toEqual({ blocking: [], extra: [] });
  });
});

async function describeSchema(target: MigrationTarget): Promise<SchemaShape> {
  let shape: SchemaShape | undefined;
  await target.repair(async (session) => {
    shape = await session.describe();
  });
  return shape!;
}

describe('applyMigrations on SQLite', () => {
  repairScenarios(sqliteFixture, async () => sqliteDatabase());

  test('rebuilds a table without running the ON DELETE actions of the rows that reference it', async () => {
    const database = sqliteDatabase();
    const init = { tag: '0000_init', when: 1000, sql: [sqliteFixture.projects] };
    await database.migrateWith(
      writeFolder(
        [init, { tag: '0001_branch_widgets', when: 3000, sql: sqliteFixture.branchWidgets() }],
        buildSnapshot('sqlite'),
      ),
    );
    await database.exec(sqliteFixture.insertWidget);
    // A column added the way drizzle-kit adds one it cannot ALTER in: a copy of the table replaces it.
    const rebuildProjects = [
      'PRAGMA foreign_keys=OFF',
      'CREATE TABLE `__new_projects` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `name` text NOT NULL, `color` text)',
      'INSERT INTO `__new_projects`("id", "name") SELECT "id", "name" FROM `projects`',
      'DROP TABLE `projects`',
      'ALTER TABLE `__new_projects` RENAME TO `projects`',
      'PRAGMA foreign_keys=ON',
    ];
    const build = writeFolder(
      [
        init,
        { tag: '0001_projects_color', when: 2000, sql: rebuildProjects },
        { tag: '0002_widgets', when: 4000, sql: sqliteFixture.widgets },
      ],
      buildSnapshot('sqlite'),
    );
    await applyMigrations(database.target(build), build, quietLog().log);

    expect(await database.rows('SELECT name, size FROM widgets')).toEqual([{ name: 'kept', size: 0 }]);
    expect(await database.rows('SELECT foreign_keys FROM pragma_foreign_keys')).toEqual([{ foreign_keys: 1 }]);
  });
});
