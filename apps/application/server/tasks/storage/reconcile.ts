import { getDatabase } from '../../database';
import { reconcileStorageTotal, storageUsedBytes } from '../../utils/storage-quota';
import { readOnlyNow } from '../../utils/operator-limits';

export default defineTask<unknown>({
  meta: {
    name: 'storage:reconcile',
    description:
      'Recount the stored bytes from the files, trace blobs, trace resources and the results of runs, putting right what the running total missed. Skipped while the instance is read-only',
  },
  async run() {
    const db = await getDatabase();
    if (await readOnlyNow(db)) return { result: { skipped: 'read-only' } };
    const before = await storageUsedBytes(db);
    const after = await reconcileStorageTotal(db);
    if (after !== before) console.info(`[storage:reconcile] the running total was ${before} bytes, recounted ${after}`);
    return { result: { before, after } };
  },
});
