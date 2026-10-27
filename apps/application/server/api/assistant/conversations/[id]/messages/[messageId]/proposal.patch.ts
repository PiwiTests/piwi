import { getDatabase } from '../../../../../../database';
import { requireAuth } from '../../../../../../utils/auth';
import { requireRouteId } from '../../../../../../utils/project-access';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../../../../../utils/assistant/turn';
import { recordAssistantProposalOutcome } from '#shared/handlers/assistant';
import { assistantProposalOutcomeSchema } from '#shared/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Record what became of a proposed change',
    description:
      "Records the outcome of a `proposal` block of an answer in one of the caller's conversations, so the conversation shows it: the body is `{ blockId, status, result? }`, `status` one of `applied`, `dismissed` or `failed`, and `result` (at most 300 characters) what the action's route answered, such as why it refused. The change itself is made by the dashboard calling the action's own route with the user's session, never by this route nor by the model. The response is the block as it now stands (`{ block }`, with its `outcome`: `{ status, result?, at }`). 404 for another user's conversation, administrators included, and for a message or block it does not hold; 409 for a proposal already applied or dismissed (a failed one can be applied again); 403 when the assistant is declined.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'messageId', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'conversation ID');
  const messageId = requireRouteId(event, 'messageId', 'message ID');
  const db = await getDatabase();
  await requireAssistantNotDeclined(db);
  const parsed = assistantProposalOutcomeSchema.safeParse(await readBody(event).catch(() => null));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  const recorded = await recordAssistantProposalOutcome(db, assistantOwnerOf(event, user), id, messageId, parsed.data);
  if (!recorded.ok) throw apiError({ statusCode: recorded.status, message: recorded.message });
  return { block: recorded.block };
});
