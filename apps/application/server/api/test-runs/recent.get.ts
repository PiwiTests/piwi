import { requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { getDatabase } from '../../database';
import { countRunsLast24h, getRecentTestRuns } from '#shared/handlers/test-runs';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Get recent test runs',
    description:
      'Returns the 30 most recent completed test runs across all projects plus any currently active runs, sorted by start time, and `runsLast24h`: every run started in the last 24 hours, lab runs left out, counted per environment and run kind (`isFullRun`). Used by the home page dashboard.',
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any);
  const [items, runsLast24h] = await Promise.all([getRecentTestRuns(db, scope), countRunsLast24h(db, scope)]);
  return { items, runsLast24h };
});
