import type { Client, InValue, Transaction } from '@libsql/client';
import type { Sql } from 'postgres';
import {
  SCRATCH_TABLE,
  asTemporaryTable,
  foreignKeyKey,
  postgresName,
  quoteIdentifier,
  type ColumnDefinition,
  type MigrationTarget,
  type RepairSession,
  type SchemaShape,
} from './migration-history';

type Row = Record<string, unknown>;
type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

const sqliteExists = async (query: Query, type: string, name: string) =>
  (await query('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? COLLATE NOCASE', [type, name])).length > 0;

const postgresTableExists = async (query: Query, table: string) =>
  (await query('SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = $1', [table])).length > 0;

// ── SQLite ────────────────────────────────────────────────────────────────

const sqliteQuery =
  (executor: Client | Transaction): Query =>
  async (sql, params = []) =>
    (await executor.execute({ sql, args: params as InValue[] })).rows as unknown as Row[];

/**
 * `client` must have a single connection (`concurrency: 1`, or a `:memory:`
 * database): the repair turns foreign keys off on it before its transaction
 * begins there.
 */
export function sqliteMigrationTarget(client: Client, migrate: () => Promise<void>): MigrationTarget {
  const query = sqliteQuery(client);
  return {
    dialect: 'sqlite',
    resetHint:
      'stop the server and delete the database file (PIWI_DATABASE_PATH, .data/piwi.db by default); ' +
      'in development, npm run app:seed:dev reloads the sample data',
    migrate,
    async readApplied() {
      const table = await query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'");
      if (!table.length) return [];
      const rows = await query('SELECT hash, created_at FROM "__drizzle_migrations"');
      return rows.map((row) => ({ hash: String(row.hash), createdAt: Number(row.created_at) }));
    },
    async repair(work) {
      // Same sequence as the libSQL migrator: foreign keys are off for the
      // transaction, so a table rebuild (DROP TABLE, then rename a copy) does
      // not cascade to the rows that reference the table. The pragma does
      // nothing inside a transaction, so it runs before the transaction begins.
      await client.execute('PRAGMA foreign_keys=OFF');
      try {
        const tx = await client.transaction('write');
        try {
          const txQuery = sqliteQuery(tx);
          const [foreignKeys] = await txQuery('PRAGMA foreign_keys');
          if (Number(foreignKeys?.foreign_keys) !== 0) {
            throw new Error(
              'foreign keys are enforced in the repair transaction: its client has more than one connection',
            );
          }
          await work(sqliteSession(txQuery));
          await tx.commit();
        } finally {
          tx.close();
        }
      } finally {
        await client.execute('PRAGMA foreign_keys=ON');
      }
    },
  };
}

