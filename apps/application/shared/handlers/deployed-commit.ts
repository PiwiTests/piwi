import { and, desc, eq, gt, inArray, lte } from 'drizzle-orm';
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
  /** The deploy marker's label. */
  markerLabel?: string;
  /** When the deploy marker says it was deployed. */
  deployedAt?: Date;
}

/** What the resolution reads of a run. */
export interface DeployedCommitRun {
  id: number;
  environmentId: number | null;
  startTime: Date;
}

/** An environment's deploy marker: one with a commit names what was deployed, one without says only that it changed. */
export interface DeployMarker {
  id: number;
  label: string;
  commit: string | null;
  occurredAt: Date;
}

/** The ids of `environmentIds` whose application is deployed, not built from the run's checkout. */
export async function deployedEnvironmentIds(db: DrizzleDB, environmentIds: readonly number[]): Promise<Set<number>> {
  const ids = [...new Set(environmentIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(inArray(environments.id, ids), eq(environments.appFromCheckout, false)));
  return new Set(rows.map((row) => row.id));
}

/**
 * The latest deploy marker of each run's environment at or before it started, with a commit or not, by run id; null
 * for a run with no environment or none before it. A marker that names no environment says nothing about which one
 * was deployed, so it never counts. Two reads per environment: its deploy markers between the runs' starts, then the
 * last one before the earliest.
 */
export async function runsLatestDeploys(
  db: DrizzleDB,
  runs: readonly DeployedCommitRun[],
): Promise<Map<number, DeployMarker | null>> {
  const out = new Map<number, DeployMarker | null>(runs.map((run) => [run.id, null]));
  const byEnvironment = new Map<number, DeployedCommitRun[]>();
  for (const run of runs) {
    if (run.environmentId !== null)
      byEnvironment.set(run.environmentId, [...(byEnvironment.get(run.environmentId) ?? []), run]);
  }
  for (const [environmentId, envRuns] of byEnvironment) {
    const starts = envRuns.map((run) => run.startTime.getTime());
    const earliest = new Date(Math.min(...starts));
    const latest = new Date(Math.max(...starts));
    const deploy = and(eq(markers.environmentId, environmentId), eq(markers.category, 'deploy'));
    const fields = { id: markers.id, label: markers.label, commit: markers.commit, occurredAt: markers.occurredAt };
    const newest = [desc(markers.occurredAt), desc(markers.id)] as const;
    const within = await db
      .select(fields)
      .from(markers)
      .where(and(deploy, gt(markers.occurredAt, earliest), lte(markers.occurredAt, latest)))
      .orderBy(...newest);
    const before = await db
      .select(fields)
      .from(markers)
      .where(and(deploy, lte(markers.occurredAt, earliest)))
      .orderBy(...newest)
      .limit(1);
    const deploys = [...within, ...before];
    for (const run of envRuns) {
      out.set(run.id, deploys.find((marker) => marker.occurredAt.getTime() <= run.startTime.getTime()) ?? null);
    }
  }
  return out;
}

/**
 * The deployed commit of each run, by run id: the commit its servers reported, when they all report the same one;
 * else the commit of its environment's latest deploy marker before it started. Null for a run with no environment or
 * one built from the checkout, for servers that report different commits, and when that latest deploy marker carries
 * no commit or there is none: an older marker's commit would name an application that was since replaced.
 */
export async function runsDeployedCommits(
  db: DrizzleDB,
  runs: readonly DeployedCommitRun[],
): Promise<Map<number, DeployedCommit | null>> {
  const out = new Map<number, DeployedCommit | null>(runs.map((run) => [run.id, null]));
  const deployed = await deployedEnvironmentIds(
    db,
    runs.map((run) => run.environmentId).filter((id): id is number => id !== null),
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
    const reported = (snapshots.get(run.id) ?? []).flatMap((snapshot) =>
      snapshot.kind === 'server' && snapshot.appCommit ? [{ commit: snapshot.appCommit, origin: snapshot.origin }] : [],
    );
    const commits = new Set(reported.map((entry) => entry.commit));
    if (commits.size === 1)
      out.set(run.id, { commit: reported[0]!.commit, source: 'server', origin: reported[0]!.origin });
    else if (commits.size === 0) pending.push(run);
  }
  if (pending.length === 0) return out;

  const deploys = await runsLatestDeploys(db, pending);
  for (const run of pending) {
    const marker = deploys.get(run.id);
    if (!marker?.commit) continue;
    out.set(run.id, {
      commit: marker.commit,
      source: 'marker',
      markerId: marker.id,
      markerLabel: marker.label,
      deployedAt: marker.occurredAt,
    });
  }
  return out;
}

/** The deployed commit of one run (`runsDeployedCommits`). */
export async function runDeployedCommit(db: DrizzleDB, run: DeployedCommitRun): Promise<DeployedCommit | null> {
  return (await runsDeployedCommits(db, [run])).get(run.id) ?? null;
}
