import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { requireRouteId } from '../../../utils/project-access';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../../utils/assistant/turn';
import { deleteAssistantConversation } from '#shared/handlers/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Delete one of your assistant conversations',
    description:
      "Deletes one of the caller's conversations and its messages (`{ success: true }`). Another user's conversation is a 404, administrators included. The tokens its answers spent still count toward the daily caps. 403 when the assistant is declined.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'conversation ID');
  const db = await getDatabase();
  await requireAssistantNotDeclined(db);
  if (!(await deleteAssistantConversation(db, assistantOwnerOf(event, user), id))) {
    throw apiError({ statusCode: 404, message: 'Conversation not found' });
  }
  return { success: true };
});
