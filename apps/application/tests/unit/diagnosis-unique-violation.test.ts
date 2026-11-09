import { beforeAll, describe, test, expect } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql, type SQL } from 'drizzle-orm';
import { isUniqueViolation } from '~~/server/utils/db-errors';

// The DB-level diagnosis claim converts a unique-index violation (a concurrent
// instance won the race) into a 409, so this detector recognizes that violation
// across both supported drivers, and takes no other error for one: that would
// mask a real failure as "already running".

let client: Client;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  await client.execute('PRAGMA foreign_keys = ON');
  await client.executeMultiple(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER REFERENCES parent(id),
      name TEXT UNIQUE,
      note TEXT NOT NULL DEFAULT '',
      size INTEGER CHECK (size >= 0)
    );
    INSERT INTO parent (id) VALUES (1);
    INSERT INTO child (id, parent_id, name) VALUES (1, 1, 'taken');
  `);
});

/** The error the libsql driver throws for `statement`, as it reaches a caller of the client directly. */
async function driverError(statement: string): Promise<unknown> {
  return client.execute(statement).then(
    () => expect.unreachable(`${statement} succeeded`),
    (error: unknown) => error,
  );
}

/** The error Drizzle throws for `query`: its own, wrapping the driver's. */
async function drizzleError(query: SQL): Promise<unknown> {
  return drizzle(client)
    .run(query)
    .then(
      () => expect.unreachable('the query succeeded'),
      (error: unknown) => error,
    );
}

describe('isUniqueViolation on SQLite (libsql)', () => {
  test('detects a unique index and a primary key, from the driver and through Drizzle', async () => {
    expect(isUniqueViolation(await driverError("INSERT INTO child (id, parent_id, name) VALUES (2, 1, 'taken')"))).toBe(
      true,
    );
    expect(isUniqueViolation(await driverError("INSERT INTO child (id, parent_id, name) VALUES (1, 1, 'free')"))).toBe(
      true,
    );
    expect(isUniqueViolation(await drizzleError(sql`INSERT INTO child (id, name) VALUES (3, 'taken')`))).toBe(true);
    expect(isUniqueViolation(await drizzleError(sql`INSERT INTO child (id, name) VALUES (1, 'free')`))).toBe(true);
  });

  test('does not take a foreign key, NOT NULL or CHECK failure for one, though SQLite gives them the same primary code', async () => {
    for (const statement of [
      "INSERT INTO child (id, parent_id, name) VALUES (4, 99, 'orphan')",
      "INSERT INTO child (id, name, note) VALUES (5, 'no note', NULL)",
      "INSERT INTO child (id, name, size) VALUES (6, 'negative', -1)",
    ]) {
      const error = await driverError(statement);
      expect((error as { code?: string }).code).toBe('SQLITE_CONSTRAINT');
      expect({ statement, unique: isUniqueViolation(error) }).toEqual({ statement, unique: false });
      expect({ statement, unique: isUniqueViolation(await drizzleError(sql.raw(statement))) }).toEqual({
        statement,
        unique: false,
      });
    }
  });
});

describe('isUniqueViolation on other shapes', () => {
  test('detects PostgreSQL unique_violation (SQLSTATE 23505), also under a cause', () => {
    expect(isUniqueViolation({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(true);
    expect(isUniqueViolation({ message: 'Failed query: insert …', cause: { code: '23505' } })).toBe(true);
  });

  test('reads a violation from the message when no code names the constraint, as sql.js reports one', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: failure_diagnoses.cluster_id'))).toBe(true);
    expect(
      isUniqueViolation({ message: 'Failed query: insert …', cause: new Error('UNIQUE constraint failed: t.a') }),
    ).toBe(true);
    expect(
      isUniqueViolation({ code: 'SQLITE_CONSTRAINT', message: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: t.a' }),
    ).toBe(true);
    expect(isUniqueViolation({ message: 'duplicate key' })).toBe(true);
  });

  test('does not misclassify unrelated errors', () => {
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false);
    expect(isUniqueViolation({ code: '23503', message: 'foreign key violation' })).toBe(false);
    expect(isUniqueViolation({ cause: { code: '23503', message: 'violates foreign key constraint' } })).toBe(false);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
