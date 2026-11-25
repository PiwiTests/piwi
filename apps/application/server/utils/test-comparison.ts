/**
 * Compare with team instance, on the team instance: how a test that failed on someone's machine does in this
 * project's CI. A connected desktop app names the test by its identity, as ingestion matches a test (the external ID,
 * then the file, describe path and title of a test case holding no other ID), and the answer gives the test's latest
 * final attempts in the reference runs (`CI_RUN_ORIGINS`), every environment and branch, with the latest of each
 * environment the CI ran it in so a busy one never hides the others, and apart the teammates' shared runs
 * (`LOCAL_RUN_ORIGINS`); the cluster the same fingerprint leads to for that test, with what the CI saw of it; and the
 * snapshot of the closest CI pass. Every other origin (private, lab, investigation runs) is left out.
 */
import { and, count, countDistinct, desc, eq, isNull, max, min, sql, type SQL } from 'drizzle-orm';
import { normalizeExternalId } from '@piwitests/core/test-meta';
import {
  environments,
  failureClusterAliases,
  failureClusterTestRoutes,
  failureClusters,
  quarantinedTests,
  testCases,
  testRuns,
  testRunsCases,
} from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { findLabelEnvironment } from '#shared/handlers/environments';
import { FINGERPRINT_VERSION } from '#shared/error-fingerprint';
import {
  CI_RUN_ORIGINS,
  incidentRunSql,
  LOCAL_RUN_ORIGINS,
  runOriginIn,
  type RunOriginKind,
} from '#shared/run-eligibility';
import {
  TEST_COMPARISON_LIMITS,
  type TestComparison,
  type TestComparisonCluster,
  type TestComparisonQuery,
  type TestComparisonResult,
  type TestComparisonSource,
} from '#shared/test-comparison';
import { commitMatches, getClosestCiPass, runEnvironmentSql, type RunEnvironmentRef } from './environment-diff';
import { resolveRunBranch } from './run-branch';
import { projectDefaultBranch } from './scm/stored-default-branch';

const epoch = (value: Date | number | null | undefined): number | null =>
  value instanceof Date ? value.getTime() : (value ?? null);

/**
 * The project's test of that identity, as ingestion matches it: the test case holding its external ID, else the one of
 * its file, describe path and title that holds no other ID; among several, the one holding an ID, then the newest.
 */
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
      .orderBy(desc(testCases.id))
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
        externalId ? isNull(testCases.externalId) : undefined,
      ),
    )
    .orderBy(sql`CASE WHEN ${testCases.externalId} IS NULL THEN 1 ELSE 0 END`, desc(testCases.id))
    .limit(1);
  return byKey ?? null;
}

