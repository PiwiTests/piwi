/**
 * Cross-shard lock overlap — detecting a lock held on two shards at the same
 * wall-clock time.
 *
 * Playwright serializes lock holders inside one `npx playwright test` process:
 * the held-lock set lives in that process's dispatcher, so `--shard` runs on
 * separate processes never coordinate and the same lock can be held on two
 * shards at once. Playwright cannot see this; it is the classic "passes on one
 * machine" flake. Both the per-execution failure clue and the run-wide PR
 * summary read the same overlap here.
 */

import { isExclusiveLock } from './test-locks';

/** A lock-holding execution and the wall-clock window it held its locks. */
export interface LockHolderInterval {
  id: number;
  /** The execution's shard, or null when the run was not sharded. */
  shardIndex: number | null;
  /** Epoch ms the execution started, or null when unknown. */
  startedAt: number | null;
  /** Execution duration in ms, or null when unknown. */
  duration: number | null;
  locks: string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Whether the half-open intervals `[aStart, aEnd)` and `[bStart, bEnd)` overlap. */
export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Lock names that two holders on different shards held at the same time. A
 * holder counts only when it carries a shard, a start and a duration. The
 * `-exclusive-` lock names no shared resource: its holder runs alone in its own
 * shard's run, so it is never reported. Returns the lock names sorted, without
 * duplicates.
 */
export function locksHeldAcrossShards(holders: LockHolderInterval[]): string[] {
  const usable = holders.filter(
    (h) => h.shardIndex != null && isFiniteNumber(h.startedAt) && isFiniteNumber(h.duration),
  );

  const byLock = new Map<string, LockHolderInterval[]>();
  for (const holder of usable) {
    for (const lock of new Set(holder.locks)) {
      if (isExclusiveLock(lock)) continue;
      const list = byLock.get(lock);
      if (list) list.push(holder);
      else byLock.set(lock, [holder]);
    }
  }

  const split: string[] = [];
  for (const [lock, group] of byLock) {
    if (groupSpansShards(group)) split.push(lock);
  }
  return split.sort();
}

/** Whether any two holders in one lock's group overlap in time on different shards. */
function groupSpansShards(group: LockHolderInterval[]): boolean {
  for (let i = 0; i < group.length; i++) {
    const a = group[i]!;
    const aEnd = (a.startedAt as number) + (a.duration as number);
    for (let j = i + 1; j < group.length; j++) {
      const b = group[j]!;
      if (a.shardIndex === b.shardIndex) continue;
      const bEnd = (b.startedAt as number) + (b.duration as number);
      if (intervalsOverlap(a.startedAt as number, aEnd, b.startedAt as number, bEnd)) return true;
    }
  }
  return false;
}
