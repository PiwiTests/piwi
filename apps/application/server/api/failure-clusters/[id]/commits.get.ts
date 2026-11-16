import { failureClusters, testRuns } from '../../../database/schema';
import { eq } from 'drizzle-orm';
import { optionalIntQuery } from '../../../utils/query-params';
import { normalizeGitUrl } from '../../../utils/scm/git-url';
import { createScmProvider } from '../../../utils/scm';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'List recent commits for a cluster',
    description:
      'Returns recent commits for the failure cluster repository. Supports optional baseline query parameter for aggregate diff stats.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'baseline',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Baseline commit SHA; when set, aggregate diff stats are computed against it.',
      },
      {
        name: 'branch',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Branch to list commits from.',
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 50, minimum: 1, maximum: 200 },
        description: 'Number of commits to return (default 50, max 200).',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db, user } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const [cluster] = await db.select().from(failureClusters).where(eq(failureClusters.id, id));
  if (!cluster) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });

  const [run] = await db
    .select({ metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.id, cluster.lastSeenRunId));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = run?.metadata as any;
  const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);

  if (!repositoryUrl) return { items: [], repositoryUrl: null, aggregate: null, error: null };

  const provider = await createScmProvider(repositoryUrl, db, cluster.projectId, {
    // The virtual administrator of an instance without sign-in is id 0, no user row.
    actor: { userId: user.id || null, apiKeyId: (event.context.apiKeyId as number | undefined) ?? null },
  });
  if (!provider) return { items: [], repositoryUrl, aggregate: null, error: null };

  const query = getQuery(event);
  const baselineSha = query.baseline as string | undefined;
  const branch = (query.branch as string | undefined) || undefined;
  const limit = optionalIntQuery(event, 'limit', { default: 50, min: 1, max: 200 });

  const commits = await provider.listCommits(limit, branch);

  let error: string | null = null;
  if (commits.length === 0) {
    error = await provider.probeError(branch);
  }

  let aggregate: { filesChanged: number; linesAdded: number; linesRemoved: number } | null = null;
  if (baselineSha && commits.length > 0) {
    const latestSha = commits[0]!.sha;
    try {
      const diff = await provider.fetchChanges(baselineSha, latestSha);
      if (diff) {
        aggregate = {
          filesChanged: diff.files.length,
          linesAdded: diff.files.reduce((s, f) => s + f.additions, 0),
          linesRemoved: diff.files.reduce((s, f) => s + f.deletions, 0),
        };
      }
    } catch {
      /* stats unavailable */
    }
  }

  return { items: commits, repositoryUrl, aggregate, error, hasMore: commits.length >= limit };
});
