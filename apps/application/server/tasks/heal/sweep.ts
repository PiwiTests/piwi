import { getDatabase } from '../../database';
import { sweepHealActions } from '../../utils/heal/dispatch';
import { refreshOpenHealActions } from '../../utils/heal/pr-state';
import { readOnlyNow } from '../../utils/operator-limits';

/** The task ticks every minute; PR states are asked of the SCM this often. */
const PR_STATE_REFRESH_MS = 10 * 60_000;
let lastPrStateRefresh = 0;

export default defineTask<unknown>({
  meta: {
    name: 'heal:sweep',
    description:
      'Open queued auto-heal pull requests (durable outbox with retry/backoff) and record the ones merged or closed. Skipped while the instance is read-only',
  },
  async run() {
    const db = await getDatabase();
    if (await readOnlyNow(db)) return { result: { skipped: 'read-only' } };
    const { opened, failed, skipped } = await sweepHealActions(db);
    let merged = 0;
    let closed = 0;
    if (Date.now() - lastPrStateRefresh >= PR_STATE_REFRESH_MS) {
      lastPrStateRefresh = Date.now();
      ({ merged, closed } = await refreshOpenHealActions(db));
    }
    if (opened > 0 || failed > 0 || skipped > 0 || merged > 0 || closed > 0) {
      console.info(
        `[heal:sweep] opened=${opened} failed=${failed} skipped=${skipped} merged=${merged} closed=${closed}`,
      );
    }
    return { result: { opened, failed, skipped, merged, closed } };
  },
});
