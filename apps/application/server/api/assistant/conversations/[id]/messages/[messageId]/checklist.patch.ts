import { getDatabase } from '../../../../../../database';
import { requireAuth } from '../../../../../../utils/auth';
import { requireRouteId } from '../../../../../../utils/project-access';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../../../../../utils/assistant/turn';
import { tickAssistantChecklist } from '#shared/handlers/assistant';
import { assistantChecklistTickSchema } from '#shared/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Tick a checklist step of an assistant answer',
    description:
      "Ticks or unticks one step of a `checklist` block of an answer in one of the caller's conversations. The body is `{ blockId, stepId, done }`; the tick is kept with the conversation, and the response is the checklist block as it now stands (`{ block }`, each step with `done` when ticked). 404 for another user's conversation, administrators included, and for a message, block or step it does not hold; 403 when the assistant is declined.",
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
  const parsed = assistantChecklistTickSchema.safeParse(await readBody(event).catch(() => null));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  const block = await tickAssistantChecklist(db, assistantOwnerOf(event, user), id, messageId, parsed.data);
  if (!block) throw apiError({ statusCode: 404, message: 'Checklist step not found' });
  return { block };
});
