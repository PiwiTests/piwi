/**
 * The nudges a user dismissed for good: list them, dismiss one, show one again.
 * Shared by the server routes and the demo.
 *
 * A dismissal belongs to its owner, as an assistant conversation does: the
 * signed-in user's id, or null with authentication off, when every visitor is
 * the same virtual administrator and a dismissal holds for the whole instance.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { assistantNudgeDismissals } from '../../server/database/schema';
import { isAssistantNudgeId, type AssistantNudgeDismissal, type AssistantNudgeId } from '#shared/assistant-nudges';
import type { AssistantOwner } from './assistant';
import type { DrizzleDB } from './db';

type DismissalRow = typeof assistantNudgeDismissals.$inferSelect;

function ownedBy(ownerId: AssistantOwner) {
  return ownerId === null ? isNull(assistantNudgeDismissals.ownerId) : eq(assistantNudgeDismissals.ownerId, ownerId);
}

function toDismissal(row: DismissalRow): AssistantNudgeDismissal {
  return { nudgeId: row.nudgeId as AssistantNudgeId, dismissedAt: new Date(row.dismissedAt).toISOString() };
}

/** The owner's dismissed nudges, in the order they were dismissed; a nudge no longer offered is left out. */
export async function listAssistantNudgeDismissals(
  db: DrizzleDB,
  ownerId: AssistantOwner,
): Promise<{ items: AssistantNudgeDismissal[] }> {
  const rows = await db
    .select()
    .from(assistantNudgeDismissals)
    .where(ownedBy(ownerId))
    .orderBy(asc(assistantNudgeDismissals.dismissedAt), asc(assistantNudgeDismissals.id));
  return { items: rows.filter((row) => isAssistantNudgeId(row.nudgeId)).map(toDismissal) };
}

/** Dismiss `nudgeId` for the owner; dismissing it again keeps the first date. */
export async function dismissAssistantNudge(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  nudgeId: AssistantNudgeId,
): Promise<AssistantNudgeDismissal> {
  await db.insert(assistantNudgeDismissals).values({ ownerId, nudgeId, dismissedAt: new Date() }).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(assistantNudgeDismissals)
    .where(and(ownedBy(ownerId), eq(assistantNudgeDismissals.nudgeId, nudgeId)))
    .orderBy(asc(assistantNudgeDismissals.id))
    .limit(1);
  return toDismissal(row!);
}

/** Show `nudgeId` to the owner again; false when they had not dismissed it. */
export async function undoAssistantNudgeDismissal(
  db: DrizzleDB,
  ownerId: AssistantOwner,
  nudgeId: AssistantNudgeId,
): Promise<boolean> {
  const deleted = await db
    .delete(assistantNudgeDismissals)
    .where(and(ownedBy(ownerId), eq(assistantNudgeDismissals.nudgeId, nudgeId)))
    .returning({ id: assistantNudgeDismissals.id });
  return deleted.length > 0;
}

/** Delete every dismissal a user owns (the user is being deleted). */
export async function deleteAssistantNudgeDismissalsOf(db: DrizzleDB, ownerId: number): Promise<void> {
  await db.delete(assistantNudgeDismissals).where(eq(assistantNudgeDismissals.ownerId, ownerId));
}
