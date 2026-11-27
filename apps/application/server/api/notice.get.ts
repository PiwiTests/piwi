import { invitationsShownTo } from '#shared/handlers/operator-invitations';
import { storageWarningLevel } from '#shared/storage-quota';
import { isAdministrator } from '#shared/permissions';
import { visibleNotice } from '#shared/operator-notice';
import { getDatabase } from '../database';
import { getRequestAccess, requireAuth } from '../utils/auth';
import { readOperatorNotice } from '../utils/operator-notice';
import { storageQuotaState } from '../utils/storage-quota';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Get the notices for the signed-in user',
    description:
      'What whoever runs the instance tells the caller. `notice`: the banner set with `PUT /api/operator/notice`, or `null` when none is set, when it has ended, or when it is for administrators and the caller is not one. `invitations`: for an administrator, the administrators the operator invited (`POST /api/operator/admin-invite`) whose invitation nobody took yet and has not ended, as `{ userId, email, expiresAt }`; empty for anyone else. `storage`: for an administrator, once the stored bytes reach 80% of `PIWI_STORAGE_QUOTA_BYTES`, `{ usedBytes, quotaBytes, level }` with `level` 80 or 95, 100 once the quota is reached and files are refused, or `ceiling` once new runs are refused too; else `null`.',
    'x-required-permission': 'signed-in',
  },
});

/** The stored bytes against the quota, once they reach 80% of it, and the level reached; null below, or without a quota. */
async function storageWarning(db: Awaited<ReturnType<typeof getDatabase>>) {
  const state = await storageQuotaState(db);
  if (!state) return null;
  const { usedBytes, quotaBytes } = state;
  const level = storageWarningLevel(usedBytes, quotaBytes, state.over?.ceilingBytes ?? null);
  return level ? { usedBytes, quotaBytes, level } : null;
}

export default eventHandler(async (event) => {
  await requireAuth(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  const db = await getDatabase();
  const now = new Date();
  const administrator = isAdministrator(await getRequestAccess(event));
  const notice = visibleNotice(await readOperatorNotice(db), { administrator, now });
  return {
    notice,
    invitations: await invitationsShownTo(db, { administrator, now }),
    storage: administrator ? await storageWarning(db) : null,
  };
});
