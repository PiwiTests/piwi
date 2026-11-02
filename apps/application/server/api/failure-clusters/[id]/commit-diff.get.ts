import { failureClusters, testRuns } from '../../../database/schema';
import { eq } from 'drizzle-orm';
import { normalizeGitUrl } from '../../../utils/scm/git-url';
import { isValidGitRef } from '../../../utils/scm/refs';
import { createScmProvider } from '../../../utils/scm';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Get commit diff for a cluster',
    description:
      'Returns the file changes and patches for a specific commit SHA in the cluster repository: at most 300 files (`filesTruncated` when the commit has more) and the commit itself in `commits` when the host gives its message. Null when the host cannot diff the commit; 502 with the host’s message when the host answers with an error.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'sha',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Commit SHA to diff.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const sha = getQuery(event).sha as string | undefined;
  if (!sha) throw apiError({ statusCode: 400, message: 'Missing sha query parameter' });
  // The sha goes into an SCM API URL with the project's token; reject a ref that
  // could traverse out of the repository path.
  if (!isValidGitRef(sha)) throw apiError({ statusCode: 400, message: 'Invalid sha' });

  const [cluster] = await db
    .select({
      id: failureClusters.id,
      projectId: failureClusters.projectId,
      lastSeenRunId: failureClusters.lastSeenRunId,
    })
    .from(failureClusters)
    .where(eq(failureClusters.id, id));
  if (!cluster) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });

  const [run] = await db
    .select({ metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.id, cluster.lastSeenRunId));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = run?.metadata as any;
  const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
  if (!repositoryUrl) return null;

  const provider = await createScmProvider(repositoryUrl, db, cluster.projectId);
  if (!provider) return null;

  try {
    return await provider.fetchCommitDiff(sha);
  } catch (err) {
    // The host refused or could not answer: say what it said.
    const detail = err instanceof Error ? err.message : String(err);
    throw apiError({ statusCode: 502, message: `The Git host could not diff this commit: ${detail}`.slice(0, 400) });
  }
});
