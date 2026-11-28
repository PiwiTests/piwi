import { getDatabase } from '../../database';
import { getStorageAnalysis } from '#shared/handlers/admin-storage';
import { requireAuth } from '../../utils/auth';
import { getDataLocation } from '../../utils/data-location';
import { instanceLimits } from '../../utils/operator-limits';
import { storageQuotaState } from '../../utils/storage-quota';
import type { StorageAnalysis } from '../../../types/api';

defineRouteMeta({
  openAPI: {
    tags: ['Admin'],
    summary: 'Get storage analysis',
    description:
      'Returns a breakdown of stored evidence by project, by file kind and over time, plus the physical storage location, (for local storage) the measured on-disk size, and `quota` (null without a quota): `{ quotaBytes, usedBytes, over, filesRefused, runsRefused }`, the bytes the quota counts (the stored files and traces, and the results of runs), since when the instance is over its quota with the ceiling past which it refuses new runs (`over`, null below it), and whether it refuses files and new runs now, and `limits`: the storage quota, the largest upload and results document, the days of runs kept and read-only mode as they apply now, each `{ value, source }` as `GET /api/operator/limits` answers them. Requires `storage:manage` (administrators only).',
    'x-required-permission': 'storage:manage',
  },
});

export default eventHandler(async (event): Promise<StorageAnalysis> => {
  await requireAuth(event);

  const db = await getDatabase();
  const analysis = await getStorageAnalysis(db);
  return { ...analysis, ...(await getDataLocation()), quota: await storageQuotaState(db), limits: instanceLimits() };
});
