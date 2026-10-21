import { describe, test, expect } from 'vitest';
import { isUniqueViolation } from '~~/server/utils/db-errors';

// The DB-level diagnosis claim converts a unique-index violation (a concurrent
// instance won the race) into a 409, so this detector must recognise the shape
// of that violation across both supported drivers — and NOT misclassify unrelated
// errors, which would mask real failures as "already running".
describe('isUniqueViolation', () => {
  test('detects PostgreSQL unique_violation (SQLSTATE 23505)', () => {
    expect(isUniqueViolation({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(true);
  });

  test('detects SQLite constraint violations by code', () => {
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT' })).toBe(true);
  });

  test('detects violations reported only in the message', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: failure_diagnoses.cluster_id'))).toBe(true);
    expect(isUniqueViolation({ message: 'duplicate key' })).toBe(true);
  });

  test('unwraps a driver code nested under cause', () => {
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
  });

  test('does not misclassify unrelated errors', () => {
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false);
    expect(isUniqueViolation({ code: '23503', message: 'foreign key violation' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
