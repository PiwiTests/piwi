import { describe, test, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { getTableConfig as sqliteTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { getTableConfig as pgTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as sqliteSchema from '~~/server/database/schema.sqlite';
import * as pgSchema from '~~/server/database/schema.pg';

/**
 * Guards against drift between the two hand-maintained schema dialects.
 *
 * The SQLite and PostgreSQL schemas must describe the same database: same
 * tables, same columns (nullability, primary keys, defaults), same foreign-key
 * edges, and same index inventory. Divergence here produces bugs that only
 * surface on one backend (e.g. a unique index present on SQLite but missing on
 * PostgreSQL silently disables a concurrency guard).
 *
 * Dialect-inherent type differences are normalized through CANONICAL_TYPES;
 * genuine, deliberate divergences must be declared in KNOWN_DIALECT_DIFFS.
 */

/** Maps drizzle column class names to a dialect-neutral type token. */
const CANONICAL_TYPES: Record<string, string> = {
  // SQLite
  SQLiteInteger: 'int',
  SQLiteTimestamp: 'timestamp',
  SQLiteBoolean: 'boolean',
  SQLiteText: 'text',
  SQLiteTextJson: 'json',
  SQLiteReal: 'float',
  // PostgreSQL
  PgInteger: 'int',
  PgSerial: 'int',
  PgBigInt53: 'bigint',
  PgTimestamp: 'timestamp',
  PgBoolean: 'boolean',
  PgText: 'text',
  PgJsonb: 'json',
  PgReal: 'float',
  PgDoublePrecision: 'float',
  // The only PG custom type is intBoolean (schema.pg.ts): a boolean stored in
  // an integer column, matching SQLite's integer boolean mode.
  PgCustomColumn: 'boolean',
};

/**
 * Deliberate cross-dialect differences, keyed by `table.column`, valued as
 * `[sqlite canonical type, pg canonical type]`. Add entries here only with a
 * reason; anything not listed must match exactly.
 */
const KNOWN_DIALECT_DIFFS: Record<string, [string, string]> = {
  // Millisecond epoch values exceed int32 on PostgreSQL.
  'test_runs_cases.started_at': ['int', 'bigint'],
  'network_requests.start_time': ['int', 'bigint'],
  // Millisecond sums over a day's runs exceed int32 on PostgreSQL.
  'analytics_daily_rollups.duration_ms': ['int', 'bigint'],
  'analytics_daily_rollups.avg_test_duration_sum_ms': ['int', 'bigint'],
  'analytics_daily_rollups.p90_test_duration_sum_ms': ['int', 'bigint'],
  'analytics_daily_rollups.wait_ms': ['int', 'bigint'],
  'analytics_daily_rollups.failed_exec_ms': ['int', 'bigint'],
  // A cluster open past 24.8 days takes more milliseconds than int32 holds on PostgreSQL.
  'failure_clusters.time_to_resolution_ms': ['int', 'bigint'],
};

interface ColumnShape {
  type: string;
  notNull: boolean;
  primary: boolean;
  hasDefault: boolean;
}

interface IndexShape {
  unique: boolean;
  partial: boolean;
  columns: string[];
}

interface TableShape {
  columns: Record<string, ColumnShape>;
  indexes: Record<string, IndexShape>;
  foreignKeys: string[];
  compositePrimaryKeys: string[];
}

type AnyTableConfig = ReturnType<typeof sqliteTableConfig> | ReturnType<typeof pgTableConfig>;

function canonicalType(columnType: string): string {
  const canonical = CANONICAL_TYPES[columnType];
  if (!canonical) throw new Error(`Unmapped drizzle column type "${columnType}" — add it to CANONICAL_TYPES`);
  return canonical;
}

function normalizeTable(config: AnyTableConfig): TableShape {
  const columns: Record<string, ColumnShape> = {};
  for (const column of config.columns) {
    columns[column.name] = {
      type: canonicalType(column.columnType),
      notNull: column.notNull,
      primary: column.primary,
      hasDefault: column.hasDefault,
    };
  }

  const indexes: Record<string, IndexShape> = {};
  for (const ix of config.indexes) {
    const cfg = ix.config;
    indexes[cfg.name] = {
      unique: Boolean(cfg.unique),
      partial: Boolean(cfg.where),
      columns: cfg.columns.map((c: { name?: string }) => c.name ?? '<expression>'),
    };
  }

  const foreignKeys = config.foreignKeys
    .map((fk) => {
      const ref = fk.reference();
      const cols = ref.columns.map((c) => c.name).join(',');
      const foreignCols = ref.foreignColumns.map((c) => c.name).join(',');
      return `${cols} -> ${getTableName(ref.foreignTable)}(${foreignCols}) onDelete=${fk.onDelete ?? 'no action'}`;
    })
    .sort();

  const compositePrimaryKeys = config.primaryKeys
    .map((pk) => pk.columns.map((c: { name: string }) => c.name).join(','))
    .sort();

  return { columns, indexes, foreignKeys, compositePrimaryKeys };
}

function collectTables(
  schema: Record<string, unknown>,
  isTable: (value: unknown) => boolean,
  getConfig: (table: never) => AnyTableConfig,
): Map<string, TableShape> {
  const tables = new Map<string, TableShape>();
  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue;
    const config = getConfig(value as never);
    tables.set(config.name, normalizeTable(config));
  }
  return tables;
}

const sqliteTables = collectTables(
  sqliteSchema,
  (v) => v instanceof SQLiteTable,
  (t) => sqliteTableConfig(t),
);
const pgTables = collectTables(
  pgSchema,
  (v) => v instanceof PgTable,
  (t) => pgTableConfig(t),
);

describe('schema dialect drift', () => {
  test('both dialects define the same tables', () => {
    expect([...pgTables.keys()].sort()).toEqual([...sqliteTables.keys()].sort());
  });

  test.each([...sqliteTables.keys()].sort().map((name) => [name] as const))(
    'table %s matches across dialects',
    (tableName) => {
      const sqlite = sqliteTables.get(tableName)!;
      const pg = pgTables.get(tableName);
      expect(pg, `table ${tableName} missing from the PostgreSQL schema`).toBeDefined();

      // Columns: same names, and same shape modulo canonical types + allowlist.
      expect(Object.keys(pg!.columns).sort()).toEqual(Object.keys(sqlite.columns).sort());
      for (const [columnName, sqliteColumn] of Object.entries(sqlite.columns)) {
        const pgColumn = pg!.columns[columnName]!;
        const key = `${tableName}.${columnName}`;
        const knownDiff = KNOWN_DIALECT_DIFFS[key];
        if (knownDiff) {
          expect([sqliteColumn.type, pgColumn.type], `${key} no longer matches its KNOWN_DIALECT_DIFFS entry`).toEqual(
            knownDiff,
          );
        } else {
          expect(pgColumn.type, `${key} column type differs`).toBe(sqliteColumn.type);
        }
        expect(pgColumn.notNull, `${key} notNull differs`).toBe(sqliteColumn.notNull);
        expect(pgColumn.primary, `${key} primary-key membership differs`).toBe(sqliteColumn.primary);
        expect(pgColumn.hasDefault, `${key} default presence differs`).toBe(sqliteColumn.hasDefault);
      }

      expect(pg!.indexes, `${tableName} index inventory differs`).toEqual(sqlite.indexes);
      expect(pg!.foreignKeys, `${tableName} foreign keys differ`).toEqual(sqlite.foreignKeys);
      expect(pg!.compositePrimaryKeys, `${tableName} composite primary keys differ`).toEqual(
        sqlite.compositePrimaryKeys,
      );
    },
  );
});

/**
 * Foreign-key child columns should be covered by an index prefix (or be the
 * table's primary key): parent-side deletes (CASCADE / SET NULL) otherwise
 * scan the child table. Deliberate exceptions live in the allowlist below and
 * should shrink over time, not grow.
 */
const FK_INDEX_COVERAGE_ALLOWLIST = new Set<string>([]);

describe('foreign key index coverage', () => {
  test('every FK child column is covered by an index prefix', () => {
    const uncovered: string[] = [];
    for (const [tableName, shape] of sqliteTables) {
      const prefixes = new Set<string>();
      for (const ix of Object.values(shape.indexes)) prefixes.add(ix.columns[0]!);
      for (const pk of shape.compositePrimaryKeys) prefixes.add(pk.split(',')[0]!);
      for (const [columnName, column] of Object.entries(shape.columns)) {
        if (column.primary) prefixes.add(columnName);
      }
      for (const fk of shape.foreignKeys) {
        const childColumn = fk.split(' -> ')[0]!;
        if (childColumn.includes(',')) continue; // composite FKs judged by their leading column below
        if (!prefixes.has(childColumn)) uncovered.push(`${tableName}.${childColumn}`);
      }
    }
    const unexpected = uncovered.filter((entry) => !FK_INDEX_COVERAGE_ALLOWLIST.has(entry));
    const stale = [...FK_INDEX_COVERAGE_ALLOWLIST].filter((entry) => !uncovered.includes(entry));
    expect(
      unexpected,
      'new FK child columns without an index — add an index or (with a reason) an allowlist entry',
    ).toEqual([]);
    expect(stale, 'allowlisted FK columns are now indexed — remove them from FK_INDEX_COVERAGE_ALLOWLIST').toEqual([]);
  });
});
