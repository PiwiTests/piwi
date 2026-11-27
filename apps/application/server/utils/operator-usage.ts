import { and, count, desc, gte, inArray, isNotNull, lte, max, sql } from 'drizzle-orm';
import type { DrizzleDB } from '#shared/handlers/db';
import { UNFINISHED_RUN_STATUSES } from '#shared/run-eligibility';
import { files, projects, testRuns, users } from '../database/schema';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the reporter versions are counted. */
export const REPORTER_VERSIONS_DAYS = 90;
/** The most reporter versions listed, and the longest taken: a version is what a reporter says, unchecked. */
const REPORTER_VERSIONS_MAX = 50;
const REPORTER_VERSION_MAX_LENGTH = 40;
/** A version as a release names it: `0.77.0`, a prerelease or build suffix allowed. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** What a restart would cut now, counted: the same as the admin activity route, without a run's details. */
export interface OperatorNow {
  runsInProgress: number;
  /** When a run in progress last reported anything; null with none. */
  lastRunActivityAt: Date | null;
  requestsInProgress: number;
  diagnosesInProgress: number;
  assistantAnswersInProgress: number;
  openEventStreams: number;
}

/** The instance's usage, in counts only: no name, address, result or file. */
export interface OperatorUsage {
  now: OperatorNow;
  projects: number;
  users: number;
  /** Runs by when they started: in all, in the last 24 hours and 30 days, and the latest start. */
  runs: { total: number; last24Hours: number; last30Days: number; lastStartedAt: Date | null };
  storage: { files: number; bytes: number };
  /**
   * The reporter versions that started runs in the last 90 days, the most recently heard first, 50 at most: only what
   * reads as a version, since a reporter names its own.
   */
  reporterVersions: { version: string; runs: number; lastRunAt: Date }[];
}

/** The usage figures, and what is in progress now from the counts this process keeps. */
export async function getOperatorUsage(
  db: DrizzleDB,
  processCounts: Omit<OperatorNow, 'runsInProgress' | 'lastRunActivityAt'>,
  now = new Date(),
): Promise<OperatorUsage> {
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
  // The windows read `start_time`, which an index serves.
  const [inProgress, projectCount, userCount, runCounts, last24, last30, fileCounts, versions] = await Promise.all([
    db
      .select({ count: count(), updated: max(testRuns.updatedAt), created: max(testRuns.createdAt) })
      .from(testRuns)
      .where(inArray(testRuns.status, [...UNFINISHED_RUN_STATUSES])),
    db.select({ count: count() }).from(projects),
    db.select({ count: count() }).from(users),
    db.select({ count: count(), last: max(testRuns.startTime) }).from(testRuns),
    db
      .select({ count: count() })
      .from(testRuns)
      .where(gte(testRuns.startTime, since(1))),
    db
      .select({ count: count() })
      .from(testRuns)
      .where(gte(testRuns.startTime, since(30))),
    db.select({ count: count(), bytes: sql<number>`coalesce(sum(${files.size}), 0)` }).from(files),
    db
      .select({ version: testRuns.reporterVersion, runs: count(), lastRunAt: max(testRuns.startTime) })
      .from(testRuns)
      .where(
        and(
          isNotNull(testRuns.reporterVersion),
          lte(sql`length(${testRuns.reporterVersion})`, REPORTER_VERSION_MAX_LENGTH),
          gte(testRuns.startTime, since(REPORTER_VERSIONS_DAYS)),
        ),
      )
      .groupBy(testRuns.reporterVersion)
      .orderBy(desc(max(testRuns.startTime)))
      .limit(REPORTER_VERSIONS_MAX * 4),
  ]);
  return {
    now: {
      runsInProgress: Number(inProgress[0]?.count ?? 0),
      lastRunActivityAt: latest(inProgress[0]?.updated, inProgress[0]?.created),
      ...processCounts,
    },
    projects: Number(projectCount[0]?.count ?? 0),
    users: Number(userCount[0]?.count ?? 0),
    runs: {
      total: Number(runCounts[0]?.count ?? 0),
      last24Hours: Number(last24[0]?.count ?? 0),
      last30Days: Number(last30[0]?.count ?? 0),
      lastStartedAt: runCounts[0]?.last ?? null,
    },
    storage: { files: Number(fileCounts[0]?.count ?? 0), bytes: Number(fileCounts[0]?.bytes ?? 0) },
    reporterVersions: versions
      .filter((row) => VERSION.test(row.version ?? ''))
      .slice(0, REPORTER_VERSIONS_MAX)
      .map((row) => ({ version: row.version!, runs: Number(row.runs), lastRunAt: row.lastRunAt! })),
  };
}

/** The later of two times, either missing: a run's last activity is its update, else its creation. */
function latest(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}
