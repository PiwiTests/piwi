/**
 * Balanced shards for the reporter: the split of one listing of a sharded run's
 * tests between its shards, by recorded duration and locks
 * (`partitionTestsIntoShards`), stored so that every shard of the run reads the
 * same answer.
 *
 * A shard's reporter lists the tests Playwright built before it shards them, in
 * a stable order, each with its Playwright project, file, describe path, title,
 * repetition, locks, the group Playwright runs it in and whether it is skipped.
 * A test weighs the average duration of its results in its Playwright project,
 * read as the selection catalog reads them (the final attempts of the runs the
 * `selection-catalog` use keeps, that ran it), else of its results in every
 * project, else the median of the others; a skipped test weighs nothing. Tests
 * that share a lock or a group land in one shard.
 *
 * A split is keyed by project, commit, shard count and a hash of the listing,
 * and kept for a day: the first shard to ask computes and stores it, every other
 * shard reads it, so a run landing between two shards' start changes nothing.
 */
import { and, eq, inArray, lt } from 'drizzle-orm';
import { projects, shardSplits, testCases, testRunsCases } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { eligibleExecutionAmong, ineligibleRunsInProject } from '#shared/run-eligibility';
import { finalAttemptSql, testCaseAggregates } from '#shared/handlers/test-case-aggregates';
import { partitionTestsIntoShards, type ShardableTest } from '#shared/selection';
import { joinSuitePath } from '#shared/utils/suites';
import { sha256Hex } from '#shared/utils/hash';
import { apiError } from './api-error';
import { parseCommit } from './pass-reuse-route';
import { storedIdentity, storedTestIdentity } from './storable-values';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a stored split answers the shards of a run. */
export const SHARD_SPLIT_TTL_MS = DAY_MS;
/** The most tests one listing holds. */
export const MAX_SHARD_TESTS = 100_000;
/** The most shards a split makes. */
export const MAX_SHARD_TOTAL = 1000;
/** How many test cases one duration query reads. */
const ID_CHUNK = 500;

/** One test of a listing, as the reporter names it. */
export interface ListedShardTest {
  /** Its Playwright project's name; null for a test without one. */
  project: string | null;
  /** Its file, relative to the folder of the Playwright config, as the dashboard stores it. */
  file: string;
  suitePath: string[];
  title: string;
  repeatEachIndex: number;
  locks: string[];
  /** The group Playwright runs it in, shared with the tests that must stay in its shard; null for none. */
  group: number | null;
  /** Whether Playwright skips it without running it: it weighs nothing. */
  skipped: boolean;
}

export interface ShardSplitRequest {
  /** The commit the shards run; '' when the reporter names none. */
  commit: string;
  shardTotal: number;
  tests: ListedShardTest[];
}

/** A split as stored in `shard_splits.split`. */
export interface StoredShardSplit {
  /** The shard (from 1) of each listed test, in the listing's order. */
  shards: number[];
  /** The summed recorded durations of each shard's tests, in ms. */
  durationsMs: number[];
}

function bad(message: string): never {
  throw apiError({ statusCode: 400, message });
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
}

/** A listing a request sends; 400 on a malformed one. */
export function parseShardSplitRequest(body: Record<string, unknown>): ShardSplitRequest {
  const shardTotal = body.shardTotal;
  if (
    typeof shardTotal !== 'number' ||
    !Number.isInteger(shardTotal) ||
    shardTotal < 2 ||
    shardTotal > MAX_SHARD_TOTAL
  ) {
    bad(`shardTotal must be a whole number from 2 to ${MAX_SHARD_TOTAL}`);
  }
  if (!Array.isArray(body.tests) || body.tests.length === 0) bad('tests must list the run’s tests');
  if (body.tests.length > MAX_SHARD_TESTS) bad(`A listing holds at most ${MAX_SHARD_TESTS} tests`);
  const tests = body.tests.map((entry): ListedShardTest => {
    const item = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    if (typeof item.file !== 'string' || !item.file || typeof item.title !== 'string') {
      bad('Each test needs its file and title');
    }
    const repeat = item.repeatEachIndex;
    const group = item.group;
    return {
      project: typeof item.project === 'string' ? item.project : null,
      file: item.file,
      suitePath: strings(item.suitePath),
      title: item.title,
      repeatEachIndex: typeof repeat === 'number' && Number.isInteger(repeat) && repeat >= 0 ? repeat : 0,
      locks: strings(item.locks),
      group: typeof group === 'number' && Number.isInteger(group) && group >= 0 ? group : null,
      skipped: item.skipped === true,
    };
  });
  return { commit: parseCommit(body.commit) ?? '', shardTotal, tests };
}

/** The hash a listing is stored under: of every field of each test, in the order listed. */
export function shardListingHash(tests: ListedShardTest[]): Promise<string> {
  return sha256Hex(JSON.stringify(tests));
}

/**
 * The average recorded duration of each listed test in its Playwright project, else in every project, else null;
 * 0 for a skipped test.
 */
