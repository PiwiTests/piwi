import { getDatabase } from '../../database';
import { sweepOutbox } from '../../utils/notifications/dispatch';
import { readOnlyNow } from '../../utils/operator-limits';

export default defineTask<unknown>({
  meta: {
    name: 'notifications:sweep',
    description:
      'Process pending notification deliveries (outbox sweeper with retry/backoff). Skipped while the instance is read-only',
  },
  async run() {
    const db = await getDatabase();
    if (await readOnlyNow(db)) return { result: { skipped: 'read-only' } };
    const { sent, failed } = await sweepOutbox(db);
    if (sent > 0 || failed > 0) {
      console.info(`[notifications:sweep] sent=${sent} failed=${failed}`);
    }
    return { result: { sent, failed } };
  },
});
