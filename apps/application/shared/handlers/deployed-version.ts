import { and, desc, eq, lte } from 'drizzle-orm';
import { environments, markers, testRuns } from '../../server/database/schema';
import { eligibleRunSql } from '../run-eligibility';
import { loadRunsSnapshots } from './environment-snapshots';
import {
  deployedEnvironmentIds,
  runsDeployedCommits,
  runsLatestDeploys,
  type DeployedCommitRun,
} from './deployed-commit';
import type { DrizzleDB } from './db';

/**
 * The version of the application a run of a deployed environment ran against, as pass reuse compares it: a key naming
 * its deployed commit (`runsDeployedCommits`), else the application versions its servers reported, server by server,
 * with the latest deploy marker before the run, so a deploy that names no commit still tells two versions apart. Two
 * runs ran the same application when their keys are equal. A run whose servers and deploy markers name neither has
 * none, and so has a run of an environment built from the checkout, whose application is the run's own commit.
 */
type DeployedVersion = string;

function commitKey(commit: string): DeployedVersion {
  return `commit ${commit}`;
}

/** The application versions a run's server snapshots reported, one `origin version` per server, sorted; null for none. */
function appVersionsKey(snapshots: ReadonlyArray<{ kind: string; origin?: string; appVersion?: string | null }>) {
  const versions = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshot.kind === 'server' && snapshot.appVersion)
      versions.add(`${snapshot.origin ?? ''} ${snapshot.appVersion}`);
  }
  return versions.size === 0 ? null : `versions ${[...versions].sort().join(' | ')}`;
}

/** The deployed version of each run, by run id (see {@link DeployedVersion}): null for a run that has none. */
export async function runsDeployedVersions(
  db: DrizzleDB,
  runs: readonly DeployedCommitRun[],
): Promise<Map<number, DeployedVersion | null>> {
  const out = new Map<number, DeployedVersion | null>(runs.map((run) => [run.id, null]));
  const commits = await runsDeployedCommits(db, runs);
  const left: DeployedCommitRun[] = [];
  for (const run of runs) {
    const deployed = commits.get(run.id);
    if (deployed) out.set(run.id, commitKey(deployed.commit));
    else if (run.environmentId !== null) left.push(run);
  }
  if (left.length === 0) return out;
  const deployedEnvironments = await deployedEnvironmentIds(
    db,
    left.map((run) => run.environmentId!),
  );
  const versioned = left.filter((run) => deployedEnvironments.has(run.environmentId!));
  if (versioned.length === 0) return out;
  const snapshots = await loadRunsSnapshots(
    db,
    versioned.map((run) => run.id),
    ['server'],
  );
  const deploys = await runsLatestDeploys(db, versioned);
  for (const run of versioned) {
    const versions = appVersionsKey(snapshots.get(run.id) ?? []);
    const deploy = deploys.get(run.id);
    out.set(run.id, versions && deploy ? `${versions} after deploy ${deploy.id}` : versions);
  }
  return out;
}

/**
 * The version of the application a deployed environment runs at `now`, by the latest evidence: a deploy marker recorded
 * after the environment's latest run a pass may come from names it by its commit (none, when it carries no commit),
 * else that run's deployed version. Null when nothing says, and for an environment built from the checkout.
 */
export async function environmentDeployedVersion(
  db: DrizzleDB,
  environmentId: number,
  now: Date,
): Promise<DeployedVersion | null> {
  const [environment] = await db
    .select({ projectId: environments.projectId, appFromCheckout: environments.appFromCheckout })
    .from(environments)
    .where(eq(environments.id, environmentId));
  if (!environment || environment.appFromCheckout) return null;
  const [latestRun] = await db
    .select({ id: testRuns.id, startTime: testRuns.startTime })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, environment.projectId),
        eq(testRuns.environmentId, environmentId),
        lte(testRuns.startTime, now),
        eligibleRunSql('pass-reuse'),
      ),
    )
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(1);
  const [latestDeploy] = await db
    .select({ commit: markers.commit, occurredAt: markers.occurredAt })
    .from(markers)
    .where(and(eq(markers.environmentId, environmentId), eq(markers.category, 'deploy'), lte(markers.occurredAt, now)))
    .orderBy(desc(markers.occurredAt), desc(markers.id))
    .limit(1);
  if (latestDeploy && (!latestRun || latestDeploy.occurredAt.getTime() > latestRun.startTime.getTime())) {
    return latestDeploy.commit ? commitKey(latestDeploy.commit) : null;
  }
  if (!latestRun) return null;
  return (
    (await runsDeployedVersions(db, [{ id: latestRun.id, environmentId, startTime: latestRun.startTime }])).get(
      latestRun.id,
    ) ?? null
  );
}
