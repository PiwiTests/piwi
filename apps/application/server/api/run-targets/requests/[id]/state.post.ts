import { z } from 'zod';
import { RUN_REQUEST_OUTCOMES } from '@piwitests/core/run-request';
import {
  moveRequestState,
  requireRunRequestId,
  requireRunTarget,
  runRequestView,
  type RunStateUpdate,
} from '../../../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Report the state of a requested run',
    description:
      'The connected app running a request reports its next state: `running`, `stopping`, or `ended` with an `outcome` (`passed`, `failed`, `stopped`, `error`), and an optional `detail` (at most 500 characters). A run only moves forward: `starting` → `running` → `stopping` → `ended`, and ends once; any other move answers 409. Authenticated with the key of the target that claimed it.',
    'x-required-permission': 'run:receive',
    responses: {
      200: { description: 'The request, in its new state' },
      404: { description: 'No request of the owner has this id' },
      409: { description: 'Not a move from the request’s current state' },
    },
  },
});

const detail = z.string().trim().min(1).max(500).optional();
const bodySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running'), detail }).strict(),
  z.object({ state: z.literal('stopping'), detail }).strict(),
  z.object({ state: z.literal('ended'), outcome: z.enum(RUN_REQUEST_OUTCOMES), detail }).strict(),
]);

export default eventHandler(async (event) => {
  const caller = await requireRunTarget(event);
  const id = requireRunRequestId(event);
  const parsed = bodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }
  const { detail: words, ...update } = parsed.data;
  const moved = await moveRequestState(caller, id, update as RunStateUpdate, words ?? null);
  if (!moved.ok) throw apiError({ statusCode: moved.statusCode, message: moved.message });
  return runRequestView(caller.db, moved.row);
});
