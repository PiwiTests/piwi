import { requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { getDatabase } from '../../database';
import { getProjectsOverview } from '#shared/handlers/projects';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Per-project overview with trend data',
    description:
      'Returns a compact overview per project: last 20 full runs (for trend bars), the latest of them that ran to its end (passed, failed or timed out) and the tendency badge, read from those runs only, so a run in progress, interrupted or cancelled shows in the bars alone. Used by the home page dashboard.',
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any);
  return { items: await getProjectsOverview(db, scope) };
});
