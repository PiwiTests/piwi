import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { listTrackerConnections } from '../../utils/integrations/connections';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Which trackers are connected',
    description:
      'Lists the connected trackers. Drives whether the create-issue entry points show; an issue is filed through the connection its project is bound to.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const db = await getDatabase();
  return { trackers: await listTrackerConnections(db) };
});
