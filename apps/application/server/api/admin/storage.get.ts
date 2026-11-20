import { getDatabase } from '../../database';
import { getStorageAnalysis } from '#shared/handlers/admin-storage';
import { requireAuth } from '../../utils/auth';
import { getDataLocation } from '../../utils/data-location';
import type { StorageAnalysis } from '../../../types/api';

defineRouteMeta({
  openAPI: {
    tags: ['Admin'],
    summary: 'Get storage analysis',
    description:
      'Returns a breakdown of stored evidence by project, by file kind and over time, plus the physical storage location and (for local storage) the measured on-disk size. Requires `storage:manage` (administrators only).',
    'x-required-permission': 'storage:manage',
  },
});

export default eventHandler(async (event): Promise<StorageAnalysis> => {
  await requireAuth(event);

  const analysis = await getStorageAnalysis(await getDatabase());
  return { ...analysis, ...(await getDataLocation()) };
});
