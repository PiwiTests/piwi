import { getDatabase } from '../../database';
import { requireOperator } from '../../utils/operator';
import { readOperatorNotice } from '../../utils/operator-notice';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Get the notice the operator set',
    description:
      'The banner set with `PUT /api/operator/notice`, ended or not, or `notice: null` when none is set. Open only to the token of `PIWI_OPERATOR_TOKEN`, as `GET /api/operator/usage` is.',
    security: [{ operatorToken: [] }],
  },
});

export default eventHandler(async (event) => {
  requireOperator(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return { notice: await readOperatorNotice(await getDatabase()) };
});
