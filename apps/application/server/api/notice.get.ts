import { isAdministrator } from '#shared/permissions';
import { visibleNotice } from '#shared/operator-notice';
import { getDatabase } from '../database';
import { getRequestAccess, requireAuth } from '../utils/auth';
import { readOperatorNotice } from '../utils/operator-notice';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Get the notice for the signed-in user',
    description:
      'The banner whoever runs the instance set with `PUT /api/operator/notice`, as the caller sees it: `notice: null` when none is set, when it has ended, or when it is for administrators and the caller is not one.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  const notice = await readOperatorNotice(await getDatabase());
  const administrator = isAdministrator(await getRequestAccess(event));
  return { notice: visibleNotice(notice, { administrator, now: new Date() }) };
});
