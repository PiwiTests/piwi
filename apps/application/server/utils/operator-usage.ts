import { count, desc, gte, inArray, isNotNull, max, sql } from 'drizzle-orm';
import type { DrizzleDB } from '#shared/handlers/db';
import { UNFINISHED_RUN_STATUSES } from '#shared/run-eligibility';
import { files, projects, testRuns, users } from '../database/schema';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the reporter versions are counted. */
export const REPORTER_VERSIONS_DAYS = 90;

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
  runs: { total: number; last24Hours: number; last30Days: number; lastCreatedAt: Date | null };
  storage: { files: number; bytes: number };
  /** The reporter versions that sent runs in the last 90 days, the most recently heard first. */
  reporterVersions: { version: string; runs: number; lastRunAt: Date }[];
}

/** The usage figures, and what is in progress now from the counts this process keeps. */
export async function getOperatorUsage(
  db: DrizzleDB,
  processCounts: Omit<OperatorNow, 'runsInProgress' | 'lastRunActivityAt'>,
  now = new Date(),
): Promise<OperatorUsage> {
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const [inProgress, projectCount, userCount, runCounts, last24, last30, fileCounts, versions] = await Promise.all([
    db
      .select({ count: count(), updated: max(testRuns.updatedAt), created: max(testRuns.createdAt) })
      .from(testRuns)
      .where(inArray(testRuns.status, [...UNFINISHED_RUN_STATUSES])),
    db.select({ count: count() }).from(projects),
    db.select({ count: count() }).from(users),
    db.select({ count: count(), last: max(testRuns.createdAt) }).from(testRuns),
    db
      .select({ count: count() })
      .from(testRuns)
      .where(gte(testRuns.createdAt, since(1))),
    db
      .select({ count: count() })
      .from(testRuns)
      .where(gte(testRuns.createdAt, since(30))),
    db.select({ count: count(), bytes: sql<number>`coalesce(sum(${files.size}), 0)` }).from(files),
    db
      .select({ version: testRuns.reporterVersion, runs: count(), lastRunAt: max(testRuns.createdAt) })
      .from(testRuns)
      .where(sql`${isNotNull(testRuns.reporterVersion)} AND ${gte(testRuns.createdAt, since(REPORTER_VERSIONS_DAYS))}`)
      .groupBy(testRuns.reporterVersion)
      .orderBy(desc(max(testRuns.createdAt))),
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
      lastCreatedAt: runCounts[0]?.last ?? null,
    },
    storage: { files: Number(fileCounts[0]?.count ?? 0), bytes: Number(fileCounts[0]?.bytes ?? 0) },
    reporterVersions: versions.map((row) => ({
      version: row.version!,
      runs: Number(row.runs),
      lastRunAt: row.lastRunAt!,
    })),
  };
}

/** The later of two times, either missing: a run's last activity is its update, else its creation. */
function latest(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}
