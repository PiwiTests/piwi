/**
 * Lock-aware, duration-balanced sharding of a resolved test list.
 *
 * Playwright serializes lock holders inside one `npx playwright test` process
 * only: two `--shard` runs are separate processes with no shared held-lock set,
 * so a lock declared on tests split across shards can be held on both at once.
 * Keeping every test that shares a lock in the same shard restores that
 * guarantee. Tests are first grouped by lock (transitively — a lock shared
 * between two tests binds them, and a test carrying two locks binds their
 * groups), then each group is placed whole with longest-processing-time
 * balancing: the heaviest group goes to the lightest shard. A group heavier than
 * a shard's fair share still lands on one shard; balance is best effort, the
 * lock guarantee is not. A test with no recorded duration weighs the median
 * recorded one (1 ms when none has one), so new tests spread across shards.
 */

/** The fields the balancer reads from a resolved test. */
export interface ShardableTest {
  id: number;
  filePath: string;
  suitePath: string;
  title: string;
  avgDurationMs: number | null;
  locks: string[];
}

/** Deterministic base order — file, then suite, then title, then id. */
export function stableTestCompare(a: ShardableTest, b: ShardableTest): number {
  return (
    a.filePath.localeCompare(b.filePath) ||
    a.suitePath.localeCompare(b.suitePath) ||
    a.title.localeCompare(b.title) ||
    a.id - b.id
  );
}

/** The stable-least test of a non-empty group, used as a deterministic tiebreak. */
function representative<T extends ShardableTest>(tests: T[]): T {
  return tests.reduce((least, t) => (stableTestCompare(t, least) < 0 ? t : least));
}

/**
 * Partition tests into connected components: two tests are in the same component
 * when they share a lock name, transitively. A test with no locks is its own
 * singleton component. Uses union-find keyed by array index.
 */
function groupByLock<T extends ShardableTest>(rows: T[]): T[][] {
  const parent = rows.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const firstHolder = new Map<string, number>();
  rows.forEach((row, i) => {
    for (const lock of row.locks) {
      const seen = firstHolder.get(lock);
      if (seen === undefined) firstHolder.set(lock, i);
      else union(seen, i);
    }
  });

  const groups = new Map<number, T[]>();
  rows.forEach((row, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(row);
    else groups.set(root, [row]);
  });
  return [...groups.values()];
}

/** The weight of a test with no recorded duration: the median recorded one, or 1 ms when none has one. */
function unknownDurationWeight(rows: ShardableTest[]): number {
  const known = rows
    .map((t) => t.avgDurationMs)
    .filter((d): d is number => d != null && d > 0)
    .sort((a, b) => a - b);
  if (known.length === 0) return 1;
  const mid = known.length >> 1;
  return known.length % 2 ? known[mid]! : (known[mid - 1]! + known[mid]!) / 2;
}

/**
 * Split rows into `total` shards balanced by summed average duration, keeping
 * every test that shares a lock in the same shard. Deterministic for the same
 * input: groups are placed heaviest-first (ties broken by their stable-least
 * test), each onto the currently lightest shard (ties broken by the lower shard
 * index), and each shard's tests are returned in stable order.
 */
export function partitionTestsIntoShards<T extends ShardableTest>(rows: T[], total: number): T[][] {
  const buckets: T[][] = Array.from({ length: total }, () => []);
  if (total < 1) return buckets;

  const unknownWeight = unknownDurationWeight(rows);
  const groups = groupByLock(rows).map((tests) => ({
    tests,
    weight: tests.reduce((sum, t) => sum + (t.avgDurationMs ?? unknownWeight), 0),
    rep: representative(tests),
  }));
  groups.sort((a, b) => b.weight - a.weight || stableTestCompare(a.rep, b.rep));

  const loads = new Array<number>(total).fill(0);
  for (const group of groups) {
    let lightest = 0;
    for (let i = 1; i < total; i++) if (loads[i]! < loads[lightest]!) lightest = i;
    buckets[lightest]!.push(...group.tests);
    loads[lightest] = loads[lightest]! + group.weight;
  }
  return buckets.map((bucket) => bucket.sort(stableTestCompare));
}

/**
 * Lock names shared by two or more of these tests — the locks that plain
 * file-count sharding (Playwright's own `--shard`) could split across shards,
 * letting the same lock be held on two shards at once. A lock held by a single
 * test cannot be split, so it is not reported.
 */
export function locksSpanningTests(rows: ShardableTest[]): string[] {
  const holders = new Map<string, number>();
  for (const row of rows) {
    for (const lock of new Set(row.locks)) holders.set(lock, (holders.get(lock) ?? 0) + 1);
  }
  return [...holders.entries()]
    .filter(([, count]) => count > 1)
    .map(([lock]) => lock)
    .sort();
}
