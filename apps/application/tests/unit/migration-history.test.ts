import { afterAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
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
  type Dialect,
  type JournalMigration,
  type MigrationTarget,
  type SchemaShape,
} from '../../server/database/migration-history';
import { postgresMigrationTarget, sqliteMigrationTarget } from '../../server/database/migration-targets';

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

// ── Repair ────────────────────────────────────────────────────────────────

/** SQL and snapshot for each dialect, so both targets run the same scenarios. */
interface DialectFixture {
  dialect: Dialect;
  projects: string;
  projectsColor: string;
  projectsIcon: string;
  /**
   * The widgets table as another branch created it, with a unique index this
   * build does not declare; `legacyCode` adds a column only that branch has,
   * NOT NULL without a default.
   */
  branchWidgets(legacyCode?: boolean): string[];
  /** The same table as this build declares it, with a `size` column. */
  widgets: string[];
  insertWidget: string;
}

const sqliteFixture: DialectFixture = {
  dialect: 'sqlite',
  projects: 'CREATE TABLE `projects` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `name` text NOT NULL)',
  projectsColor: 'ALTER TABLE `projects` ADD `color` text',
  projectsIcon: 'ALTER TABLE `projects` ADD `icon` text',
  branchWidgets: (legacyCode) => [
    `CREATE TABLE \`widgets\` (\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL, \`project_id\` integer NOT NULL, \`name\` text NOT NULL${legacyCode ? ', `legacy_code` text NOT NULL' : ''}, FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade)`,
    'CREATE UNIQUE INDEX `idx_widgets_name` ON `widgets` (`project_id`,`name`)',
    'CREATE INDEX `idx_widgets_project` ON `widgets` (`project_id`)',
  ],
  widgets: [
    'CREATE TABLE `widgets` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `project_id` integer NOT NULL, `name` text NOT NULL, `size` integer DEFAULT 0 NOT NULL, FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade)',
    'CREATE INDEX `idx_widgets_project` ON `widgets` (`project_id`)',
  ],
  insertWidget:
    "INSERT INTO `projects` (`id`, `name`) VALUES (1, 'Alpha'); INSERT INTO `widgets` (`project_id`, `name`) VALUES (1, 'kept')",
};

const postgresFixture: DialectFixture = {
  dialect: 'postgres',
  projects: 'CREATE TABLE "projects" ("id" serial PRIMARY KEY NOT NULL, "name" text NOT NULL)',
  projectsColor: 'ALTER TABLE "projects" ADD COLUMN "color" text',
  projectsIcon: 'ALTER TABLE "projects" ADD COLUMN "icon" text',
  branchWidgets: (legacyCode) => [
    `CREATE TABLE "widgets" ("id" serial PRIMARY KEY NOT NULL, "project_id" integer NOT NULL, "name" text NOT NULL${legacyCode ? ', "legacy_code" text NOT NULL' : ''})`,
    'ALTER TABLE "widgets" ADD CONSTRAINT "widgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action',
    'CREATE UNIQUE INDEX "idx_widgets_name" ON "widgets" USING btree ("project_id","name")',
    'CREATE INDEX "idx_widgets_project" ON "widgets" USING btree ("project_id")',
  ],
  widgets: [
    'CREATE TABLE "widgets" ("id" serial PRIMARY KEY NOT NULL, "project_id" integer NOT NULL, "name" text NOT NULL, "size" integer DEFAULT 0 NOT NULL)',
    'ALTER TABLE "widgets" ADD CONSTRAINT "widgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action',
    'CREATE INDEX "idx_widgets_project" ON "widgets" USING btree ("project_id")',
  ],
  insertWidget: `INSERT INTO "projects" ("id", "name") VALUES (1, 'Alpha'); INSERT INTO "widgets" ("project_id", "name") VALUES (1, 'kept')`,
};

const column = (name: string, type: string, notNull: boolean, extra: Record<string, unknown> = {}) => ({
  [name]: { name, type, primaryKey: false, notNull, ...extra },
});

/** The snapshot of the build folder below: projects (with color) and widgets (with size). */
function buildSnapshot(dialect: Dialect, projectColumns: Record<string, unknown> = {}) {
  const id = {
    id: { name: 'id', type: dialect === 'postgres' ? 'serial' : 'integer', primaryKey: true, notNull: true },
  };
  return {
    tables: {
      projects: {
        name: 'projects',
        columns: { ...id, ...column('name', 'text', true), ...column('color', 'text', false), ...projectColumns },
        indexes: {},
        foreignKeys: {},
        compositePrimaryKeys: {},
        uniqueConstraints: {},
      },
      widgets: {
        name: 'widgets',
        columns: {
          ...id,
          ...column('project_id', 'integer', true),
          ...column('name', 'text', true),
          ...column('size', 'integer', true, { default: 0 }),
        },
        indexes: { idx_widgets_project: { name: 'idx_widgets_project', isUnique: false } },
        foreignKeys: {
          widgets_project_id_projects_id_fk: {
            name: 'widgets_project_id_projects_id_fk',
            tableFrom: 'widgets',
            columnsFrom: ['project_id'],
            tableTo: 'projects',
            columnsTo: ['id'],
          },
        },
        compositePrimaryKeys: {},
        uniqueConstraints: {},
      },
    },
  };
}

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

