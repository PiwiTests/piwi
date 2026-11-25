/**
 * Compare with team instance, on the team instance: how a test that failed on someone's machine does in this
 * project's CI. A connected desktop app names the test by its identity, as ingestion matches a test (the external ID,
 * then the file, describe path and title), and the answer gives the test's latest final attempts in the reference
 * runs (`CI_RUN_ORIGINS`) and, apart, in the teammates' shared runs (`LOCAL_RUN_ORIGINS`), every environment and
 * branch; the cluster of the project that holds the same fingerprint, with what the CI saw of it; and the snapshot of
 * the closest CI pass. Every other origin (private, lab, investigation runs) is left out.
 */
import { and, countDistinct, count, desc, eq, isNull, max, min, type SQL } from 'drizzle-orm';
import { normalizeExternalId } from '@piwitests/core/test-meta';
import {
  environments,
  failureClusterAliases,
  failureClusters,
  quarantinedTests,
  testCases,
  testRuns,
  testRunsCases,
} from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { FINGERPRINT_VERSION } from '#shared/error-fingerprint';
import { CI_RUN_ORIGINS, LOCAL_RUN_ORIGINS, runOriginIn } from '#shared/run-eligibility';
import {
  TEST_COMPARISON_LIMITS,
  type TestComparison,
  type TestComparisonCluster,
  type TestComparisonQuery,
  type TestComparisonResult,
  type TestComparisonSource,
} from '#shared/test-comparison';
import { commitMatches, getClosestCiPass } from './environment-diff';
import { resolveRunBranch } from './run-branch';
import { projectDefaultBranch } from './scm/stored-default-branch';

const epoch = (value: Date | number | null | undefined): number | null =>
  value instanceof Date ? value.getTime() : (value ?? null);

/** The project's test of that identity: by its external ID first, then by its file, describe path and title. */
async function findTestCase(db: DrizzleDB, projectId: number, query: TestComparisonQuery) {
  const columns = {
    id: testCases.id,
    title: testCases.title,
    displayTitle: testCases.displayTitle,
    filePath: testCases.filePath,
    suitePath: testCases.suitePath,
    flakyRootCause: testCases.flakyRootCause,
  };
  const externalId = normalizeExternalId(query.externalId);
  if (externalId) {
    const [byId] = await db
      .select(columns)
      .from(testCases)
      .where(and(eq(testCases.projectId, projectId), eq(testCases.externalId, externalId)))
      .orderBy(testCases.id)
      .limit(1);
    if (byId) return byId;
  }
  const [byKey] = await db
    .select(columns)
    .from(testCases)
    .where(
      and(
        eq(testCases.projectId, projectId),
        eq(testCases.filePath, query.filePath),
        eq(testCases.suitePath, query.suitePath),
        eq(testCases.title, query.title),
      ),
    )
    .orderBy(testCases.id)
    .limit(1);
  return byKey ?? null;
}

