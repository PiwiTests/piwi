import { inArray } from 'drizzle-orm';
import { testRuns } from '../../server/database/schema';
import { UNFINISHED_RUN_STATUSES } from '../run-eligibility';

import type { DrizzleDB } from './db';

/** A run of any project that has not ended, and when it last reported anything. */
interface RunInProgress {
  status: (typeof UNFINISHED_RUN_STATUSES)[number];
  lastActivityAt: Date;
}

/** What the instance is doing now that a restart would cut or end. */
export interface InstanceActivity {
  /** Runs initializing, running or finalizing, most recently active first. */
  runsInProgress: RunInProgress[];
  /** Requests receiving a run's results or files. */
  uploadsInProgress: number;
  /** Event streams held open: pages, live views and connected apps, which reconnect on their own. */
  openEventStreams: number;
}

/**
 * The runs of every project that have not ended, with the time of their last activity: `updated_at`, else
 * `created_at`, the times the stale-run sweep reads.
 */
export async function getRunsInProgress(db: DrizzleDB): Promise<RunInProgress[]> {
  const rows = await db
    .select({ status: testRuns.status, createdAt: testRuns.createdAt, updatedAt: testRuns.updatedAt })
    .from(testRuns)
    .where(inArray(testRuns.status, [...UNFINISHED_RUN_STATUSES]));
  return rows
    .map((row) => ({
      status: row.status as RunInProgress['status'],
      lastActivityAt: row.updatedAt ?? row.createdAt,
    }))
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}
