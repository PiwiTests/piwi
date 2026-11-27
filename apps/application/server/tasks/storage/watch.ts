import { getDatabase } from '../../database';
import { isEmailConfigured, renderStorageWarningEmail, sendEmail } from '../../utils/email';
import { watchStorageQuota } from '../../utils/storage-quota';

export default defineTask({
  meta: {
    name: 'storage:watch',
    description:
      'Compare the stored bytes with PIWI_STORAGE_QUOTA_BYTES, and email the administrators once each time the usage crosses 80% or 95% of it (again on the next minutes until one message went out)',
  },
  async run() {
    const db = await getDatabase();
    const watched = await watchStorageQuota(db, async (to, usedBytes, quotaBytes, level) => {
      if (!isEmailConfigured()) return false;
      const { html, text } = renderStorageWarningEmail(usedBytes, quotaBytes, level);
      await sendEmail({ to, subject: `Piwi's storage is at ${level}% of its quota`, html, text });
      return true;
    });
    if (watched?.announced)
      console.info(`[storage:watch] storage at ${watched.told}% of the quota: administrators told`);
    return { result: watched };
  },
});
