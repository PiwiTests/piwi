import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../../utils/assistant/turn';
import { listAssistantNudgeDismissals } from '#shared/handlers/assistant-nudges';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'List the nudges you dismissed',
    description:
      "The nudges the caller dismissed for good, in the order they were dismissed: `{ items: [{ nudgeId, dismissedAt }] }`. A nudge is a suggestion a page offers when a rule over what it shows holds; the dashboard shows none of these again, in any browser. Never another user's, administrators included; with authentication off every visitor shares one list. 403 when the assistant is declined.",
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  await requireAssistantNotDeclined(db);
  return listAssistantNudgeDismissals(db, assistantOwnerOf(event, user));
});
