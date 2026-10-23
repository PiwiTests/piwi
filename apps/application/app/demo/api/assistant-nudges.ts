/**
 * The nudges a demo visitor dismissed (`server/api/assistant/nudge-dismissals`),
 * kept in the in-browser database through the server's shared handler, per
 * acting persona as the server keeps them per user.
 */
import {
  dismissAssistantNudge,
  listAssistantNudgeDismissals,
  undoAssistantNudgeDismissal,
} from '#shared/handlers/assistant-nudges';
import { isAssistantNudgeId, type AssistantNudgeId } from '#shared/assistant-nudges';
import { getDemoDb } from '../db.client';
import { demoHttpError } from './http-error';

function nudgeIdOf(raw: string): AssistantNudgeId {
  const nudgeId = decodeURIComponent(raw);
  if (!isAssistantNudgeId(nudgeId)) throw demoHttpError(400, 'Unknown nudge');
  return nudgeId;
}

/** GET /api/assistant/nudge-dismissals */
export async function apiListAssistantNudgeDismissals(ownerId: number | null) {
  return listAssistantNudgeDismissals(await getDemoDb(), ownerId);
}

/** PUT /api/assistant/nudge-dismissals/:nudgeId */
export async function apiDismissAssistantNudge(raw: string, ownerId: number | null) {
  const nudgeId = nudgeIdOf(raw);
  return dismissAssistantNudge(await getDemoDb(), ownerId, nudgeId);
}

/** DELETE /api/assistant/nudge-dismissals/:nudgeId */
export async function apiUndoAssistantNudgeDismissal(raw: string, ownerId: number | null) {
  const nudgeId = nudgeIdOf(raw);
  if (!(await undoAssistantNudgeDismissal(await getDemoDb(), ownerId, nudgeId))) {
    throw demoHttpError(404, 'This nudge is not dismissed');
  }
  return { success: true };
}
