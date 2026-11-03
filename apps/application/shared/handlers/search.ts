import { and, or, eq, desc, inArray, type SQLWrapper } from 'drizzle-orm';
import { testRuns, testCases, projects, failureClusters, entityLinks } from '../../server/database/schema';
import { foldedContains, foldedEquals } from '../utils/fold-text-sql';
import { describeCluster } from '../describe-cluster';
import { MAX_SERIAL_ID } from '../route-id';
import type { DrizzleDB } from './db';

type ProjectScope = 'all' | Set<number>;

export async function searchProjectsTestRunsCases(db: DrizzleDB, q: string, scope: ProjectScope = 'all') {
  if (!q || q.trim().length < 2 || (scope !== 'all' && scope.size === 0)) {
    return { projects: [], runs: [], cases: [], clusters: [] };
  }

  const term = q.trim();
  // A substring match that ignores case and accents, with every character of the term taken literally.
  const matches = (column: SQLWrapper) => foldedContains(column, term);
  const runId = /^\d+$/.test(term) ? Number(term) : NaN;
  const isRunId = Number.isSafeInteger(runId) && runId <= MAX_SERIAL_ID;
  // A cluster is found by its number too, written `#12` or `12`.
  const clusterId = /^#?\d+$/.test(term) ? Number(term.replace('#', '')) : NaN;
  const isClusterId = Number.isSafeInteger(clusterId) && clusterId <= MAX_SERIAL_ID;
  // The scope filters each query before its limit, so a caller's matches are never crowded out by other projects'.
  const inScope = (projectId: SQLWrapper) => (scope === 'all' ? undefined : inArray(projectId, [...scope]));

  const [projectResults, runResults, caseResults, clusterRows] = await Promise.all([
    db
      .select({ id: projects.id, name: projects.name, label: projects.label })
      .from(projects)
      .where(and(or(matches(projects.name), matches(projects.label)), inScope(projects.id)))
      .limit(5),

    db
      .select({
        id: testRuns.id,
        label: testRuns.label,
        status: testRuns.status,
        projectId: testRuns.projectId,
        projectName: projects.name,
        projectLabel: projects.label,
        startTime: testRuns.startTime,
      })
      .from(testRuns)
      .innerJoin(projects, eq(testRuns.projectId, projects.id))
      .where(and(isRunId ? eq(testRuns.id, runId) : matches(testRuns.label), inScope(testRuns.projectId)))
      .orderBy(desc(testRuns.startTime))
      .limit(5),

    db
      .select({
        id: testCases.id,
        title: testCases.title,
        filePath: testCases.filePath,
        projectId: testCases.projectId,
        projectName: projects.name,
        projectLabel: projects.label,
      })
      .from(testCases)
      .innerJoin(projects, eq(testCases.projectId, projects.id))
      .where(and(matches(testCases.title), inScope(testCases.projectId)))
      .limit(5),

    // Failure clusters by title, signature, number, or the key of an issue
    // linked to them, so a ticket key leads back to its failure.
    db
      .select({
        id: failureClusters.id,
        title: failureClusters.title,
        signature: failureClusters.signature,
        errorType: failureClusters.errorType,
        selector: failureClusters.selector,
        sampleError: failureClusters.sampleError,
        status: failureClusters.status,
        projectId: failureClusters.projectId,
        projectName: projects.name,
        projectLabel: projects.label,
        issueKey: entityLinks.key,
      })
      .from(failureClusters)
      .innerJoin(projects, eq(failureClusters.projectId, projects.id))
      .leftJoin(entityLinks, eq(entityLinks.failureClusterId, failureClusters.id))
      .where(
        and(
          or(
            isClusterId ? eq(failureClusters.id, clusterId) : undefined,
            matches(failureClusters.title),
            matches(failureClusters.signature),
            foldedEquals(entityLinks.key, term),
          ),
          inScope(failureClusters.projectId),
        ),
      )
      .orderBy(desc(failureClusters.lastSeenRunId))
      .limit(20),
  ]);

  // One row per cluster under the name the pages give it, naming the issue key
  // only when the key is what matched.
  const clusters: Array<{
    id: number;
    name: string;
    status: string | null;
    projectId: number;
    projectName: string;
    projectLabel: string | null;
    issueKey: string | null;
  }> = [];
  const folded = term.toLowerCase();
  for (const row of clusterRows) {
    const keyMatched = row.issueKey != null && row.issueKey.toLowerCase() === folded;
    const seen = clusters.find((c) => c.id === row.id);
    if (seen) {
      if (keyMatched) seen.issueKey = row.issueKey;
      continue;
    }
    if (clusters.length < 5) {
      clusters.push({
        id: row.id,
        name: describeCluster(row),
        status: row.status,
        projectId: row.projectId,
        projectName: row.projectName,
        projectLabel: row.projectLabel,
        issueKey: keyMatched ? row.issueKey : null,
      });
    }
  }

  return { projects: projectResults, runs: runResults, cases: caseResults, clusters };
}