/** The test's latest final attempts in runs of `origins`, newest first, in `playwrightProject` when one is named. */
function finalAttempts(
  db: DrizzleDB,
  testCaseId: number,
  origins: readonly (typeof CI_RUN_ORIGINS)[number][] | readonly (typeof LOCAL_RUN_ORIGINS)[number][],
  opts: { playwrightProject: string | null; commit?: string; limit: number },
) {
  const conds: SQL[] = [
    eq(testRunsCases.testCaseId, testCaseId),
    eq(testRunsCases.finalAttempt, true),
    runOriginIn(testRuns.origin, origins),
  ];
  if (opts.playwrightProject) conds.push(eq(testRunsCases.browserName, opts.playwrightProject));
  if (opts.commit) conds.push(commitMatches(opts.commit));
  return db
    .select({
      executionId: testRunsCases.id,
      runId: testRuns.id,
      status: testRunsCases.status,
      flaky: testRunsCases.passedAfterFailure,
      startTime: testRuns.startTime,
      environmentId: testRuns.environmentId,
      environmentLabel: testRuns.environment,
      branch: testRuns.branch,
      metadata: testRuns.metadata,
      commit: testRuns.commit,
      playwrightProject: testRunsCases.browserName,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(...conds))
    .orderBy(desc(testRuns.startTime), desc(testRunsCases.id))
    .limit(opts.limit);
}

type AttemptRow = Awaited<ReturnType<typeof finalAttempts>>[number];

/** The reference and shared local results of the test, in `playwrightProject` when one is named. */
async function historyOf(
  db: DrizzleDB,
  testCaseId: number,
  query: TestComparisonQuery,
  playwrightProject: string | null,
): Promise<Array<AttemptRow & { source: TestComparisonSource }>> {
  const [ci, local, onCommit] = await Promise.all([
    finalAttempts(db, testCaseId, CI_RUN_ORIGINS, { playwrightProject, limit: TEST_COMPARISON_LIMITS.ci }),
    finalAttempts(db, testCaseId, LOCAL_RUN_ORIGINS, { playwrightProject, limit: TEST_COMPARISON_LIMITS.local }),
    query.commit
      ? finalAttempts(db, testCaseId, CI_RUN_ORIGINS, {
          playwrightProject,
          commit: query.commit,
          limit: TEST_COMPARISON_LIMITS.commit,
        })
      : Promise.resolve([]),
  ]);
  const seen = new Set<number>();
  const rows: Array<AttemptRow & { source: TestComparisonSource }> = [];
  for (const [source, list] of [
    ['ci', ci],
    ['ci', onCommit],
    ['local', local],
  ] as const) {
    for (const row of list) {
      if (seen.has(row.executionId)) continue;
      seen.add(row.executionId);
      rows.push({ ...row, source });
    }
  }
  return rows.sort((a, b) => (epoch(b.startTime) ?? 0) - (epoch(a.startTime) ?? 0) || b.executionId - a.executionId);
}

/** The project's cluster of `fingerprint` (its own, or one an alias leads to), with what the reference runs saw of it. */
async function clusterOf(db: DrizzleDB, projectId: number, fingerprint: string): Promise<TestComparisonCluster | null> {
  const [own] = await db
    .select({ id: failureClusters.id })
    .from(failureClusters)
    .where(and(eq(failureClusters.projectId, projectId), eq(failureClusters.fingerprint, fingerprint)));
  const [alias] = own
    ? [own]
    : await db
        .select({ id: failureClusterAliases.clusterId })
        .from(failureClusterAliases)
        .where(and(eq(failureClusterAliases.projectId, projectId), eq(failureClusterAliases.fingerprint, fingerprint)));
  if (!alias) return null;
  const [cluster] = await db
    .select({ id: failureClusters.id, title: failureClusters.title, status: failureClusters.status })
    .from(failureClusters)
    .where(eq(failureClusters.id, alias.id));
  if (!cluster) return null;
  const [seen] = await db
    .select({
      occurrences: count(),
      tests: countDistinct(testRunsCases.testCaseId),
      first: min(testRuns.startTime),
      last: max(testRuns.startTime),
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(
      and(
        eq(testRunsCases.failureClusterId, cluster.id),
        eq(testRunsCases.finalAttempt, true),
        runOriginIn(testRuns.origin, CI_RUN_ORIGINS),
      ),
    );
  return {
    id: cluster.id,
    title: cluster.title ?? null,
    status: cluster.status,
    ciOccurrences: Number(seen?.occurrences ?? 0),
    ciFirstSeen: epoch(seen?.first as Date | number | null | undefined),
    ciLastSeen: epoch(seen?.last as Date | number | null | undefined),
    ciTests: Number(seen?.tests ?? 0),
    path: `/failure-clusters/${cluster.id}`,
  };
}

/**
 * How the test `query` names does in project `projectId`'s CI, for a connected app whose owner may read the project.
 * The local run's environment label is read as the project's environment of that key when there is one, so it ranks
 * the closest CI pass as the CI's runs of that environment report it.
 */
export async function compareTestWithTeam(
  db: DrizzleDB,
  projectId: number,
  query: TestComparisonQuery,
): Promise<TestComparison> {
  const projectEnvironments = await db
    .select({ id: environments.id, key: environments.key, keyFold: environments.keyFold })
    .from(environments)
    .where(eq(environments.projectId, projectId));
  const keyOf = new Map(projectEnvironments.map((environment) => [environment.id, environment.key]));
  const environmentOf = (id: number | null, label: string | null) => (id != null ? keyOf.get(id) : null) ?? label;
  const localEnvironment = query.environment
    ? (projectEnvironments.find((environment) => environment.keyFold === query.environment!.toLowerCase())?.key ??
      query.environment)
    : null;

  const fingerprintComparable = query.fingerprintVersion == null || query.fingerprintVersion === FINGERPRINT_VERSION;
  const [testCase, defaultBranch, cluster] = await Promise.all([
    findTestCase(db, projectId, query),
    projectDefaultBranch(db, projectId).catch(() => null),
    query.fingerprint && fingerprintComparable ? clusterOf(db, projectId, query.fingerprint) : Promise.resolve(null),
  ]);
  const answer: TestComparison = {
    testCase: null,
    defaultBranch: defaultBranch || null,
    playwrightProjectMatched: false,
    history: [],
    fingerprintComparable,
    cluster,
    closestPass: null,
  };
  if (!testCase) return answer;

  const [quarantined] = await db
    .select({ id: quarantinedTests.id })
    .from(quarantinedTests)
    .where(and(eq(quarantinedTests.testCaseId, testCase.id), isNull(quarantinedTests.releasedAt)))
    .limit(1);
  answer.testCase = {
    id: testCase.id,
    title: testCase.displayTitle ?? testCase.title,
    filePath: testCase.filePath,
    suitePath: testCase.suitePath,
    quarantined: quarantined !== undefined,
    flakyRootCause: testCase.flakyRootCause ?? null,
    path: `/test-cases/${testCase.id}`,
  };

  // The local Playwright project narrows the results, unless the CI never ran the test in it.
  let playwrightProject = query.playwrightProject;
  let rows = await historyOf(db, testCase.id, query, playwrightProject);
  if (playwrightProject && !rows.some((row) => row.source === 'ci')) {
    playwrightProject = null;
    rows = await historyOf(db, testCase.id, query, null);
  }
  answer.playwrightProjectMatched = playwrightProject !== null;
  answer.history = rows.map((row): TestComparisonResult => ({
    executionId: row.executionId,
    runId: row.runId,
    source: row.source,
    status: row.status,
    flaky: row.flaky === true,
    startTime: epoch(row.startTime),
    environment: environmentOf(row.environmentId, row.environmentLabel),
    branch: row.branch ?? resolveRunBranch(row.metadata),
    commit: row.commit ?? null,
    playwrightProject: row.playwrightProject || null,
    path: `/test-run-cases/${row.executionId}`,
  }));

  const closest = await getClosestCiPass(db, {
    testCaseId: testCase.id,
    playwrightProject,
    environment: localEnvironment,
    branch: query.branch,
    commit: query.commit,
  });
  if (closest) {
    const { environmentId, environmentLabel, ...pass } = closest;
    answer.closestPass = {
      ...pass,
      environment: environmentOf(environmentId, environmentLabel),
      path: `/test-run-cases/${pass.executionId}`,
    };
  }
  return answer;
}