function sqliteSession(query: Query): RepairSession {
  return {
    run: async (sql) => void (await query(sql)),
    tableExists: (table) => sqliteExists(query, 'table', table),
    indexExists: (index) => sqliteExists(query, 'index', index),
    // SQLite has no named constraints to add after the fact.
    constraintExists: async () => false,
    columns: (table) => sqliteColumns(query, table),
    async declaredColumns(createTable) {
      await query(asTemporaryTable(createTable, SCRATCH_TABLE));
      try {
        return await sqliteColumns(query, SCRATCH_TABLE);
      } finally {
        await query(`DROP TABLE temp.${quoteIdentifier(SCRATCH_TABLE)}`);
      }
    },
    async addColumn(table, column) {
      if (column.primaryKey) throw new Error(`primary key column ${table}.${column.name} is missing`);
      let definition = `${quoteIdentifier(column.name)} ${column.type}`;
      if (column.defaultValue !== null) definition += ` DEFAULT ${column.defaultValue}`;
      if (column.notNull) definition += ' NOT NULL';
      if (column.references) {
        const { table: parent, column: key, onUpdate, onDelete } = column.references;
        definition += ` REFERENCES ${quoteIdentifier(parent)}(${quoteIdentifier(key)}) ON UPDATE ${onUpdate} ON DELETE ${onDelete}`;
      }
      await query(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${definition}`);
    },
    dropIndex: async (index) => void (await query(`DROP INDEX ${quoteIdentifier(index)}`)),
    dropConstraint: async () => {},
    describe: () => describeSqlite(query),
    record: async (migration) =>
      void (await query('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)', [
        migration.hash,
        migration.createdAt,
      ])),
    rehash: async (migration) =>
      void (await query('UPDATE "__drizzle_migrations" SET hash = ? WHERE created_at = ?', [
        migration.hash,
        migration.createdAt,
      ])),
    forget: async (row) =>
      void (await query('DELETE FROM "__drizzle_migrations" WHERE created_at = ?', [row.createdAt])),
  };
}

async function sqliteColumns(query: Query, table: string): Promise<ColumnDefinition[]> {
  const columns = await query(`PRAGMA table_info(${quoteIdentifier(table)})`);
  const foreignKeys = await query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`);
  return columns.map((column) => {
    // Only a single-column foreign key can be declared on the column itself.
    const fk = foreignKeys.find(
      (key) => key.from === column.name && foreignKeys.filter((other) => other.id === key.id).length === 1,
    );
    return {
      name: String(column.name),
      type: String(column.type),
      notNull: Number(column.notnull) === 1,
      defaultValue: column.dflt_value == null ? null : String(column.dflt_value),
      primaryKey: Number(column.pk) > 0,
      references: fk
        ? {
            table: String(fk.table),
            column: String(fk.to),
            onUpdate: String(fk.on_update),
            onDelete: String(fk.on_delete),
          }
        : null,
    };
  });
}

async function describeSqlite(query: Query): Promise<SchemaShape> {
  const shape: SchemaShape = { tables: new Map(), indexes: new Map(), foreignKeys: new Set() };
  const tables = await query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
      "AND name <> '__drizzle_migrations'",
  );
  for (const { name } of tables) {
    const table = String(name);
    const columns = await query(`PRAGMA table_info(${quoteIdentifier(table)})`);
    shape.tables.set(
      table,
      new Map(
        columns.map((column) => [
          String(column.name),
          { notNull: Number(column.notnull) === 1 || Number(column.pk) > 0, hasDefault: column.dflt_value != null },
        ]),
      ),
    );
    const byId = new Map<unknown, Row[]>();
    for (const key of await query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)) {
      byId.set(key.id, [...(byId.get(key.id) ?? []), key]);
    }
    for (const parts of byId.values()) {
      parts.sort((a, b) => Number(a.seq) - Number(b.seq));
      shape.foreignKeys.add(
        foreignKeyKey(
          {
            name: '',
            tableFrom: table,
            columnsFrom: parts.map((part) => String(part.from)),
            tableTo: String(parts[0]!.table),
            columnsTo: parts.map((part) => String(part.to)),
          },
          'sqlite',
        ),
      );
    }
  }
  // Indexes without SQL are the automatic ones behind PRIMARY KEY and UNIQUE column constraints.
  for (const index of await query(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
  )) {
    shape.indexes.set(String(index.name), {
      table: String(index.tbl_name),
      unique: /^\s*CREATE\s+UNIQUE\b/i.test(String(index.sql)),
    });
  }
  return shape;
}

// ── PostgreSQL ────────────────────────────────────────────────────────────

/** `migrationsSchema` is where the Drizzle migrator keeps `__drizzle_migrations`, as its option of the same name. */
export function postgresMigrationTarget(
  client: Sql,
  migrate: () => Promise<void>,
  migrationsSchema = 'drizzle',
): MigrationTarget {
  const migrationsTable = `${quoteIdentifier(migrationsSchema)}."__drizzle_migrations"`;
  return {
    dialect: 'postgres',
    resetHint: 'drop and recreate the database',
    migrate,
    async readApplied() {
      const [table] = await client.unsafe('SELECT to_regclass($1) IS NOT NULL AS present', [migrationsTable]);
      if (!table?.present) return [];
      const rows = await client.unsafe(`SELECT hash, created_at FROM ${migrationsTable}`);
      return rows.map((row) => ({ hash: String(row.hash), createdAt: Number(row.created_at) }));
    },
    async repair(work) {
      await client.begin(async (tx) => {
        const query: Query = (sql, params = []) => tx.unsafe(sql, params as never[]) as Promise<Row[]>;
        await work(postgresSession(query, migrationsTable));
      });
    },
  };
}

