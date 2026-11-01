import { requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { getDatabase } from '../../database';
import { listAcceptedUnwritten } from '#shared/handlers/scenario-gaps';

defineRouteMeta({
  openAPI: {
    tags: ['Scenario gaps'],
    summary: 'Accepted-but-unwritten scenario gaps across projects',
    description:
      'Gaps still accepted more than a week after their acceptance: the draft never became a test, or the test does not reach the gap yet. A gap closes once a recompute no longer finds it; findings never close themselves and are left out. Drives the Home "gaps" inbox queue.',
    parameters: [],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any);
  const projectIds = scope === 'all' ? 'all' : [...scope];
  return { items: await listAcceptedUnwritten(db, projectIds) };
});
