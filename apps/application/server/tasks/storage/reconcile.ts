import { getDatabase } from '../../database';
import { reconcileStorageTotal, storageUsedBytes } from '../../utils/storage-quota';

export default defineTask({
  meta: {
    name: 'storage:reconcile',
    description:
      'Recount the stored bytes from the files, trace blobs and trace resources, putting right what the running total missed',
  },
  async run() {
    const db = await getDatabase();
    const before = await storageUsedBytes(db);
    const after = await reconcileStorageTotal(db);
    if (after !== before) console.info(`[storage:reconcile] the running total was ${before} bytes, recounted ${after}`);
    return { result: { before, after } };
  },
});
