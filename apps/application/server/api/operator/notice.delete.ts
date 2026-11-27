import { getDatabase } from '../../database';
import { requireOperator } from '../../utils/operator';
import { clearOperatorNotice } from '../../utils/operator-notice';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Clear the notice',
    description:
      'Removes the banner set with `PUT /api/operator/notice`: nobody sees it from their next page load. Answers `notice: null`, whether one was set or not. Open only to the token of `PIWI_OPERATOR_TOKEN`, as `GET /api/operator/usage` is.',
    security: [{ operatorToken: [] }],
  },
});

export default eventHandler(async (event) => {
  requireOperator(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  await clearOperatorNotice(await getDatabase());
  return { notice: null };
});
