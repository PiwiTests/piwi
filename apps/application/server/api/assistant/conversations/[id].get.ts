import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { requireRouteId } from '../../../utils/project-access';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../../utils/assistant/turn';
import { getAssistantConversation } from '#shared/handlers/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Read one of your assistant conversations',
    description:
      "One of the caller's conversations with its messages in order. Each message has its `role` (`user`, `assistant`), its `blocks` in order (`{ kind: 'text', text }`, and the blocks other than text an answer sent: `code`, `command`, `patch`, `entity`, `options` with the `picked` option, `question` with the user's `answer`, `checklist` with each step's `done`, `guide`, `navigate`), the page `context` a question was asked on, the `toolCalls` an answer made (`{ name, arguments, summary, error?, entities? }`), its `provider`, `model`, `inputTokens`, `outputTokens`, `status` (`completed`, `failed`) and `error`. Another user's conversation is a 404, administrators included. 403 when the assistant is declined.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'conversation ID');
  const db = await getDatabase();
  await requireAssistantNotDeclined(db);
  const conversation = await getAssistantConversation(db, assistantOwnerOf(event, user), id);
  if (!conversation) throw apiError({ statusCode: 404, message: 'Conversation not found' });
  return conversation;
});
