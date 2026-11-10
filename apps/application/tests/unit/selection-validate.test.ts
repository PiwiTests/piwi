import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test, expect } from 'vitest';
import {
  parseShard,
  RESERVED_SELECTION_KEYS,
  validateSelectionDefinition,
  validateSelectionKey,
} from '#shared/selection';

describe('parseShard', () => {
  test('parses a valid i/n spec', () => {
    expect(parseShard('2/4')).toEqual({ index: 2, total: 4 });
    expect(parseShard(' 1 / 3 ')).toEqual({ index: 1, total: 3 });
    expect(parseShard('1000/1000')).toEqual({ index: 1000, total: 1000 });
  });

  test('rejects out-of-range and malformed specs', () => {
    for (const bad of ['0/4', '5/4', '4/0', 'a/b', '2', '2/', '', 2, null, '1/100000000', '1/1001']) {
      expect(parseShard(bad as unknown), String(bad)).toBeNull();
    }
  });
});

describe('validateSelectionKey', () => {
  test('accepts lowercase slugs', () => {
    for (const key of ['smoke', 'critical-path', 'p0', 'a', 'nightly-2']) {
      expect(validateSelectionKey(key).valid, key).toBe(true);
    }
  });

  test('rejects bad slugs', () => {
    for (const key of ['Smoke', 'has space', 'under_score', '-leading', 'x'.repeat(65), '', 42]) {
      expect(validateSelectionKey(key as unknown).valid, String(key)).toBe(false);
    }
  });

  test('reserves the name of every literal route beside the selection route', () => {
    const folder = resolve(import.meta.dirname, '../../server/api/projects/[id]/selections');
    const literal = new Set(
      readdirSync(folder)
        .filter((file) => !file.startsWith('['))
        .map((file) => file.replace(/\.(get|post|patch|put|delete)\.ts$/, '')),
    );
    expect(literal.size).toBeGreaterThan(0);
    expect([...RESERVED_SELECTION_KEYS].sort()).toEqual([...literal].sort());
    for (const key of literal) {
      expect(validateSelectionKey(key)).toMatchObject({ valid: false, error: expect.stringContaining(key) });
    }
  });
});

describe('validateSelectionDefinition', () => {
  test('accepts a rich but valid definition', () => {
    const result = validateSelectionDefinition({
      include: [{ tags: ['smoke'] }, { priority: ['critical', 'high'], maxAvgDurationMs: 15000 }],
      exclude: [{ quarantined: true }, { files: ['tests/experimental/**'] }],
      pins: { add: [412, 907], remove: [55] },
      budget: { maxTotalDurationMs: 300000, rankBy: 'failureLikelihood' },
      limit: 200,
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test('accepts an empty definition (all tests)', () => {
    expect(validateSelectionDefinition({}).valid).toBe(true);
  });

  test('rejects an unknown top-level key', () => {
    const result = validateSelectionDefinition({ includ: [] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unknown key "includ"/);
  });

  test('rejects an unknown predicate rather than ignoring it', () => {
    const result = validateSelectionDefinition({ include: [{ tag: ['smoke'] }] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unknown predicate "tag"/);
  });

  test('rejects an out-of-range pass rate', () => {
    expect(validateSelectionDefinition({ include: [{ minPassRate: 2 }] }).valid).toBe(false);
    expect(validateSelectionDefinition({ include: [{ minPassRate: -0.1 }] }).valid).toBe(false);
    expect(validateSelectionDefinition({ include: [{ minPassRate: 0.99 }] }).valid).toBe(true);
  });

  test('rejects a bad failedInLastRuns window', () => {
    expect(validateSelectionDefinition({ include: [{ failedInLastRuns: 0 }] }).valid).toBe(false);
    expect(validateSelectionDefinition({ include: [{ failedInLastRuns: 26 }] }).valid).toBe(false);
    expect(validateSelectionDefinition({ include: [{ failedInLastRuns: 3 }] }).valid).toBe(true);
  });

  test('rejects an unknown rankBy and a non-positive limit', () => {
    expect(validateSelectionDefinition({ budget: { rankBy: 'random' } }).valid).toBe(false);
    expect(validateSelectionDefinition({ limit: 0 }).valid).toBe(false);
    expect(validateSelectionDefinition({ limit: 1.5 }).valid).toBe(false);
  });

  test('rejects non-integer pin ids', () => {
    expect(validateSelectionDefinition({ pins: { add: [1.5] } }).valid).toBe(false);
    expect(validateSelectionDefinition({ pins: { remove: [-3] } }).valid).toBe(false);
    expect(validateSelectionDefinition({ pins: { extra: [1] } }).valid).toBe(false);
  });

  test('holds a files list to 100 globs of at most 500 characters, and names the limit', () => {
    const glob = (length: number) => `tests/${'*'.repeat(length - 6)}`;
    expect(validateSelectionDefinition({ include: [{ files: [glob(500)] }] }).valid).toBe(true);
    expect(validateSelectionDefinition({ include: [{ files: Array.from({ length: 100 }, () => glob(500)) }] })).toEqual(
      { valid: true, errors: [] },
    );
    expect(validateSelectionDefinition({ exclude: [{ files: ['a', glob(501)] }] }).errors).toEqual([
      'exclude[0].files: a glob must be at most 500 characters',
    ]);
    expect(
      validateSelectionDefinition({ include: [{ files: Array.from({ length: 101 }, () => 'a') }] }).errors,
    ).toEqual(['include[0].files must hold at most 100 globs']);
  });

  test('collects every problem, not just the first', () => {
    const result = validateSelectionDefinition({ include: [{ tag: ['a'], nope: 1 }], limit: 0 });
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
