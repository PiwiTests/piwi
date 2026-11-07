import { z } from 'zod';
import {
  answerRequest,
  requireRunRequestId,
  requireRunTarget,
  runRequestView,
  type TargetAnswer,
} from '../../../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Answer a claimed run request',
    description:
      'The person’s answer in the connected app, to a request this target claimed: `{ decision: "run" }` after they clicked **Run** (the request moves to `starting`, and the answer carries `runToken`: the reporter presents it in place of an API key to start the run, once, within 30 minutes), `{ decision: "not-now" }` (`declined`), or `{ decision: "refused", detail }` when a check failed before the confirmation, with its words (at most 500 characters). **Run** is refused (409) once the requester stopped the request. Authenticated with the target’s key alone.',
    'x-required-permission': 'run:receive',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The request, after the answer, with `runToken` after **Run**' },
      404: { description: 'No request of the owner has this id' },
      409: { description: 'Not waiting for an answer from this target, or stopped' },
    },
  },
});

const bodySchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('run') }).strict(),
  z.object({ decision: z.literal('not-now') }).strict(),
  z.object({ decision: z.literal('refused'), detail: z.string().trim().min(1).max(500) }).strict(),
]);

export default eventHandler(async (event) => {
  const caller = await requireRunTarget(event);
  const id = requireRunRequestId(event);
  const parsed = bodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }
  const answered = await answerRequest(caller, id, parsed.data as TargetAnswer);
  if (!answered.ok) throw apiError({ statusCode: answered.statusCode, message: answered.message });
  const view = await runRequestView(caller.db, answered.row);
  return answered.runToken ? { ...view, runToken: answered.runToken } : view;
});
