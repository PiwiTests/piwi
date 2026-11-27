import { pendingOperatorInvitations } from '#shared/handlers/operator-invitations';
import { isAdministrator } from '#shared/permissions';
import { visibleNotice } from '#shared/operator-notice';
import { getDatabase } from '../database';
import { getRequestAccess, requireAuth } from '../utils/auth';
import { readOperatorNotice } from '../utils/operator-notice';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Get the notices for the signed-in user',
    description:
      'What whoever runs the instance tells the caller. `notice`: the banner set with `PUT /api/operator/notice`, or `null` when none is set, when it has ended, or when it is for administrators and the caller is not one. `invitations`: for an administrator, the administrators the operator invited (`POST /api/operator/admin-invite`) whose invitation nobody took yet and has not ended, as `{ email, expiresAt }`; empty for anyone else.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  const db = await getDatabase();
  const now = new Date();
  const administrator = isAdministrator(await getRequestAccess(event));
  const notice = visibleNotice(await readOperatorNotice(db), { administrator, now });
  const invitations = administrator
    ? (await pendingOperatorInvitations(db))
        .filter((invitation) => invitation.expiresAt > now)
        .map(({ email, expiresAt }) => ({ email, expiresAt: expiresAt.toISOString() }))
    : [];
  return { notice, invitations };
});
