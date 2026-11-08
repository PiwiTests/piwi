import { describe, expect, test } from 'vitest';
import { addRunTagsTruncated, carryTagsTruncated, withoutTagsTruncated } from '#shared/tags-truncated';

const a = { filePath: 'a.spec.ts', title: 'A', dropped: 1 };
const b = { filePath: 'b.spec.ts', title: 'B', dropped: 2 };

describe('carryTagsTruncated', () => {
  test('counts a report the reporter sends again once', () => {
    const stored = { tagsTruncated: { tests: 25, examples: [a, b] } };
    const next = { branch: 'main', tagsTruncated: { tests: 25, examples: [a, b] } };
    expect(carryTagsTruncated(next, stored)).toEqual(next);
  });

  test('keeps what ingest recorded when the reporter metadata replaces the stored one', () => {
    expect(carryTagsTruncated({ branch: 'main' }, { tagsTruncated: { tests: 1, examples: [a] } })).toEqual({
      branch: 'main',
      tagsTruncated: { tests: 1, examples: [a] },
    });
  });

  test('leaves metadata without cut tags as it is, and drops a malformed report', () => {
    const next = { branch: 'main' };
    expect(carryTagsTruncated(next, { other: 1 })).toBe(next);
    expect(carryTagsTruncated(null, null)).toBeNull();
    expect(carryTagsTruncated({ branch: 'main', tagsTruncated: 'lots' }, null)).toEqual({ branch: 'main' });
  });
});

describe('addRunTagsTruncated', () => {
  test("adds another shard's tests to the run's", () => {
    const run = { branch: 'main', tagsTruncated: { tests: 3, examples: [a] } };
    expect(addRunTagsTruncated(run, { tagsTruncated: { tests: 2, examples: [b] } })).toEqual({
      branch: 'main',
      tagsTruncated: { tests: 5, examples: [a, b] },
    });
  });

  test('leaves the run as it is when the shard sent none', () => {
    const run = { branch: 'main' };
    expect(addRunTagsTruncated(run, undefined)).toEqual(run);
    expect(addRunTagsTruncated(run, { other: 1 })).toEqual(run);
  });
});

describe('withoutTagsTruncated', () => {
  test("takes a batch shard's report out of the run it creates", () => {
    expect(withoutTagsTruncated({ branch: 'main', tagsTruncated: { tests: 1, examples: [a] } })).toEqual({
      branch: 'main',
    });
    expect(withoutTagsTruncated(null)).toBeNull();
  });
});
