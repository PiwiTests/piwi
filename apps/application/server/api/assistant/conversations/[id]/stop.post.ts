import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../../../utils/assistant/turn';
import { stopAssistantAnswer } from '../../../../utils/assistant/running';
import { findAssistantConversation } from '#shared/handlers/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Stop the answer being written',
    description:
      "Stops the answer one of the caller's conversations is writing: its stream ends with an `error` event of code `stopped`, and the answer is stored with what it wrote, as a failed answer. `{ stopped }` is false when the conversation was writing no answer on this server process. 404 for another user's conversation; 403 when the assistant is declined.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'conversation ID');
  const db = await getDatabase();
  await requireAssistantNotDeclined(db);
  if (!(await findAssistantConversation(db, assistantOwnerOf(event, user), id))) {
    throw apiError({ statusCode: 404, message: 'Conversation not found' });
  }
  return { stopped: stopAssistantAnswer(id) };
});
