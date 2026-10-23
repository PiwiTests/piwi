import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../../utils/assistant/turn';
import { dismissAssistantNudge } from '#shared/handlers/assistant-nudges';
import { isAssistantNudgeId } from '#shared/assistant-nudges';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Dismiss a nudge for good',
    description:
      'Dismisses one nudge for the caller, in every browser, and returns the dismissal (`{ nudgeId, dismissedAt }`). Dismissing it again keeps the first date. With authentication off the dismissal holds for every visitor. 400 for a nudge id the dashboard does not offer; 403 when the assistant is declined.',
    parameters: [
      {
        name: 'nudgeId',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
          enum: ['undecided-capabilities', 'diagnosis-without-diff', 'failure-without-fixtures'],
        },
      },
    ],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const nudgeId = getRouterParam(event, 'nudgeId');
  if (!isAssistantNudgeId(nudgeId)) throw apiError({ statusCode: 400, message: 'Unknown nudge' });
  const db = await getDatabase();
  await requireAssistantNotDeclined(db);
  return dismissAssistantNudge(db, assistantOwnerOf(event, user), nudgeId);
});
