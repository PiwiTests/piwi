/**
 * What an environment's details view shows (Project → Settings → Environments): its last run, its last environment
 * incident, its recent deploy markers, and for a deployed one the application's commits and versions its recent runs
 * ran against. Read by `GET /api/projects/:id/environments/:environmentId/activity` and its demo mirror.
 */
import { and, desc, eq } from 'drizzle-orm';
import { environments, markers, testRuns } from '../../server/database/schema';
import { incidentRunSql } from '../run-eligibility';
import { readRunIncident } from '../run-incident';
import { deploysBetween, type DeployRef } from './deployed-changes';
import { runsDeployedCommits } from './deployed-commit';
import { loadRunsSnapshots } from './environment-snapshots';
import { notLabRun } from './probes';
import type { DrizzleDB } from './db';

/** Recent runs whose deployed commits and versions are read. */
const VERSION_RUNS = 20;

/** Deploy markers listed, newest first. */
const DEPLOYS_SHOWN = 10;

/** One application version the environment's runs ran against, as long as consecutive runs saw it. */
export interface EnvironmentVersion {
  /** The deployed commit; null when the runs named none. */
  commit: string | null;
  /** Where the commit comes from: the server under test, or a deploy marker. */
  source: 'server' | 'marker' | null;
  /** The deploy marker's label, for a commit it carried. */
  markerLabel: string | null;
  /** The application versions the servers under test reported. */
  appVersions: string[];
  /** The newest run that saw it. */
  lastRunId: number;
  lastSeenAt: Date;
  /** How many consecutive runs saw it. */
  runs: number;
}

export interface EnvironmentActivity {
  environmentId: number;
  appFromCheckout: boolean;
  /** The environment's latest run; null before its first. */
  lastRun: {
    id: number;
    status: string;
    startTime: Date;
    branch: string | null;
    label: string | null;
  } | null;
  /** The environment's last incident: a run flagged as one, or an incident marker; null for none. */
  lastIncident: {
    at: Date;
    /** Why, in one sentence: the run's incident reason, or the marker's label. */
    reason: string;
    runId: number | null;
    markerId: number | null;
  } | null;
  /** The environment's deploy markers, newest first. */
  deploys: DeployRef[];
  /** More deploy markers exist than are listed. */
  moreDeploys: boolean;
  /** For a deployed environment: the versions its recent runs ran against, newest first; empty for one built from the checkout. */
  versions: EnvironmentVersion[];
}

/** An environment's activity, or null when the project has no such environment. */
export async function getEnvironmentActivity(
  db: DrizzleDB,
  projectId: number,
  environmentId: number,
  now = new Date(),
): Promise<EnvironmentActivity | null> {
  const [environment] = await db
    .select({ id: environments.id, appFromCheckout: environments.appFromCheckout })
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)));
  if (!environment) return null;

  const ofEnvironment = and(
    eq(testRuns.projectId, projectId),
    eq(testRuns.environmentId, environmentId),
    notLabRun(testRuns.origin),
  );
  const [recentRuns, [incidentRun], [incidentMarker], window] = await Promise.all([
    db
      .select({
        id: testRuns.id,
        status: testRuns.status,
        startTime: testRuns.startTime,
        branch: testRuns.branch,
        label: testRuns.label,
        environmentId: testRuns.environmentId,
      })
      .from(testRuns)
      .where(ofEnvironment)
      .orderBy(desc(testRuns.startTime), desc(testRuns.id))
      .limit(environment.appFromCheckout ? 1 : VERSION_RUNS),
    db
      .select({ id: testRuns.id, startTime: testRuns.startTime, metadata: testRuns.metadata })
      .from(testRuns)
      .where(and(ofEnvironment, incidentRunSql(testRuns.metadata)))
      .orderBy(desc(testRuns.startTime), desc(testRuns.id))
      .limit(1),
    db
      .select({ id: markers.id, label: markers.label, occurredAt: markers.occurredAt, runId: markers.runId })
      .from(markers)
      .where(and(eq(markers.environmentId, environmentId), eq(markers.category, 'incident')))
      .orderBy(desc(markers.occurredAt), desc(markers.id))
      .limit(1),
    deploysBetween(db, environmentId, null, now, DEPLOYS_SHOWN),
  ]);

  const fromRun = incidentRun
    ? {
        at: incidentRun.startTime,
        reason: readRunIncident(incidentRun.metadata)?.reason ?? 'Flagged as an environment incident',
        runId: incidentRun.id,
        markerId: null,
      }
    : null;
  const fromMarker = incidentMarker
    ? {
        at: incidentMarker.occurredAt,
        reason: incidentMarker.label,
        runId: incidentMarker.runId,
        markerId: incidentMarker.id,
      }
    : null;
  const lastIncident =
    fromRun && fromMarker ? (fromMarker.at > fromRun.at ? fromMarker : fromRun) : (fromRun ?? fromMarker);

  const lastRun = recentRuns[0] ?? null;
  return {
    environmentId,
    appFromCheckout: environment.appFromCheckout,
    lastRun: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          startTime: lastRun.startTime,
          branch: lastRun.branch ?? null,
          label: lastRun.label ?? null,
        }
      : null,
    lastIncident,
    deploys: [...window.deploys].reverse(),
    moreDeploys: window.more,
    versions: environment.appFromCheckout ? [] : await recentVersions(db, recentRuns),
  };
}

/** The versions the runs ran against, newest first, one entry per stretch of consecutive runs that saw the same. */
async function recentVersions(
  db: DrizzleDB,
  runs: Array<{ id: number; startTime: Date; environmentId: number | null }>,
): Promise<EnvironmentVersion[]> {
  if (runs.length === 0) return [];
  const [commits, snapshots] = await Promise.all([
    runsDeployedCommits(db, runs),
    loadRunsSnapshots(
      db,
      runs.map((run) => run.id),
      ['server'],
    ),
  ]);
  const versions: EnvironmentVersion[] = [];
  for (const run of runs) {
    const commit = commits.get(run.id) ?? null;
    const appVersions = [
      ...new Set(
        (snapshots.get(run.id) ?? []).flatMap((snapshot) =>
          snapshot.kind === 'server' && snapshot.appVersion ? [snapshot.appVersion] : [],
        ),
      ),
    ].sort();
    if (!commit && appVersions.length === 0) continue;
    const previous = versions.at(-1);
    if (
      previous &&
      previous.commit === (commit?.commit ?? null) &&
      previous.appVersions.join('\n') === appVersions.join('\n')
    ) {
      previous.runs++;
      continue;
    }
    versions.push({
      commit: commit?.commit ?? null,
      source: commit?.source ?? null,
      markerLabel: commit?.markerLabel ?? null,
      appVersions,
      lastRunId: run.id,
      lastSeenAt: run.startTime,
      runs: 1,
    });
  }
  return versions;
}
