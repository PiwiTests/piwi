import { describe, test, expect } from 'vitest';
import { intervalsOverlap, locksHeldAcrossShards, type LockHolderInterval } from '#shared/lock-overlap';

function holder(overrides: Partial<LockHolderInterval> = {}): LockHolderInterval {
  return { id: 1, shardIndex: 1, startedAt: 0, duration: 100, locks: ['db'], ...overrides };
}

describe('intervalsOverlap', () => {
  test('overlapping windows', () => {
    expect(intervalsOverlap(0, 100, 50, 150)).toBe(true);
  });
  test('touching windows do not overlap (half-open)', () => {
    expect(intervalsOverlap(0, 100, 100, 200)).toBe(false);
  });
  test('disjoint windows', () => {
    expect(intervalsOverlap(0, 50, 60, 100)).toBe(false);
  });
});

describe('locksHeldAcrossShards', () => {
  test('reports a lock held on two shards at overlapping times', () => {
    const held = locksHeldAcrossShards([
      holder({ id: 1, shardIndex: 1, startedAt: 0, duration: 100 }),
      holder({ id: 2, shardIndex: 2, startedAt: 50, duration: 100 }),
    ]);
    expect(held).toEqual(['db']);
  });

  test('ignores holders on the same shard', () => {
    const held = locksHeldAcrossShards([
      holder({ id: 1, shardIndex: 1, startedAt: 0, duration: 100 }),
      holder({ id: 2, shardIndex: 1, startedAt: 50, duration: 100 }),
    ]);
    expect(held).toEqual([]);
  });

  test('ignores non-overlapping holders on different shards', () => {
    const held = locksHeldAcrossShards([
      holder({ id: 1, shardIndex: 1, startedAt: 0, duration: 100 }),
      holder({ id: 2, shardIndex: 2, startedAt: 200, duration: 100 }),
    ]);
    expect(held).toEqual([]);
  });

  test('ignores holders with no shard index (unsharded run)', () => {
    const held = locksHeldAcrossShards([
      holder({ id: 1, shardIndex: null, startedAt: 0, duration: 100 }),
      holder({ id: 2, shardIndex: null, startedAt: 50, duration: 100 }),
    ]);
    expect(held).toEqual([]);
  });

  test('never reports the -exclusive- lock, whose holder runs alone in its own shard', () => {
    const held = locksHeldAcrossShards([
      holder({ id: 1, shardIndex: 1, startedAt: 0, duration: 100, locks: ['-exclusive-'] }),
      holder({ id: 2, shardIndex: 2, startedAt: 50, duration: 100, locks: ['-exclusive-'] }),
    ]);
    expect(held).toEqual([]);
  });

  test('matches per lock, and returns sorted unique names', () => {
    const held = locksHeldAcrossShards([
      holder({ id: 1, shardIndex: 1, startedAt: 0, duration: 100, locks: ['z', 'a'] }),
      holder({ id: 2, shardIndex: 2, startedAt: 50, duration: 100, locks: ['a', 'z'] }),
      holder({ id: 3, shardIndex: 3, startedAt: 500, duration: 100, locks: ['solo'] }),
    ]);
    expect(held).toEqual(['a', 'z']);
  });
});
