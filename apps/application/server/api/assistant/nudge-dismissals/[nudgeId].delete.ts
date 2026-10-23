import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { assistantOwnerOf, requireAssistantNotDeclined } from '../../../utils/assistant/turn';
import { undoAssistantNudgeDismissal } from '#shared/handlers/assistant-nudges';
import { isAssistantNudgeId } from '#shared/assistant-nudges';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: 'Show a dismissed nudge again',
    description:
      "Removes the caller's dismissal of one nudge (`{ success: true }`), so the page offers it again when its rule holds. 404 when the caller had not dismissed it, 400 for a nudge id the dashboard does not offer; 403 when the assistant is declined.",
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
  if (!(await undoAssistantNudgeDismissal(db, assistantOwnerOf(event, user), nudgeId))) {
    throw apiError({ statusCode: 404, message: 'This nudge is not dismissed' });
  }
  return { success: true };
});
