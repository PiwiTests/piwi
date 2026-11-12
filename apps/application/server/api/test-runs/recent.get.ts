import { requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { getDatabase } from '../../database';
import { runViewerOf } from '../../utils/run-viewer';
import { countRunsLast24h, getRecentTestRuns } from '#shared/handlers/test-runs';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Get recent test runs',
    description:
      'Returns the 30 most recent completed test runs across all projects plus any currently active runs, sorted by start time, and `runsLast24h`: every run started in the last 24 hours, lab runs left out, counted per environment and run kind (`isFullRun`). Each run names what launched it (`origin`, such as `ci`, `ci-rerun` or `local`), known once the run has begun: an initializing run names `local`. A run that is the caller’s own says `mine: true` (any other says nothing): a run outside CI they reported, or, with sign-in off, any such run; lab runs and imports are nobody’s. Used by the home page dashboard and by Piwi Picker’s CI runs.',
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any);
  const [items, runsLast24h] = await Promise.all([
    getRecentTestRuns(db, scope, runViewerOf(event, user)),
    countRunsLast24h(db, scope),
  ]);
  return { items, runsLast24h };
});