/** The test's latest final attempts in runs of `origins`, newest first, in `playwrightProject` when one is named. */
function finalAttempts(
  db: DrizzleDB,
  testCaseId: number,
  origins: readonly RunOriginKind[],
  opts: { playwrightProject: string | null; where?: SQL | null; limit: number },
) {
  const conds: SQL[] = [
    eq(testRunsCases.testCaseId, testCaseId),
    eq(testRunsCases.finalAttempt, true),
    runOriginIn(testRuns.origin, origins),
  ];
  if (opts.playwrightProject) conds.push(eq(testRunsCases.browserName, opts.playwrightProject));
  if (opts.where) conds.push(opts.where);
  return db
    .select({
      executionId: testRunsCases.id,
      runId: testRuns.id,
      status: testRunsCases.status,
      flaky: testRunsCases.passedAfterFailure,
      incident: sql<boolean>`${incidentRunSql(testRuns.metadata)}`.mapWith(Boolean),
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

/** How a run names its environment, as one key: its resolved environment, else its label, else none. */
function environmentKeyOf(environment: { id: number | null; label: string | null }): string {
  if (environment.id !== null) return `id:${environment.id}`;
  return environment.label ? `label:${environment.label.toLowerCase()}` : 'none';
}

/** The environments the CI ran the test in, the local run's first, at most `TEST_COMPARISON_LIMITS.environments`. */
async function ciEnvironmentsOf(
  db: DrizzleDB,
  testCaseId: number,
  playwrightProject: string | null,
  local: RunEnvironmentRef | null,
): Promise<RunEnvironmentRef[]> {
  const conds: SQL[] = [
    eq(testRunsCases.testCaseId, testCaseId),
    eq(testRunsCases.finalAttempt, true),
    runOriginIn(testRuns.origin, CI_RUN_ORIGINS),
  ];
  if (playwrightProject) conds.push(eq(testRunsCases.browserName, playwrightProject));
  const rows = await db
    .selectDistinct({ id: testRuns.environmentId, label: testRuns.environment })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(...conds))
    .limit(200);
  const byKey = new Map<string, RunEnvironmentRef>();
  for (const row of rows) {
    const key = environmentKeyOf({ id: row.id ?? null, label: row.label ?? null });
    if (!byKey.has(key)) byKey.set(key, { id: row.id ?? null, label: row.label ?? null });
  }
  const localKey = local ? environmentKeyOf(local) : null;
  return [...byKey.entries()]
    .sort(([a], [b]) => Number(b === localKey) - Number(a === localKey))
    .slice(0, TEST_COMPARISON_LIMITS.environments)
    .map(([, environment]) => environment);
}

/**
 * The reference and shared local results of the test, in `playwrightProject` when one is named: the latest CI
 * results, the latest of each CI environment, the CI results on the local commit, and the teammates' latest.
 */
async function historyOf(
  db: DrizzleDB,
  testCaseId: number,
  query: TestComparisonQuery,
  playwrightProject: string | null,
  local: RunEnvironmentRef | null,
): Promise<Array<AttemptRow & { source: TestComparisonSource }>> {
  const [ci, shared, onCommit, ciEnvironments] = await Promise.all([
    finalAttempts(db, testCaseId, CI_RUN_ORIGINS, { playwrightProject, limit: TEST_COMPARISON_LIMITS.ci }),
    finalAttempts(db, testCaseId, LOCAL_RUN_ORIGINS, { playwrightProject, limit: TEST_COMPARISON_LIMITS.local }),
    query.commit
      ? finalAttempts(db, testCaseId, CI_RUN_ORIGINS, {
          playwrightProject,
          where: commitMatches(query.commit),
          limit: TEST_COMPARISON_LIMITS.commit,
        })
      : Promise.resolve([]),
    ciEnvironmentsOf(db, testCaseId, playwrightProject, local),
  ]);
  const inLatest = new Map<string, number>();
  for (const row of ci) {
    const key = environmentKeyOf({ id: row.environmentId ?? null, label: row.environmentLabel ?? null });
    inLatest.set(key, (inLatest.get(key) ?? 0) + 1);
  }
  const perEnvironment = await Promise.all(
    ciEnvironments
      .filter(
        (environment) => (inLatest.get(environmentKeyOf(environment)) ?? 0) < TEST_COMPARISON_LIMITS.perEnvironment,
      )
      .map((environment) =>
        finalAttempts(db, testCaseId, CI_RUN_ORIGINS, {
          playwrightProject,
          where:
            environment.id === null && environment.label === null
              ? and(isNull(testRuns.environmentId), isNull(testRuns.environment))
              : runEnvironmentSql(environment),
          limit: TEST_COMPARISON_LIMITS.perEnvironment,
        }),
      ),
  );
  const seen = new Set<number>();
  const rows: Array<AttemptRow & { source: TestComparisonSource }> = [];
  const lists: Array<[TestComparisonSource, AttemptRow[]]> = [
    ['ci', ci],
    ['ci', onCommit],
    ...perEnvironment.map((list): [TestComparisonSource, AttemptRow[]] => ['ci', list]),
    ['local', shared],
  ];
  for (const [source, list] of lists) {
    for (const row of list) {
      if (seen.has(row.executionId)) continue;
      seen.add(row.executionId);
      rows.push({ ...row, source });
    }
  }
  return rows.sort((a, b) => (epoch(b.startTime) ?? 0) - (epoch(a.startTime) ?? 0) || b.executionId - a.executionId);
}

/**
 * The cluster `fingerprint` leads to for the test, as ingestion files a failure: the route a triager gave the test's
 * failures of that fingerprint, else the project's cluster of that fingerprint or an alias of it; with what the
 * reference runs saw of it, every failed attempt counted, retried ones included.
 */
async function clusterOf(
  db: DrizzleDB,
  projectId: number,
  fingerprint: string,
  testCaseId: number | null,
): Promise<TestComparisonCluster | null> {
  const [routed] =
    testCaseId !== null
      ? await db
          .select({ id: failureClusterTestRoutes.clusterId })
          .from(failureClusterTestRoutes)
          .where(
            and(
              eq(failureClusterTestRoutes.projectId, projectId),
              eq(failureClusterTestRoutes.fingerprint, fingerprint),
              eq(failureClusterTestRoutes.testCaseId, testCaseId),
            ),
          )
      : [];
  const [own] = routed
    ? [routed]
    : await db
        .select({ id: failureClusters.id })
        .from(failureClusters)
        .where(and(eq(failureClusters.projectId, projectId), eq(failureClusters.fingerprint, fingerprint)));
  const [found] = own
    ? [own]
    : await db
        .select({ id: failureClusterAliases.clusterId })
        .from(failureClusterAliases)
        .where(and(eq(failureClusterAliases.projectId, projectId), eq(failureClusterAliases.fingerprint, fingerprint)));
  if (!found) return null;
  const [cluster] = await db
    .select({
      id: failureClusters.id,
      title: failureClusters.title,
      signature: failureClusters.signature,
      status: failureClusters.status,
    })
    .from(failureClusters)
    .where(and(eq(failureClusters.id, found.id), eq(failureClusters.projectId, projectId)));
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
    .where(and(eq(testRunsCases.failureClusterId, cluster.id), runOriginIn(testRuns.origin, CI_RUN_ORIGINS)));
  return {
    id: cluster.id,
    title: cluster.title ?? cluster.signature ?? null,
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
 * The local run's environment label is resolved as a run's label is (its key or an alias), so the closest CI pass and
 * the history read the CI's runs of that environment whatever label they reported.
 */
export async function compareTestWithTeam(
  db: DrizzleDB,
  projectId: number,
  query: TestComparisonQuery,
): Promise<TestComparison> {
  const projectEnvironments = await db
    .select({ id: environments.id, key: environments.key })
    .from(environments)
    .where(eq(environments.projectId, projectId));
  const keyOf = new Map(projectEnvironments.map((environment) => [environment.id, environment.key]));
  const environmentOf = (id: number | null, label: string | null) => (id != null ? keyOf.get(id) : null) ?? label;
  const resolved = query.environment ? await findLabelEnvironment(db, projectId, query.environment) : null;
  const localEnvironment: RunEnvironmentRef | null = query.environment
    ? { id: resolved?.id ?? null, label: query.environment }
    : null;

  const fingerprintComparable = query.fingerprint === null || query.fingerprintVersion === FINGERPRINT_VERSION;
  const [testCase, defaultBranch] = await Promise.all([
    findTestCase(db, projectId, query),
    projectDefaultBranch(db, projectId).catch(() => null),
  ]);
  const cluster =
    query.fingerprint && fingerprintComparable
      ? await clusterOf(db, projectId, query.fingerprint, testCase?.id ?? null)
      : null;
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
  let rows = await historyOf(db, testCase.id, query, playwrightProject, localEnvironment);
  if (playwrightProject && !rows.some((row) => row.source === 'ci')) {
    playwrightProject = null;
    rows = await historyOf(db, testCase.id, query, null, localEnvironment);
  }
  answer.playwrightProjectMatched = playwrightProject !== null;
  answer.history = rows.map((row): TestComparisonResult => ({
    executionId: row.executionId,
    runId: row.runId,
    source: row.source,
    status: row.status,
    flaky: row.flaky === true,
    incident: row.incident === true,
    startTime: epoch(row.startTime),
    environment: environmentOf(row.environmentId ?? null, row.environmentLabel ?? null),
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
