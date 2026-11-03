import { describe, test, expect } from 'vitest';
import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { foldText, foldTextWithOffsets } from '#shared/utils/fold-text';
import { foldedPredicates, VALUES, type Engine } from './folded-predicates';

describe('foldText', () => {
  test('lowers case and drops accents', () => {
    expect(foldText('Résumé')).toBe('resume');
    expect(foldText('CRÈME BRÛLÉE')).toBe('creme brulee');
    expect(foldText('Tiếng Việt')).toBe('tieng viet');
    expect(foldText('ΕΛΛΗΝΙΚΆ')).toBe('ελληνικα');
    expect(foldText('İstanbul')).toBe('istanbul');
  });

  test('drops the strokes no decomposition splits off', () => {
    expect(foldText('Łódź')).toBe('lodz');
    expect(foldText('Ærøskøbing')).toBe('æroskobing');
    expect(foldText('Đorđe')).toBe('dorde');
  });

  test('reads a decomposed accent like a composed one', () => {
    expect(foldText('cafe\u0301')).toBe(foldText('café'));
  });

  test('keeps letters that are not accented forms', () => {
    expect(foldText('Straße')).toBe('straße');
    expect(foldText('東京 テスト')).toBe('東京 テスト');
    expect(foldText('한국어')).toBe('한국어');
  });
});

describe('foldTextWithOffsets', () => {
  test('folds as foldText does', () => {
    for (const value of [...VALUES, 'cafe\u0301 au lait', 'ΟΔΟΣ']) {
      expect(foldTextWithOffsets(value).text).toBe(foldText(value));
    }
  });

  test('maps each folded character back to the characters it came from', () => {
    const folded = foldTextWithOffsets('Cafe\u0301 Été');
    expect(folded.text).toBe('cafe ete');
    // The `e` and its combining accent are one character of the original.
    expect([folded.starts[3], folded.ends[3]]).toEqual([3, 5]);
    expect([folded.starts[5], folded.ends[5]]).toEqual([6, 7]);
  });
});

const sqlite = new SQLiteSyncDialect();

async function libsqlEngine(): Promise<Engine> {
  const client = createClient({ url: ':memory:' });
  // LIKE compares case-sensitively, as it does on PostgreSQL.
  await client.execute('PRAGMA case_sensitive_like=ON');
  await client.execute('CREATE TABLE t (value TEXT)');
  for (const v of VALUES) await client.execute({ sql: 'INSERT INTO t (value) VALUES (?)', args: [v] });
  return {
    name: 'SQLite (libSQL)',
    postgres: false,
    async select(where) {
      const query = sqlite.sqlToQuery(sql`SELECT value FROM t WHERE ${where}`);
      const result = await client.execute({ sql: query.sql, args: query.params as never });
      return result.rows.map((row) => String(row.value)).sort();
    },
  };
}

async function sqlJsEngine(): Promise<Engine> {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE t (value TEXT)');
  for (const v of VALUES) db.run('INSERT INTO t (value) VALUES (?)', [v]);
  return {
    name: 'SQLite (sql.js, the demo)',
    postgres: false,
    async select(where) {
      const query = sqlite.sqlToQuery(sql`SELECT value FROM t WHERE ${where}`);
      const [result] = db.exec(query.sql, query.params as never);
      return (result?.values ?? []).map((row) => String(row[0])).sort();
    },
  };
}

foldedPredicates('SQLite (libSQL)', libsqlEngine);
foldedPredicates('SQLite (sql.js, the demo)', sqlJsEngine);
