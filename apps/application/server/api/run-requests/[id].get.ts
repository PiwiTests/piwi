import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import {
  findOwnRequest,
  requireRunRequestId,
  requireSignInForRunRequests,
  runRequestView,
} from '../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Read one of your run requests',
    description:
      'Answers a run request the caller made, with its state (`waiting`, `claimed`, `declined`, `expired`, `refused`, `starting`, `running`, `stopping`, `ended`), its outcome once ended, and the connected app that claimed it. A request belongs to the person who made it: anyone else’s, or an unknown id, answers 404.',
    'x-required-permission': 'signed-in',
    responses: {
      200: { description: 'The request' },
      404: { description: 'No request of yours has this id' },
    },
  },
});

export default eventHandler(async (event) => {
  requireSignInForRunRequests(event);
  const user = await requireAuth(event);
  const id = requireRunRequestId(event);
  const db = await getDatabase();
  const row = await findOwnRequest(db, id, user.id);
  if (!row) throw apiError({ statusCode: 404, message: 'No run request has this id' });
  return runRequestView(db, row);
});
