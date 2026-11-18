/**
 * What changed in a deployed environment between two of its runs: the deployed commit of each
 * (`runsDeployedCommits`), the application's commits between them, and the environment's deploy markers in between.
 * The application is read in the project's repository, as in a monorepo: the range is built there, from the
 * project's pinned repository, else the run's remote.
 *
 * The run page, the Changes tab, suspect lines, the AI diagnosis, a cluster's first failing deploy and the bisect
 * read it, on the server and in the demo.
 */
import { and, desc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import { environments, markers, projects, testRuns, testRunsCases } from '../../server/database/schema';
import { normalizeGitUrl, repositoryUrlFromRemote } from '../../server/utils/scm/git-url';
import { eligibleRunSql } from '../run-eligibility';
import { buildCommitRange, type CommitRange } from '../utils/run-metadata';
import { changeCoverageDeployedNote, sameDeployedCommit } from '../deployed-words';
import { runsDeployedCommits, type DeployedCommit, type DeployedCommitRun } from './deployed-commit';
import type { VerdictDeploy } from '../failure-verdict';
import type { DrizzleDB } from './db';

/** Deploy markers listed between two runs, at most. */
export const DEPLOYS_LISTED = 10;

/** The environment's runs before a cluster's first failure searched for its last pass, at most. */
const LAST_PASS_WINDOW = 200;

/** A deployed environment, as the analysis names it. */
export interface DeployedEnvironment {
  id: number;
  key: string;
  name: string;
  description: string | null;
}

/** One deploy marker of an environment. */
export interface DeployRef {
  markerId: number;
  label: string;
  /** The commit it deployed, when the pipeline posted one. */
  commit: string | null;
  deployedAt: Date;
}

/** The deploy markers of an environment in a window, oldest first. */
export interface DeploysInWindow {
  deploys: DeployRef[];
  /** More deploys happened in the window than are listed: the listed ones are the latest. */
  more: boolean;
}

/** What a run of a deployed environment ran against, beside an earlier run of it. */
export interface DeployedChanges extends DeploysInWindow {
  environment: DeployedEnvironment;
  /** The run's deployed commit; null when its servers and deploy markers named none. */
  current: DeployedCommit | null;
  /** The earlier run's; null without one, or when it is unknown. */
  baseline: DeployedCommit | null;
  /**
   * The application's commits from the earlier run's deployed commit to the run's, in the project's repository; null
   * when either is unknown or both name the same commit.
   */
  range: CommitRange | null;
}

/** The deployed environments among `environmentIds`, by id: one not built from the checkout, archived ones included. */
export async function deployedEnvironments(
  db: DrizzleDB,
  environmentIds: readonly (number | null | undefined)[],
): Promise<Map<number, DeployedEnvironment>> {
  const ids = [...new Set(environmentIds.filter((id): id is number => id != null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: environments.id,
      key: environments.key,
      name: environments.name,
      description: environments.description,
    })
    .from(environments)
    .where(and(inArray(environments.id, ids), eq(environments.appFromCheckout, false)));
  return new Map(rows.map((row) => [row.id, { ...row, description: row.description ?? null }]));
}

/** The deployed environment a run tested; null for none, or one built from the checkout. */
export async function deployedEnvironmentOf(
  db: DrizzleDB,
  environmentId: number | null | undefined,
): Promise<DeployedEnvironment | null> {
  return (await deployedEnvironments(db, [environmentId])).get(environmentId ?? -1) ?? null;
}

/**
 * The environment's deploy markers after `after` (exclusive; from the first when null) up to `upTo` (inclusive),
 * oldest first: the latest {@link DEPLOYS_LISTED} when there are more.
 */
export async function deploysBetween(
  db: DrizzleDB,
  environmentId: number,
  after: Date | null,
  upTo: Date,
  limit = DEPLOYS_LISTED,
): Promise<DeploysInWindow> {
  const rows = await db
    .select({ markerId: markers.id, label: markers.label, commit: markers.commit, deployedAt: markers.occurredAt })
    .from(markers)
    .where(
      and(
        eq(markers.environmentId, environmentId),
        eq(markers.category, 'deploy'),
        lte(markers.occurredAt, upTo),
        after ? gt(markers.occurredAt, after) : undefined,
      ),
    )
    .orderBy(desc(markers.occurredAt), desc(markers.id))
    .limit(limit + 1);
  return {
    deploys: rows
      .slice(0, limit)
      .map((row) => ({ ...row, commit: row.commit ?? null }))
      .reverse(),
    more: rows.length > limit,
  };
}

/** The repository the application of a project is read in: the project's pinned one, else the run's remote. */
async function applicationRepositoryUrl(db: DrizzleDB, projectId: number, metadata: unknown[]): Promise<string | null> {
  const [project] = await db
    .select({ repositoryUrl: projects.repositoryUrl })
    .from(projects)
    .where(eq(projects.id, projectId));
  const pinned = repositoryUrlFromRemote(project?.repositoryUrl);
  if (pinned) return pinned;
  for (const meta of metadata) {
    const remote = (meta as { scm?: { remoteUrl?: string | null } } | null)?.scm?.remoteUrl;
    const url = normalizeGitUrl(remote ?? null);
    if (url) return url;
  }
  return null;
}

/** The application's commit range between two deployed commits; null when either is unknown or they are the same. */
function deployedRange(
  repositoryUrl: string | null,
  from: DeployedCommit | null,
  to: DeployedCommit | null,
): CommitRange | null {
  if (!from || !to || sameDeployedCommit(from.commit, to.commit)) return null;
  return buildCommitRange(repositoryUrl, from.commit, to.commit);
}

/** A run as `deployedChanges` reads it. */
export interface DeployedChangesRun extends DeployedCommitRun {
  projectId: number;
  metadata: unknown;
}

/**
 * What changed in the deployed environment `run` tested since `baseline` (an earlier run, of any environment; only one
 * of the same environment gives a deployed commit to start a range from): the
 * deployed commit of each, the application's range between them, and the environment's deploy markers after the
 * baseline started, up to the run's start. Null when the run's environment is built from the checkout, or it has
 * none. Without a baseline, the deploys are the latest before the run.
 */
export async function deployedChanges(
  db: DrizzleDB,
  run: DeployedChangesRun,
  baseline: (DeployedCommitRun & { metadata?: unknown }) | null,
  /** The run's environment, when the caller already read it. */
  known?: DeployedEnvironment,
): Promise<DeployedChanges | null> {
  const environment = known ?? (await deployedEnvironmentOf(db, run.environmentId));
  if (!environment) return null;
  // A baseline of another environment ran another deployment: no range runs from its commit to the run's.
  const sameEnvironment = baseline !== null && baseline.environmentId === run.environmentId;
  const commits = await runsDeployedCommits(db, sameEnvironment ? [run, baseline] : [run]);
  const current = commits.get(run.id) ?? null;
  const before = sameEnvironment ? (commits.get(baseline.id) ?? null) : null;
  const repositoryUrl =
    current && before ? await applicationRepositoryUrl(db, run.projectId, [run.metadata, baseline?.metadata]) : null;
  const window = await deploysBetween(db, environment.id, baseline?.startTime ?? null, run.startTime);
  return { environment, current, baseline: before, range: deployedRange(repositoryUrl, before, current), ...window };
}

/** A cluster's first failing deploy, as the cluster page, the execution page, the AI diagnosis and MCP name it. */
export interface FirstFailingDeploy extends DeployedChanges {
  /** The run the cluster first failed in. */
  firstFailingRunId: number;
  /**
   * The latest run of the same environment before it in which one of the cluster's tests passed, among its last
   * {@link LAST_PASS_WINDOW}; null when there is none, and the deploys are then the latest before the first failing run.
   */
  lastPassingRunId: number | null;
}

/** What `clusterFirstFailingDeploy` reads of a cluster. */
export interface FirstFailingDeployCluster {
  id: number;
  projectId: number;
  firstSeenRunId: number;
}

/**
 * The deploy a cluster of a deployed environment was first seen on: the environment's deploy markers between the last
 * run of it where one of the cluster's tests passed and the run the cluster first failed in. The last listed deploy is
 * the one that run tested; none listed says the environment's markers name no deploy in between. Null when the first
 * failing run's environment is built from the checkout, or it has none.
 */
export async function clusterFirstFailingDeploy(
  db: DrizzleDB,
  cluster: FirstFailingDeployCluster,
): Promise<FirstFailingDeploy | null> {
  const [firstFailing] = await db
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      environmentId: testRuns.environmentId,
      startTime: testRuns.startTime,
      metadata: testRuns.metadata,
    })
    .from(testRuns)
    .where(eq(testRuns.id, cluster.firstSeenRunId));
  if (!firstFailing || firstFailing.environmentId == null) return null;
  const environment = await deployedEnvironmentOf(db, firstFailing.environmentId);
  if (!environment) return null;
  // The environment's runs before the first failure, newest first, then the newest of them where a test of the
  // cluster passed: a bounded window, read through the executions' run index.
  const earlier = await db
    .select({
      id: testRuns.id,
      environmentId: testRuns.environmentId,
      startTime: testRuns.startTime,
      metadata: testRuns.metadata,
    })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, cluster.projectId),
        eq(testRuns.environmentId, firstFailing.environmentId),
        lt(testRuns.startTime, firstFailing.startTime),
        eligibleRunSql('baseline'),
      ),
    )
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(LAST_PASS_WINDOW);
  const passed =
    earlier.length === 0
      ? new Set<number>()
      : new Set(
          (
            await db
              .selectDistinct({ runId: testRunsCases.testRunId })
              .from(testRunsCases)
              .where(
                and(
                  inArray(
                    testRunsCases.testRunId,
                    earlier.map((run) => run.id),
                  ),
                  sql`${testRunsCases.status} = 'passed'`,
                  inArray(
                    testRunsCases.testCaseId,
                    db
                      .selectDistinct({ id: testRunsCases.testCaseId })
                      .from(testRunsCases)
                      .where(eq(testRunsCases.failureClusterId, cluster.id)),
                  ),
                ),
              )
          ).map((row) => row.runId),
        );
  const lastPassing = earlier.find((run) => passed.has(run.id));
  const changes = await deployedChanges(db, firstFailing, lastPassing ?? null, environment);
  if (!changes) return null;
  return { ...changes, firstFailingRunId: firstFailing.id, lastPassingRunId: lastPassing?.id ?? null };
}

