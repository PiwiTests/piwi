import { requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { getDatabase } from '../../database';
import { countLocalOnlyClusters, getOpenFailureClusters } from '#shared/handlers/failure-clusters';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'List open failure clusters across projects',
    description:
      'Open failure clusters across every project the caller can see, newest first by last seen. Drives the Home "Open failures" card. A cluster seen only in developers\' own runs (their machine, the desktop app, an editor), in a project that also has other runs, is left out unless `local=include`; `localOnlyHidden` counts those left out.',
    parameters: [
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['open'], default: 'open' },
        description: 'Only open clusters are listed; the parameter documents that.',
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 50, maximum: 200 },
        description: 'Maximum clusters to return',
      },
      {
        name: 'local',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['include', 'exclude'], default: 'exclude' },
        description: "`include` lists the clusters seen only in developers' own runs too",
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any);
  const query = getQuery(event);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const local = query.local === 'include' ? 'include' : 'exclude';
  const now = new Date();
  const [items, localOnlyHidden] = await Promise.all([
    getOpenFailureClusters(db, scope, limit, now, { localOnly: local }),
    local === 'exclude' ? countLocalOnlyClusters(db, scope, now) : 0,
  ]);
  return { items, localOnlyHidden };
});
