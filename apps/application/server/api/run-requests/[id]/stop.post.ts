import { eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { runRequests } from '../../../database/schema';
import { publishToRunTarget, publishWithdrawn } from '../../../utils/run-target-events';
import { getRequestAccess, requireAuth } from '../../../utils/auth';
import {
  endStaleRequests,
  findOwnRequest,
  requireRunRequestId,
  requireSignInForRunRequests,
  runRequestView,
  stopOwnRequest,
} from '../../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Stop one of your run requests',
    description:
      'Stops a run request the caller made. Still waiting for a claim, it ends at once as `stopped`, and the caller’s connected apps hear it `withdrawn` on their streams. Claimed but not answered, it ends at once too, and the app that holds it hears a `stop`. Running, the stop is passed to the connected app that holds it, which ends the run and reports it; a second stop, a minute after the first, ends it as `stopped` whatever the app does, and a request whose app stopped calling the instance for 5 minutes ends as an `error`. A request that already ended answers 409; anyone else’s, one of a project the caller can no longer read, or an unknown id, answers 404.',
    'x-required-permission': 'signed-in',
    responses: {
      200: { description: 'The request, after the stop' },
      404: { description: 'No request of yours has this id' },
      409: { description: 'The request has already ended' },
    },
  },
});

export default eventHandler(async (event) => {
  requireSignInForRunRequests(event);
  const user = await requireAuth(event);
  const id = requireRunRequestId(event);
  const db = await getDatabase();
  const access = await getRequestAccess(event);
  if (!(await findOwnRequest(db, id, user.id, access))) {
    throw apiError({ statusCode: 404, message: 'No run request has this id' });
  }
  if (!(await stopOwnRequest(db, id, user.id))) {
    throw apiError({ statusCode: 409, message: 'This request has already ended' });
  }
  // A request one app holds hears a stop there; one that was still waiting is withdrawn from every app it was offered to.
  const [held] = await db
    .select({ targetId: runRequests.targetId, claimedAt: runRequests.claimedAt })
    .from(runRequests)
    .where(eq(runRequests.id, id));
  if (held?.targetId && held.claimedAt) publishToRunTarget(held.targetId, { type: 'stop', id });
  else await publishWithdrawn(db, user.id, id);
  await endStaleRequests(db, new Date(), id);
  return runRequestView(db, (await findOwnRequest(db, id, user.id, access))!);
});
