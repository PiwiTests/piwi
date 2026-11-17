import { getDatabase } from '../../database';
import { getAdminStats } from '#shared/handlers/admin';
import { requireAuth } from '../../utils/auth';
import { getDataLocation } from '../../utils/data-location';

defineRouteMeta({
  openAPI: {
    tags: ['Admin'],
    summary: 'Get admin statistics',
    description:
      'Returns aggregate statistics about projects, test runs, test cases, files, and storage disk usage. Requires `storage:manage` (administrators only).',
    'x-required-permission': 'storage:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);

  const stats = await getAdminStats(await getDatabase());
  return { ...stats, ...(await getDataLocation()) };
});
