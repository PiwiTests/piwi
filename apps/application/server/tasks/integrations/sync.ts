import { getDatabase } from '../../database';
import { syncTrackerLinks } from '../../utils/integrations/sync';
import { isSyncTickDue, resolveSyncMinutes } from '#shared/integrations/sync-config';
import { readOnlyNow } from '../../utils/operator-limits';

export default defineTask<unknown>({
  meta: {
    name: 'integrations:sync',
    description:
      'Refresh tracker link statuses and apply the resolve/reopen policies. Skipped while the instance is read-only',
  },
  async run() {
    const minutes = resolveSyncMinutes(process.env.PIWI_INTEGRATIONS_SYNC_MINUTES);
    if (!isSyncTickDue(minutes, new Date())) return { result: { due: false, refreshed: 0, failed: 0, skipped: 0 } };
    const db = await getDatabase();
    if (await readOnlyNow(db)) return { result: { skipped: 'read-only' } };
    const { refreshed, failed, skipped } = await syncTrackerLinks(db);
    if (refreshed > 0 || failed > 0) {
      console.info(`[integrations:sync] refreshed=${refreshed} failed=${failed} skipped=${skipped}`);
    }
    return { result: { due: true, refreshed, failed, skipped } };
  },
});
