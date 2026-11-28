import { getDatabase } from '../../database';
import { sweepIntegrationActions } from '../../utils/integrations/actions';
import { readOnlyNow } from '../../utils/operator-limits';

export default defineTask<unknown>({
  meta: {
    name: 'integrations:sweep',
    description:
      'Perform queued integration actions (durable outbox with retry/backoff). Skipped while the instance is read-only',
  },
  async run() {
    const db = await getDatabase();
    if (await readOnlyNow(db)) return { result: { skipped: 'read-only' } };
    const { done, failed, skipped } = await sweepIntegrationActions(db);
    if (done > 0 || failed > 0 || skipped > 0) {
      console.info(`[integrations:sweep] done=${done} failed=${failed} skipped=${skipped}`);
    }
    return { result: { done, failed, skipped } };
  },
});