function postgresSession(query: Query, migrationsTable: string): RepairSession {
  const columns = async (table: string): Promise<ColumnDefinition[]> => {
    const rows = await query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS default_value,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary
                      AND a.attnum = ANY (i.indkey)) AS primary_key
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = to_regclass(quote_ident($1)) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [table],
    );
    return rows.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      notNull: Boolean(row.not_null),
      defaultValue: row.default_value == null ? null : String(row.default_value),
      primaryKey: Boolean(row.primary_key),
      // Foreign keys are separate ADD CONSTRAINT statements in PostgreSQL migrations.
      references: null,
    }));
  };
  return {
    run: async (sql) => void (await query(sql)),
    tableExists: (table) => postgresTableExists(query, table),
    indexExists: async (index) =>
      (
        await query('SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1', [
          postgresName(index),
        ])
      ).length > 0,
    constraintExists: async (table, constraint) =>
      (
        await query(
          `SELECT 1 FROM pg_constraint k
             JOIN pg_class c ON c.oid = k.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relname = $1 AND k.conname = $2`,
          [table, postgresName(constraint)],
        )
      ).length > 0,
    columns,
    async declaredColumns(createTable) {
      await query(asTemporaryTable(createTable, SCRATCH_TABLE));
      try {
        return await columns(SCRATCH_TABLE);
      } finally {
        await query(`DROP TABLE pg_temp.${quoteIdentifier(SCRATCH_TABLE)}`);
      }
    },
    async addColumn(table, column) {
      if (column.primaryKey || column.defaultValue?.startsWith('nextval(')) {
        throw new Error(`key column ${table}.${column.name} is missing`);
      }
      let definition = `${quoteIdentifier(column.name)} ${column.type}`;
      if (column.defaultValue !== null) definition += ` DEFAULT ${column.defaultValue}`;
      if (column.notNull) definition += ' NOT NULL';
      await query(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${definition}`);
    },
    async dropIndex(index) {
      const name = postgresName(index);
      // A unique constraint owns its index, which only goes away with the constraint.
      const [constraint] = await query(
        `SELECT c.relname AS table_name FROM pg_constraint k
           JOIN pg_class c ON c.oid = k.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND k.conname = $1 AND k.contype IN ('u', 'x')`,
        [name],
      );
      await query(
        constraint
          ? `ALTER TABLE ${quoteIdentifier(String(constraint.table_name))} DROP CONSTRAINT ${quoteIdentifier(name)}`
          : `DROP INDEX ${quoteIdentifier(name)}`,
      );
    },
    dropConstraint: async (table, constraint) =>
      void (await query(
        `ALTER TABLE ${quoteIdentifier(table)} DROP CONSTRAINT ${quoteIdentifier(postgresName(constraint))}`,
      )),
    describe: () => describePostgres(query),
    record: async (migration) =>
      void (await query(`INSERT INTO ${migrationsTable} (hash, created_at) VALUES ($1, $2)`, [
        migration.hash,
        migration.createdAt,
      ])),
    rehash: async (migration) =>
      void (await query(`UPDATE ${migrationsTable} SET hash = $1 WHERE created_at = $2`, [
        migration.hash,
        migration.createdAt,
      ])),
    forget: async (row) => void (await query(`DELETE FROM ${migrationsTable} WHERE created_at = $1`, [row.createdAt])),
  };
}

async function describePostgres(query: Query): Promise<SchemaShape> {
  const shape: SchemaShape = { tables: new Map(), indexes: new Map(), foreignKeys: new Set() };
  for (const { name } of await query('SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()')) {
    shape.tables.set(String(name), new Map());
  }
  const columns = await query(
    `SELECT c.relname AS table_name, a.attname AS name, a.attnotnull AS not_null,
            (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS has_default
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  for (const column of columns) {
    shape.tables
      .get(String(column.table_name))
      ?.set(String(column.name), { notNull: Boolean(column.not_null), hasDefault: Boolean(column.has_default) });
  }
  const indexes = await query(
    `SELECT i.relname AS name, t.relname AS table_name, x.indisunique AS is_unique
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND NOT x.indisprimary`,
  );
  for (const index of indexes) {
    shape.indexes.set(String(index.name), { table: String(index.table_name), unique: Boolean(index.is_unique) });
  }
  const foreignKeys = await query(
    `SELECT k.conname AS name, c.relname AS table_name
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND k.contype = 'f'`,
  );
  for (const fk of foreignKeys) {
    shape.foreignKeys.add(
      foreignKeyKey(
        { name: String(fk.name), tableFrom: String(fk.table_name), columnsFrom: [], tableTo: '', columnsTo: [] },
        'postgres',
      ),
    );
  }
  return shape;
}
