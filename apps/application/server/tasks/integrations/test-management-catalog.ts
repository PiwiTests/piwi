import { getDatabase } from '../../database';
import { refreshDueCatalogs } from '../../utils/integrations/test-management/catalog-refresh';
import { readOnlyNow } from '../../utils/operator-limits';

let running = false;

export default defineTask<unknown>({
  meta: {
    name: 'integrations:test-management-catalog',
    description:
      'Read the test case catalog of each bound test management project that was not read in a day. Skipped while the instance is read-only',
  },
  async run() {
    // A read of a large project can outlast an hour at the default request rate: never start a second one beside it.
    if (running) return { result: { running: true, refreshed: 0, failed: 0, skipped: 0 } };
    running = true;
    try {
      const db = await getDatabase();
      if (await readOnlyNow(db)) return { result: { skipped: 'read-only' } };
      const { refreshed, failed, skipped } = await refreshDueCatalogs(db);
      if (refreshed > 0 || failed > 0) {
        console.info(
          `[integrations:test-management-catalog] refreshed=${refreshed} failed=${failed} skipped=${skipped}`,
        );
      }
      return { result: { running: false, refreshed, failed, skipped } };
    } finally {
      running = false;
    }
  },
});
