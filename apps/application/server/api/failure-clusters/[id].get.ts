import { eq } from 'drizzle-orm';
import {
  holdsProjectPermission,
  requireResolvedProjectAccess,
  requireRouteId,
  resolveClusterProjectId,
} from '../../utils/project-access';
import { getFailureCluster } from '#shared/handlers/failure-clusters';
import { failureClusters } from '../../database/schema';
import { resolveOwners } from '../../utils/scm/ownership';
import { resolveAiConfig } from '../../utils/ai-provider';
import { ciRerunAvailability, flakeLabCiAvailability } from '../../utils/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Get failure cluster detail',
    description:
      "Returns detailed information about a failure cluster including affected tests, last seen run status, project info, and diagnosis. `latestHeadline` is the one-line headline of the cluster's latest occurrence (`source: 'latest'`), or of its stored sample error (`source: 'first'`) when that execution has no error, with the run it comes from.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  // The next-step policy needs to know whether AI diagnosis and a CI re-run are
  // configured — signals only the server can resolve. A CI run is offered only to
  // a viewer who may start one.
  const mayDispatch = await holdsProjectPermission(event, projectId, ['run:control']);
  const [clusterRow] = await db
    .select({ lastSeenRunId: failureClusters.lastSeenRunId })
    .from(failureClusters)
    .where(eq(failureClusters.id, id));
  const [aiConfig, ciRerun] = await Promise.all([
    resolveAiConfig(db).catch(() => null),
    clusterRow && mayDispatch
      ? ciRerunAvailability(db, projectId, clusterRow.lastSeenRunId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const result = (await getFailureCluster(db, id, {
    aiConfigured: aiConfig != null,
    ciRerunAvailable: ciRerun?.available ?? false,
    flakeLabCiAvailable: mayDispatch
      ? async (testCaseId) => (await flakeLabCiAvailability(db, projectId, testCaseId)).available
      : undefined,
  })) as Awaited<ReturnType<typeof getFailureCluster>> & {
    owner: { name: string; source: 'annotation' | 'codeowners' } | null;
  };
  if (!result) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });

  // No `piwi:owner` annotation on the tests? The repository's CODEOWNERS still
  // names one for the representative spec file.
  const repFilePath = result.affectedTestCases[0]?.filePath;
  if (!result.owner && repFilePath) {
    const test = { filePath: repFilePath, owner: null };
    const resolved = await resolveOwners(db, projectId, [test]).catch(() => new Map());
    const owner = resolved.get(test)?.owner;
    if (owner) result.owner = { name: owner, source: 'codeowners' };
  }

  return result;
});
