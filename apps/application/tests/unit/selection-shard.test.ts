import { describe, test, expect } from 'vitest';
import { partitionTestsIntoShards, locksSpanningTests, type ShardableTest } from '#shared/selection';

/** Build a shardable test; file path defaults to a per-id spec so ordering is stable. */
function t(id: number, avgDurationMs: number | null, locks: string[] = [], filePath?: string): ShardableTest {
  return { id, filePath: filePath ?? `tests/t${id}.spec.ts`, suitePath: '', title: `test ${id}`, avgDurationMs, locks };
}

/** The set of ids in each shard, for order-independent assertions. */
function idSets(shards: ShardableTest[][]): Set<number>[] {
  return shards.map((shard) => new Set(shard.map((row) => row.id)));
}

/** The shard index a given id landed in. */
function shardOf(shards: ShardableTest[][], id: number): number {
  return shards.findIndex((shard) => shard.some((row) => row.id === id));
}

describe('partitionTestsIntoShards', () => {
  test('with no locks, balances by duration (longest-processing-time first)', () => {
    const rows = [t(1, 30), t(2, 20), t(3, 20), t(4, 10)];
    const shards = partitionTestsIntoShards(rows, 2);
    // 30→s0, 20→s1, 20→s1, 10→s0 ⇒ both shards sum to 40.
    expect(idSets(shards)).toEqual([new Set([1, 4]), new Set([2, 3])]);
  });

  test('spreads tests with no recorded duration across shards at the median duration', () => {
    const fresh = partitionTestsIntoShards([t(1, null), t(2, null), t(3, null), t(4, null)], 2);
    expect(fresh.map((shard) => shard.length)).toEqual([2, 2]);

    // The unknown tests weigh the median, 20: 30→s0, 20→s1, 20→s1 (40), 10→s0 (40).
    const mixed = partitionTestsIntoShards([t(1, 30), t(2, 10), t(3, null), t(4, null)], 2);
    expect(idSets(mixed)).toEqual([new Set([1, 2]), new Set([3, 4])]);
  });

  test('with no locks, every test lands in exactly one shard', () => {
    const rows = [t(1, 5), t(2, 7), t(3, 3), t(4, 9), t(5, 1)];
    const shards = partitionTestsIntoShards(rows, 3);
    const all = shards.flatMap((s) => s.map((r) => r.id)).sort((a, b) => a - b);
    expect(all).toEqual([1, 2, 3, 4, 5]);
  });

  test('keeps tests that share a lock in the same shard', () => {
    const rows = [t(1, 10, ['db']), t(2, 10), t(3, 10, ['db']), t(4, 10)];
    const shards = partitionTestsIntoShards(rows, 2);
    expect(shardOf(shards, 1)).toBe(shardOf(shards, 3));
  });

  test('groups locks transitively — a test carrying two locks joins both groups', () => {
    const rows = [t(1, 10, ['x']), t(2, 10, ['x', 'y']), t(3, 10, ['y']), t(4, 10), t(5, 10)];
    const shards = partitionTestsIntoShards(rows, 3);
    const home = shardOf(shards, 1);
    expect(shardOf(shards, 2)).toBe(home);
    expect(shardOf(shards, 3)).toBe(home);
  });

  test('an oversized lock group still goes to a single shard', () => {
    const rows = [t(1, 100, ['heavy']), t(2, 100, ['heavy']), t(3, 100, ['heavy']), t(4, 10), t(5, 10), t(6, 10)];
    const shards = partitionTestsIntoShards(rows, 3);
    const home = shardOf(shards, 1);
    // All three heavy holders share one shard even though it dwarfs a fair share.
    expect(shardOf(shards, 2)).toBe(home);
    expect(shardOf(shards, 3)).toBe(home);
  });

  test('is deterministic for the same input', () => {
    const rows = [t(1, 30, ['a']), t(2, 15), t(3, 15, ['a']), t(4, 40), t(5, 5, ['b']), t(6, 5, ['b'])];
    const first = partitionTestsIntoShards(rows, 3);
    const second = partitionTestsIntoShards([...rows].reverse(), 3);
    expect(first).toEqual(second);
  });

  test('returns tests within a shard in stable order', () => {
    const rows = [t(3, 10, [], 'tests/c.spec.ts'), t(1, 10, [], 'tests/a.spec.ts'), t(2, 10, [], 'tests/b.spec.ts')];
    const shards = partitionTestsIntoShards(rows, 1);
    expect(shards[0]!.map((r) => r.filePath)).toEqual(['tests/a.spec.ts', 'tests/b.spec.ts', 'tests/c.spec.ts']);
  });

  test('treats a null duration as zero weight', () => {
    const rows = [t(1, null, ['db']), t(2, null, ['db']), t(3, 100)];
    const shards = partitionTestsIntoShards(rows, 2);
    expect(shardOf(shards, 1)).toBe(shardOf(shards, 2));
    // The single heavy test lands alone on the other shard.
    expect(shardOf(shards, 3)).not.toBe(shardOf(shards, 1));
  });

  test('total below one yields an empty partition', () => {
    expect(partitionTestsIntoShards([t(1, 10)], 0)).toEqual([]);
  });
});

describe('locksSpanningTests', () => {
  test('reports a lock held by more than one test', () => {
    const rows = [t(1, 10, ['db']), t(2, 10, ['db']), t(3, 10, ['cache'])];
    expect(locksSpanningTests(rows)).toEqual(['db']);
  });

  test('ignores a lock held by a single test', () => {
    const rows = [t(1, 10, ['db']), t(2, 10, ['cache'])];
    expect(locksSpanningTests(rows)).toEqual([]);
  });

  test('counts a lock declared twice on one test only once', () => {
    const rows = [t(1, 10, ['db', 'db']), t(2, 10)];
    expect(locksSpanningTests(rows)).toEqual([]);
  });

  test('returns spanning locks sorted, without duplicates', () => {
    const rows = [t(1, 10, ['z', 'a']), t(2, 10, ['a', 'z']), t(3, 10, ['a'])];
    expect(locksSpanningTests(rows)).toEqual(['a', 'z']);
  });
});
