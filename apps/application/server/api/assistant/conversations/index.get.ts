import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../../utils/assistant/turn';
import { listAssistantConversations } from '#shared/handlers/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'List your assistant conversations',
    description:
      "The caller's own assistant conversations, the most recently active first, at most 50: `{ items: [{ id, title, createdAt, updatedAt }] }`. Never another user's, administrators included; with authentication off every visitor shares one list. 403 when the assistant is declined.",
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  await requireAssistantNotDeclined(db);
  return listAssistantConversations(db, assistantOwnerOf(event, user));
});
