import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../../utils/assistant/turn';
import { createAssistantConversation } from '#shared/handlers/assistant';
import { assistantConversationCreateSchema } from '#shared/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Start an assistant conversation',
    description:
      'Starts an empty conversation owned by the caller and returns it (`{ id, title, createdAt, updatedAt }`, 201). `title` is optional: a conversation without one takes its first question. Ask a question with the messages route. 403 when the assistant is declined.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  await requireAssistantNotDeclined(db);
  const parsed = assistantConversationCreateSchema.safeParse((await readBody(event).catch(() => null)) ?? {});
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  setResponseStatus(event, 201);
  return createAssistantConversation(db, assistantOwnerOf(event, user), parsed.data.title ?? '');
});
