import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../utils/assistant/turn';
import { listAssistantQuestions } from '#shared/handlers/assistant';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: "The caller's recent questions",
    description:
      "The questions the caller typed to the assistant, newest first, each once, across their conversations (`{ items: string[] }`, at most 50): what the panel's Up arrow brings back into its input. A question that replied to a `question` or `options` block is left out. Never another user's, administrators included. 403 when the assistant is declined.",
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  await requireAssistantNotDeclined(db);
  return listAssistantQuestions(db, assistantOwnerOf(event, user));
});
