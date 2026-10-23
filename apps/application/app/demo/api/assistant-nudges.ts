/**
 * The nudges a demo visitor dismissed (`server/api/assistant/nudge-dismissals`),
 * kept in the in-browser database through the server's shared handler, per
 * acting persona as the server keeps them per user.
 */
import { isAssistantDeclined } from '#shared/handlers/assistant';
import {
  dismissAssistantNudge,
  listAssistantNudgeDismissals,
  undoAssistantNudgeDismissal,
} from '#shared/handlers/assistant-nudges';
import { isAssistantNudgeId, type AssistantNudgeId } from '#shared/assistant-nudges';
import { getDemoDb } from '../db.client';
import { demoHttpError } from './http-error';

async function requireNotDeclined(): Promise<void> {
  if (await isAssistantDeclined(await getDemoDb())) {
    throw demoHttpError(403, 'The assistant is declined on this instance');
  }
}

function nudgeIdOf(raw: string): AssistantNudgeId {
  const nudgeId = decodeURIComponent(raw);
  if (!isAssistantNudgeId(nudgeId)) throw demoHttpError(400, 'Unknown nudge');
  return nudgeId;
}

/** GET /api/assistant/nudge-dismissals */
export async function apiListAssistantNudgeDismissals(ownerId: number | null) {
  await requireNotDeclined();
  return listAssistantNudgeDismissals(await getDemoDb(), ownerId);
}

/** PUT /api/assistant/nudge-dismissals/:nudgeId */
export async function apiDismissAssistantNudge(raw: string, ownerId: number | null) {
  const nudgeId = nudgeIdOf(raw);
  await requireNotDeclined();
  return dismissAssistantNudge(await getDemoDb(), ownerId, nudgeId);
}

/** DELETE /api/assistant/nudge-dismissals/:nudgeId */
export async function apiUndoAssistantNudgeDismissal(raw: string, ownerId: number | null) {
  const nudgeId = nudgeIdOf(raw);
  await requireNotDeclined();
  if (!(await undoAssistantNudgeDismissal(await getDemoDb(), ownerId, nudgeId))) {
    throw demoHttpError(404, 'This nudge is not dismissed');
  }
  return { success: true };
}