function writeFolder(migrations: { tag: string; when: number; sql: string[] }[], snapshot: object): string {
  const folder = mkdtempSync(join(tmpdir(), 'piwi-migrations-'));
  folders.push(folder);
  mkdirSync(join(folder, 'meta'));
  const entries = migrations.map((m, idx) => ({ idx, version: '6', when: m.when, tag: m.tag, breakpoints: true }));
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ version: '7', entries }));
  for (const m of migrations) writeFileSync(join(folder, `${m.tag}.sql`), m.sql.join('--> statement-breakpoint\n'));
  const last = String(migrations.length - 1).padStart(4, '0');
  writeFileSync(join(folder, `meta/${last}_snapshot.json`), JSON.stringify(snapshot));
  return folder;
}

interface TestDatabase {
  /** A target running the Drizzle migrator on `folder`. */
  target(folder: string): MigrationTarget;
  /** Run the Drizzle migrator on `folder`, as a checkout of that folder would at startup. */
  migrateWith(folder: string): Promise<void>;
  exec(sql: string): Promise<void>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  columns(table: string): Promise<string[]>;
  indexes(table: string): Promise<string[]>;
  recordedDates(): Promise<number[]>;
}

function sqliteDatabase(): TestDatabase {
  const client: Client = createClient({ url: ':memory:' });
  const db = drizzle(client);
  const rows = async (sql: string) => (await client.execute(sql)).rows as unknown as Record<string, unknown>[];
  return {
    target: (folder) => sqliteMigrationTarget(client, () => migrate(db, { migrationsFolder: folder })),
    migrateWith: (folder) => migrate(db, { migrationsFolder: folder }),
    exec: async (sql) => void (await client.executeMultiple(sql)),
    rows,
    columns: async (table) => (await rows(`PRAGMA table_info("${table}")`)).map((r) => String(r.name)),
    indexes: async (table) =>
      (await rows(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}' AND sql IS NOT NULL`))
        .map((r) => String(r.name))
        .sort(),
    recordedDates: async () =>
      (await rows('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')).map((r) => Number(r.created_at)),
  };
}

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;

async function postgresDatabase(): Promise<TestDatabase & { close(): Promise<void> }> {
  const { default: postgres } = await import('postgres');
  const { drizzle: pgDrizzle } = await import('drizzle-orm/postgres-js');
  const { migrate: pgMigrate } = await import('drizzle-orm/postgres-js/migrator');
  const client = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  // A schema of its own keeps the scenario away from the tables other tests use.
  const schema = `piwi_migration_history_${process.pid}`;
  await client.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  const db = pgDrizzle(client);
  const migrationsSchema = `${schema}_drizzle`;
  const run = (folder: string) => pgMigrate(db, { migrationsFolder: folder, migrationsSchema });
  const rows = async (sql: string) => (await client.unsafe(sql)) as unknown as Record<string, unknown>[];
  const target = (folder: string) => postgresMigrationTarget(client, () => run(folder), migrationsSchema);
  return {
    target,
    migrateWith: run,
    exec: async (sql) => void (await client.unsafe(sql)),
    rows,
    columns: async (table) =>
      (
        await rows(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position`,
        )
      ).map((r) => String(r.column_name)),
    indexes: async (table) =>
      (
        await rows(
          `SELECT indexname FROM pg_indexes WHERE schemaname = '${schema}' AND tablename = '${table}' AND indexname NOT LIKE '%_pkey'`,
        )
      )
        .map((r) => String(r.indexname))
        .sort(),
    recordedDates: async () =>
      (await rows(`SELECT created_at FROM ${migrationsSchema}.__drizzle_migrations ORDER BY created_at`)).map((r) =>
        Number(r.created_at),
      ),
    close: async () => {
      await client.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${migrationsSchema} CASCADE`);
      await client.end();
    },
  };
}

function quietLog() {
  const lines: string[] = [];
  return { lines, log: { log() {}, warn: (line: string) => void lines.push(line) } };
}

function repairScenarios(fixture: DialectFixture, open: () => Promise<TestDatabase & { close?(): Promise<void> }>) {
  const { dialect } = fixture;
  const init = { tag: '0000_init', when: 1000, sql: [fixture.projects] };
  // Another branch created widgets at 3000; this build dates its projects.color
  // migration before that, and regenerated widgets (with a size column) after.
  const branchFolder = () =>
    writeFolder(
      [init, { tag: '0001_branch_widgets', when: 3000, sql: fixture.branchWidgets() }],
      buildSnapshot(dialect),
    );
  const buildFolder = () =>
    writeFolder(
      [
        init,
        { tag: '0001_projects_color', when: 2000, sql: [fixture.projectsColor] },
        { tag: '0002_widgets', when: 4000, sql: fixture.widgets },
      ],
      buildSnapshot(dialect),
    );

  test('applies the skipped and regenerated migrations, keeps the data and drops the orphaned record', async () => {
    const database = await open();
    try {
      await database.migrateWith(branchFolder());
      await database.exec(fixture.insertWidget);
      const build = buildFolder();
      const { lines, log } = quietLog();
      await applyMigrations(database.target(build), build, log);

      expect(lines.at(-1)).toContain('Migration history repaired');
      expect(lines.join('\n')).toContain('dropped unique indexes this build does not declare: idx_widgets_name');
      expect(await database.columns('projects')).toContain('color');
      expect(await database.columns('widgets')).toContain('size');
      expect(await database.indexes('widgets')).toEqual(['idx_widgets_project']);
      expect(await database.rows('SELECT name, size FROM widgets')).toEqual([{ name: 'kept', size: 0 }]);
      expect(await database.recordedDates()).toEqual([1000, 2000, 4000]);

      // The next startup goes through the Drizzle migrator, silently.
      let migrated = false;
      const again = quietLog();
      const target = database.target(build);
      await applyMigrations({ ...target, migrate: async () => void (migrated = true) }, build, again.log);
      expect(migrated).toBe(true);
      expect(again.lines).toEqual([]);
    } finally {
      await database.close?.();
    }
  });

  test('rolls the repair back and names the difference when the schema cannot match', async () => {
    const database = await open();
    try {
      const branch = writeFolder(
        [init, { tag: '0001_branch_widgets', when: 3000, sql: fixture.branchWidgets(true) }],
        buildSnapshot(dialect),
      );
      await database.migrateWith(branch);
      const build = buildFolder();
      const { log } = quietLog();
      await expect(applyMigrations(database.target(build), build, log)).rejects.toThrow(
        /the database is unchanged.*column widgets\.legacy_code is not in this build and is NOT NULL without a default/,
      );
      expect(await database.columns('projects')).not.toContain('color');
      expect(await database.recordedDates()).toEqual([1000, 3000]);
    } finally {
      await database.close?.();
    }
  });

  test('runs a changed schema-only migration again and records its new hash', async () => {
    const database = await open();
    try {
      const snapshot = buildSnapshot(dialect, column('icon', 'text', false));
      const before = writeFolder(
        [init, { tag: '0001_projects_color', when: 2000, sql: [fixture.projectsColor] }],
        snapshot,
      );
      await database.migrateWith(before);
      const build = writeFolder(
        [
          init,
          { tag: '0001_projects_color', when: 2000, sql: [fixture.projectsColor, fixture.projectsIcon] },
          { tag: '0002_widgets', when: 4000, sql: fixture.widgets },
        ],
        snapshot,
      );
      const { lines, log } = quietLog();
      await applyMigrations(database.target(build), build, log);

      expect(lines.join('\n')).toContain('Changed after this database applied them: 0001_projects_color');
      expect(await database.columns('projects')).toEqual(expect.arrayContaining(['color', 'icon']));
      let migrated = false;
      const again = quietLog();
      await applyMigrations(
        { ...database.target(build), migrate: async () => void (migrated = true) },
        build,
        again.log,
      );
      expect(migrated).toBe(true);
      expect(again.lines).toEqual([]);
    } finally {
      await database.close?.();
    }
  });

  test('only warns when the database is ahead of the build', async () => {
    const database = await open();
    try {
      const ahead = writeFolder(
        [init, { tag: '0001_projects_color', when: 2000, sql: [fixture.projectsColor] }],
        buildSnapshot(dialect),
      );
      await database.migrateWith(ahead);
      const older = writeFolder([init], buildSnapshot(dialect));
      let migrated = false;
      const { lines, log } = quietLog();
      await applyMigrations({ ...database.target(older), migrate: async () => void (migrated = true) }, older, log);
      expect(migrated).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('1 applied migration(s) are not in this build');
    } finally {
      await database.close?.();
    }
  });
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

describe.skipIf(!postgresUrl)('applyMigrations on PostgreSQL (PIWI_POSTGRES_TEST_URL)', () => {
  repairScenarios(postgresFixture, postgresDatabase);
});
