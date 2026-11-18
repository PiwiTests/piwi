/**
 * The AI diagnosis's "Environment Under Test" section: the environment a failing run tested, its description, and
 * whether its application is built from the run's checkout. For a deployed one, the application's commit the run ran
 * against and, for a cluster, its first failing deploy (`clusterFirstFailingDeploy`): the last passing and first
 * failing runs' deployed commits, the application's range between them and the deploy markers in between. Shared by
 * the server's context and the demo's.
 */
import { eq } from 'drizzle-orm';
import { environments, testRuns } from '../../server/database/schema';
import { deployedCommitSource, deployText } from '../deployed-words';
import {
  clusterFirstFailingDeploy,
  deployedChanges,
  type DeployedChanges,
  type FirstFailingDeployCluster,
} from './deployed-changes';
import type { DrizzleDB } from './db';

/** What the context carried of the environment, for the coverage the context preview shows. */
export interface EnvironmentContextCoverage {
  name: string;
  appFromCheckout: boolean;
  /** The run's deployed commit; null when the environment is built from the checkout or it is unknown. */
  deployedCommit: string | null;
  /** The deploy markers the section listed. */
  deploys: number;
}

export interface EnvironmentContextSection {
  markdown: string;
  coverage: EnvironmentContextCoverage;
}

const iso = (date: Date) => (date instanceof Date ? date.toISOString() : String(date));

/** The lines of a deployed environment's changes between an earlier run and the failing one. */
function deployedLines(changes: DeployedChanges, earlier: { label: string; runId: number | null }): string[] {
  const name = changes.environment.name;
  const lines: string[] = [];
  if (earlier.runId != null) {
    const commit = changes.baseline
      ? `deployed commit ${changes.baseline.commit.slice(0, 7)} (${deployedCommitSource(changes.baseline)})`
      : 'deployed commit unknown';
    lines.push(`- ${earlier.label}: run #${earlier.runId}, ${commit}`);
  }
  if (changes.range) {
    lines.push(
      `- Application commits between them: ${changes.range.fromShort}..${changes.range.toShort} (\`${changes.range.gitCommand}\`)`,
    );
  } else if (changes.current && changes.baseline && earlier.runId != null) {
    lines.push('- Both runs tested the same deployed commit: the application did not change between them.');
  }
  const window = earlier.runId != null ? 'between them' : 'before this run';
  if (changes.deploys.length === 0) {
    lines.push(`- Deploy markers of ${name} ${window}: none`);
  } else {
    lines.push(`- Deploy markers of ${name} ${window}, oldest first${changes.more ? ' (the latest only)' : ''}:`);
    for (const deploy of changes.deploys) lines.push(`  - ${iso(deploy.deployedAt)} ${deployText(deploy)}`);
  }
  return lines;
}

/**
 * The section for the run `runId` tested, with the first failing deploy of `cluster` when one is given; null for a
 * run with no environment.
 */
export async function environmentContextSection(
  db: DrizzleDB,
  input: { runId: number; cluster: FirstFailingDeployCluster | null },
): Promise<EnvironmentContextSection | null> {
  const [row] = await db
    .select({
      run: {
        id: testRuns.id,
        projectId: testRuns.projectId,
        environmentId: testRuns.environmentId,
        startTime: testRuns.startTime,
        metadata: testRuns.metadata,
      },
      environment: {
        key: environments.key,
        name: environments.name,
        description: environments.description,
        appFromCheckout: environments.appFromCheckout,
      },
    })
    .from(testRuns)
    .innerJoin(environments, eq(environments.id, testRuns.environmentId))
    .where(eq(testRuns.id, input.runId));
  if (!row) return null;
  const { run, environment } = row;
  const lines = ['## Environment Under Test', `- Environment: ${environment.name} (key \`${environment.key}\`)`];
  if (environment.description) lines.push(`- Description: ${environment.description}`);
  if (environment.appFromCheckout) {
    lines.push("- Built from the checkout: the application under test is the run's own commit.");
    return {
      markdown: lines.join('\n'),
      coverage: { name: environment.name, appFromCheckout: true, deployedCommit: null, deploys: 0 },
    };
  }
  lines.push(
    "- Deployed: the application's version is independent of the run's commit, which says what the tests were, not what the application ran.",
  );
  const firstFailing = input.cluster ? await clusterFirstFailingDeploy(db, input.cluster) : null;
  const ownRun = !firstFailing || firstFailing.firstFailingRunId === run.id;
  const own = ownRun ? firstFailing : await deployedChanges(db, run, null);
  const current = own?.current ?? null;
  lines.push(
    current
      ? `- Deployed commit of run #${run.id}: ${current.commit.slice(0, 7)} (${deployedCommitSource(current)})`
      : `- Deployed commit of run #${run.id}: unknown; the deployed version may differ from the run's commit.`,
  );
  let deploys = 0;
  if (firstFailing) {
    lines.push(`- The cluster first failed in run #${firstFailing.firstFailingRunId}.`);
    if (!ownRun) {
      lines.push(
        firstFailing.current
          ? `- Deployed commit of run #${firstFailing.firstFailingRunId}: ${firstFailing.current.commit.slice(0, 7)} (${deployedCommitSource(firstFailing.current)})`
          : `- Deployed commit of run #${firstFailing.firstFailingRunId}: unknown`,
      );
    }
    lines.push(
      ...deployedLines(firstFailing, {
        label: `Last run of ${environment.name} where one of the cluster's tests passed`,
        runId: firstFailing.lastPassingRunId,
      }),
    );
    const first = firstFailing.lastPassingRunId != null ? firstFailing.deploys.at(-1) : undefined;
    if (first) lines.push(`- First failing deploy: ${deployText(first)}, the deploy the first failing run tested.`);
    deploys = firstFailing.deploys.length;
  } else if (own) {
    lines.push(...deployedLines(own, { label: 'Earlier run', runId: null }));
    deploys = own.deploys.length;
  }
  return {
    markdown: lines.join('\n'),
    coverage: { name: environment.name, appFromCheckout: false, deployedCommit: current?.commit ?? null, deploys },
  };
}
