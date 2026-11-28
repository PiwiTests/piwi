import { storageWarningTitle } from '#shared/storage-quota';
import { getDatabase } from '../../database';
import { isEmailConfigured, renderStorageWarningEmail, sendEmail } from '../../utils/email';
import { watchStorageQuota } from '../../utils/storage-quota';

export default defineTask({
  meta: {
    name: 'storage:watch',
    description:
      'Compare the stored bytes with PIWI_STORAGE_QUOTA_BYTES, keep when the instance went over it, and email the administrators once each time the usage crosses 80% or 95% of it, the quota (files are refused) or its ceiling (new runs are refused), again on the next minutes until one message went out',
  },
  async run() {
    const db = await getDatabase();
    const watched = await watchStorageQuota(db, async (to, state, level) => {
      if (!isEmailConfigured()) return false;
      const { html, text } = renderStorageWarningEmail(state, level);
      await sendEmail({ to, subject: `Piwi: ${storageWarningTitle(level)}`, html, text });
      return true;
    });
    if (watched?.announced && watched.told !== 0)
      console.info(`[storage:watch] ${storageWarningTitle(watched.told)}: administrators told`);
    return { result: watched };
  },
});