/**
 * The deploy a failing execution's verdict names (`VerdictDeploy`): its cluster's first failing deploy when the
 * cluster first failed in a deployed environment, else its own run's deployed commit. Null when the run's environment
 * is built from the checkout, or it has none.
 */
export async function verdictDeployOf(
  db: DrizzleDB,
  run: DeployedCommitRun,
  cluster: FirstFailingDeployCluster | null,
): Promise<VerdictDeploy | null> {
  const first = cluster ? await clusterFirstFailingDeploy(db, cluster) : null;
  if (first) {
    const counted = first.lastPassingRunId != null;
    const deploy = counted ? (first.deploys.at(-1) ?? null) : null;
    return {
      environment: first.environment.name,
      commit: first.current?.commit ?? deploy?.commit ?? null,
      label: deploy?.label ?? null,
      noDeploySinceLastPass: counted && first.deploys.length === 0,
    };
  }
  const environment = await deployedEnvironmentOf(db, run.environmentId);
  if (!environment) return null;
  const commit = (await runsDeployedCommits(db, [run])).get(run.id) ?? null;
  return { environment: environment.name, commit: commit?.commit ?? null, label: null, noDeploySinceLastPass: false };
}

/**
 * The note change coverage carries for a run of a deployed environment (`changeCoverageDeployedNote`); null for one
 * built from the checkout, none, or one deployed at the change's head.
 */
export async function runChangeCoverageNote(
  db: DrizzleDB,
  run: DeployedCommitRun,
  headSha: string | null,
): Promise<string | null> {
  const environment = await deployedEnvironmentOf(db, run.environmentId);
  if (!environment) return null;
  const deployed = (await runsDeployedCommits(db, [run])).get(run.id) ?? null;
  return changeCoverageDeployedNote({ environment: environment.name, commit: deployed?.commit ?? null, headSha });
}