async function listedDurations(
  db: DrizzleDB,
  projectId: number,
  tests: ListedShardTest[],
): Promise<Array<number | null>> {
  const cases = await db
    .select({ id: testCases.id, filePath: testCases.filePath, suitePath: testCases.suitePath, title: testCases.title })
    .from(testCases)
    .where(eq(testCases.projectId, projectId));
  const idOf = new Map(cases.map((c) => [`${c.filePath}\x00${c.suitePath ?? ''}\x00${c.title}`, c.id]));
  const matched = await Promise.all(
    tests.map(async (test) => {
      const stored = await storedTestIdentity({ filePath: test.file, suitePath: test.suitePath, title: test.title });
      const id = idOf.get(`${stored.filePath}\x00${joinSuitePath(stored.suitePath)}\x00${stored.title}`) ?? null;
      return { id, project: test.project === null ? '' : await storedIdentity(test.project) };
    }),
  );

  const inProject = new Map<string, number>();
  const overall = new Map<number, { sum: number; ran: number }>();
  const ids = [...new Set(matched.map((m) => m.id).filter((id): id is number => id !== null))];
  const ineligible = ineligibleRunsInProject(db, 'selection-catalog', projectId);
  const aggregates = testCaseAggregates();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await db
      .with(ineligible)
      .select({
        testCaseId: testRunsCases.testCaseId,
        browserName: testRunsCases.browserName,
        avgDuration: aggregates.avgDuration,
        totalRuns: aggregates.totalRuns,
        skippedRuns: aggregates.skippedRuns,
        didNotRunRuns: aggregates.didNotRunRuns,
      })
      .from(testRunsCases)
      .where(
        and(
          inArray(testRunsCases.testCaseId, ids.slice(i, i + ID_CHUNK)),
          eligibleExecutionAmong(testRunsCases.testRunId, ineligible),
          finalAttemptSql(),
        ),
      )
      .groupBy(testRunsCases.testCaseId, testRunsCases.browserName);
    for (const row of rows) {
      if (row.avgDuration == null) continue;
      const avg = Number(row.avgDuration);
      const ran = Number(row.totalRuns ?? 0) - Number(row.skippedRuns ?? 0) - Number(row.didNotRunRuns ?? 0);
      if (!Number.isFinite(avg) || ran <= 0) continue;
      inProject.set(`${row.testCaseId}\x00${row.browserName ?? ''}`, avg);
      const total = overall.get(row.testCaseId) ?? { sum: 0, ran: 0 };
      overall.set(row.testCaseId, { sum: total.sum + avg * ran, ran: total.ran + ran });
    }
  }

  return tests.map((test, index) => {
    if (test.skipped) return 0;
    const { id, project } = matched[index]!;
    if (id === null) return null;
    const own = inProject.get(`${id}\x00${project}`);
    if (own !== undefined) return Math.round(own);
    const all = overall.get(id);
    return all ? Math.round(all.sum / all.ran) : null;
  });
}

/** Split a listing between `shardTotal` shards. */
export async function computeShardSplit(
  db: DrizzleDB,
  projectId: number,
  request: ShardSplitRequest,
): Promise<StoredShardSplit> {
  const durations = await listedDurations(db, projectId, request.tests);
  const rows: ShardableTest[] = request.tests.map((test, index) => ({
    id: index,
    filePath: test.file,
    suitePath: joinSuitePath(test.suitePath),
    title: test.title,
    avgDurationMs: durations[index] ?? null,
    locks: test.locks,
    ...(test.group !== null ? { group: test.group } : {}),
  }));
  const shards = new Array<number>(rows.length).fill(0);
  const durationsMs = new Array<number>(request.shardTotal).fill(0);
  partitionTestsIntoShards(rows, request.shardTotal).forEach((bucket, shardIndex) => {
    for (const row of bucket) {
      shards[row.id] = shardIndex + 1;
      durationsMs[shardIndex] = (durationsMs[shardIndex] ?? 0) + (row.avgDurationMs ?? 0);
    }
  });
  return { shards, durationsMs };
}

/**
 * The split of a listing: the one stored under its key, else computed and stored, deleting the project's expired
 * splits first. Of two shards that compute it at once, both answer the one stored first. Null for a project that does
 * not exist.
 */
export async function getShardSplit(
  db: DrizzleDB,
  projectId: number,
  request: ShardSplitRequest,
  now: Date = new Date(),
): Promise<(StoredShardSplit & { expiresAt: Date }) | null> {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!project) return null;
  const testsHash = await shardListingHash(request.tests);
  await db.delete(shardSplits).where(and(eq(shardSplits.projectId, projectId), lt(shardSplits.expiresAt, now)));
  const key = and(
    eq(shardSplits.projectId, projectId),
    eq(shardSplits.commitSha, request.commit),
    eq(shardSplits.shardTotal, request.shardTotal),
    eq(shardSplits.testsHash, testsHash),
  );
  const read = async () => {
    const [row] = await db
      .select({ split: shardSplits.split, expiresAt: shardSplits.expiresAt })
      .from(shardSplits)
      .where(key);
    return row ? { ...(row.split as StoredShardSplit), expiresAt: row.expiresAt } : null;
  };
  const stored = await read();
  if (stored) return stored;

  const split = await computeShardSplit(db, projectId, request);
  await db
    .insert(shardSplits)
    .values({
      projectId,
      commitSha: request.commit,
      shardTotal: request.shardTotal,
      testsHash,
      split,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SHARD_SPLIT_TTL_MS),
    })
    .onConflictDoNothing({
      target: [shardSplits.projectId, shardSplits.commitSha, shardSplits.shardTotal, shardSplits.testsHash],
    });
  return (await read()) ?? { ...split, expiresAt: new Date(now.getTime() + SHARD_SPLIT_TTL_MS) };
}
