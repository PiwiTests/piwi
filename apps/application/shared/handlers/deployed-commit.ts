import { and, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { environments, markers } from '../../server/database/schema';
import { loadRunsSnapshots } from './environment-snapshots';
import type { DrizzleDB } from './db';

/**
 * The commit of the application a run of a deployed environment ran against: the commit an instrumented server
 * reported (`appCommit` of its server snapshot), else the commit of the environment's latest deploy marker before the
 * run started. An environment built from the checkout has none: its application is the run's own commit.
 */
export interface DeployedCommit {
  commit: string;
  source: 'server' | 'marker';
  /** The server's origin, for a commit it reported. */
  origin?: string;
  /** The deploy marker, for a commit it carried. */
  markerId?: number;
  /** When the deploy marker says it was deployed. */
  deployedAt?: Date;
}

/** What the resolution reads of a run. */
export interface DeployedCommitRun {
  id: number;
  environmentId: number | null;
  startTime: Date;
}

/**
 * The deployed commit of each run, by run id: null for a run with no environment, one built from the checkout, or a
 * deployed one whose servers and deploy markers named no commit. One read of the runs' server snapshots, then one
 * read per run left of its environment's latest deploy marker before it started.
 */
export async function runsDeployedCommits(
  db: DrizzleDB,
  runs: readonly DeployedCommitRun[],
): Promise<Map<number, DeployedCommit | null>> {
  const out = new Map<number, DeployedCommit | null>(runs.map((run) => [run.id, null]));
  const environmentIds = [...new Set(runs.map((run) => run.environmentId).filter((id): id is number => id !== null))];
  if (environmentIds.length === 0) return out;
  const deployed = new Set(
    (
      await db
        .select({ id: environments.id })
        .from(environments)
        .where(and(inArray(environments.id, environmentIds), eq(environments.appFromCheckout, false)))
    ).map((row) => row.id),
  );
  const candidates = runs.filter((run) => run.environmentId !== null && deployed.has(run.environmentId));
  if (candidates.length === 0) return out;

  const snapshots = await loadRunsSnapshots(
    db,
    candidates.map((run) => run.id),
    ['server'],
  );
  const pending: DeployedCommitRun[] = [];
  for (const run of candidates) {
    const reported = (snapshots.get(run.id) ?? []).find((snapshot) => snapshot.kind === 'server' && snapshot.appCommit);
    if (reported?.kind === 'server' && reported.appCommit) {
      out.set(run.id, { commit: reported.appCommit, source: 'server', origin: reported.origin });
    } else {
      pending.push(run);
    }
  }
  if (pending.length === 0) return out;

  for (const run of pending) {
    const [marker] = await db
      .select({ id: markers.id, commit: markers.commit, occurredAt: markers.occurredAt })
      .from(markers)
      .where(
        and(
          eq(markers.environmentId, run.environmentId!),
          eq(markers.category, 'deploy'),
          isNotNull(markers.commit),
          lte(markers.occurredAt, run.startTime),
        ),
      )
      .orderBy(desc(markers.occurredAt), desc(markers.id))
      .limit(1);
    if (marker?.commit) {
      out.set(run.id, { commit: marker.commit, source: 'marker', markerId: marker.id, deployedAt: marker.occurredAt });
    }
  }
  return out;
}

/** The deployed commit of one run (`runsDeployedCommits`). */
export async function runDeployedCommit(db: DrizzleDB, run: DeployedCommitRun): Promise<DeployedCommit | null> {
  return (await runsDeployedCommits(db, [run])).get(run.id) ?? null;
}
