/**
 * Balanced shards (`balanceShards`, Playwright 1.62 and later). Before Playwright shards a run, the reporter's
 * `preprocess` lists the tests it can change, in a stable order, and asks the dashboard how to split them; with an
 * answer that covers every listed test, it takes sharding from Playwright (`testRun.skipSharding`) and excludes the
 * tests of the other shards (`testRun.exclude`), a whole suite when none of its tests is this shard's, so a project
 * left with none of them starts no setup project. Without one, Playwright splits the run as usual.
 *
 * The dashboard keys the split by project, commit, shard count and the listing's hash, and keeps it for a day, so
 * every shard of the run, listing the same tests, reads the same answer.
 */
import { execFileSync } from 'node:child_process';
import type { Suite, TestCase } from '@playwright/test/reporter';
import { detectCliNarrowingFlags } from './cli-filters.js';
import type { DashboardAsk } from './test-run-edits.js';

/** The part of Playwright's `TestRun` balanced shards use. */
export interface ShardingTestRun {
  skipSharding?: () => void;
  exclude?: (test: TestCase | Suite) => void;
}

/**
 * Why a sharded run with `balanceShards` on is left to Playwright's own split, as the line to log; null when the
 * reporter asks the dashboard. `argv` is the runner's command line.
 */
export function balancedShardsRefusal(testRun: ShardingTestRun, argv: string[]): string | null {
  if (typeof testRun.skipSharding !== 'function' || typeof testRun.exclude !== 'function') {
    return 'balanceShards needs Playwright 1.62 or later: Playwright splits this run.';
  }
  const narrowing = detectCliNarrowingFlags(argv);
  if (narrowing.length > 0) {
    const flags = narrowing.map((flag) => `--${flag}`).join(' and ');
    return `balanceShards stands aside for ${flags}, whose selection differs per machine: Playwright splits this run.`;
  }
  return null;
}

/** One test of a listing, as the dashboard takes it; empty fields are left out. */
export interface ListedShardTest {
  project: string | null;
  file: string;
  suitePath?: string[];
  title: string;
  repeatEachIndex?: number;
  locks?: string[];
  group: number;
  skipped?: true;
}

/** What the listing reads of each test. */
export interface ShardTestInfo {
  project: string | null;
  /** Its file as the run reports it: relative to the folder of the Playwright config, POSIX separators. */
  file: string;
  suitePath: string[];
  locks: string[];
  /** The key of the group Playwright runs it in (`MetadataCollector.shardGroup`). */
  group: string;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The listing of `tests`, in a stable order (project, file, describe path, title, repetition, line, column), and the
 * tests in that order. Each group's tests share the number it is first met with in that order.
 */
export function listShardTests(
  tests: readonly TestCase[],
  info: (test: TestCase) => ShardTestInfo,
): { listed: ListedShardTest[]; order: TestCase[] } {
  const rows = tests.map((test) => ({ test, info: info(test) }));
  rows.sort(
    (a, b) =>
      compareText(a.info.project ?? '', b.info.project ?? '') ||
      compareText(a.info.file, b.info.file) ||
      compareText(a.info.suitePath.join('\x1f'), b.info.suitePath.join('\x1f')) ||
      compareText(a.test.title, b.test.title) ||
      a.test.repeatEachIndex - b.test.repeatEachIndex ||
      a.test.location.line - b.test.location.line ||
      a.test.location.column - b.test.location.column,
  );
  const groups = new Map<string, number>();
  const listed = rows.map(({ test, info: row }): ListedShardTest => {
    let group = groups.get(row.group);
    if (group === undefined) {
      group = groups.size;
      groups.set(row.group, group);
    }
    return {
      project: row.project,
      file: row.file,
      ...(row.suitePath.length > 0 ? { suitePath: row.suitePath } : {}),
      title: test.title,
      ...(test.repeatEachIndex > 0 ? { repeatEachIndex: test.repeatEachIndex } : {}),
      ...(row.locks.length > 0 ? { locks: row.locks } : {}),
      group,
      ...(test.expectedStatus === 'skipped' ? { skipped: true as const } : {}),
    };
  });
  return { listed, order: rows.map((row) => row.test) };
}

/** The commit the checkout in `dir` is at; null outside a git checkout. */
export function checkoutCommit(dir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{7,64}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * The shard of each listed test, from the dashboard's answer: throws unless it names one shard, from 1 to `total`,
 * for each of the `count` listed tests.
 */
export function readShardSplit(answer: unknown, count: number, total: number): number[] {
  const shards = (answer as { shards?: unknown } | null)?.shards;
  if (!Array.isArray(shards) || shards.length !== count) {
    throw new Error(`the dashboard's split does not cover the ${count} listed tests`);
  }
  if (!shards.every((shard) => Number.isInteger(shard) && shard >= 1 && shard <= total)) {
    throw new Error(`the dashboard's split names a shard outside 1 to ${total}`);
  }
  return shards as number[];
}

/** Ask the dashboard how to split `listed` between `total` shards; the shard of each listed test. */
export async function fetchShardSplit(
  ask: DashboardAsk,
  body: { commit: string | null; shardTotal: number; tests: ListedShardTest[] },
): Promise<{ shards: number[]; durationsMs: number[] | null }> {
  const answer = await ask.http.postJSON(`/api/projects/${ask.projectId}/shard-split`, body, ask.auth, ask.signal);
  const shards = readShardSplit(answer, body.tests.length, body.shardTotal);
  const durations = (answer as { durationsMs?: unknown }).durationsMs;
  const durationsMs =
    Array.isArray(durations) && durations.every((d) => typeof d === 'number' && Number.isFinite(d))
      ? (durations as number[])
      : null;
  return { shards, durationsMs };
}

/**
 * Keep the tests of `keep` alone in the run, once sharding is taken from Playwright: exclude every other test of
 * `projects`, the project suites the run can change, a whole suite at once when none of its tests is kept.
 */
export function keepShardTests(
  testRun: Pick<Required<ShardingTestRun>, 'exclude'>,
  projects: readonly Suite[],
  keep: ReadonlySet<TestCase>,
): void {
  // Each list is copied first: excluding a suite or a test detaches it from its parent's.
  const prune = (suite: Suite): void => {
    for (const child of suite.suites.slice()) {
      if (!child.allTests().some((test) => keep.has(test))) testRun.exclude(child);
      else prune(child);
    }
    for (const test of suite.tests.slice()) if (!keep.has(test)) testRun.exclude(test);
  };
  for (const project of projects) {
    if (!project.allTests().some((test) => keep.has(test))) testRun.exclude(project);
    else prune(project);
  }
}

/** A duration in whole minutes, or seconds under a minute, for a log line. */
export function roughDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
}
