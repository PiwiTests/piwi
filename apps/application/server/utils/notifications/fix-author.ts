/**
 * Reaching the person who fixed it.
 *
 * When a fix lands (or a recorded fix regresses) Piwi resolves the fixing
 * commit's author through the SCM provider and puts it on the event payload.
 * On top of the normal subscription routing, the event is then delivered to
 * that person directly:
 *
 * - **Email** through the existing outbox — but only when the commit's email
 *   belongs to a *registered* Piwi user. The message goes to that user's
 *   account email (their `personal_email` channel), never to the raw commit
 *   address, so a fix by an outside contributor never turns into an email to a
 *   stranger.
 * - **A browser notification** for that user, delivered by the SSE stream even
 *   when they have no matching subscription (per-user targeting).
 *
 * The recipient decision is a pure function so the "registered users only" rule
 * is unit-testable without a database or SMTP.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { notificationChannels, notificationDeliveries, users } from '../../database/schema';
import { isEmailConfigured } from '../email';
import { sweepOutbox } from './dispatch';
import { emailDestinationVerified } from './email-verified';
import {
  buildNotificationDedupeKey,
  type NotificationEvent,
  type NotificationPayload,
} from '#shared/notification-events';
import type { FixAuthor } from '#shared/notification-events';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = LibSQLDatabase<any>;

/** A registered user matched to a fix author's commit email. */
export interface FixAuthorRecipient {
  userId: number;
  /** The user's account email (used for the audit line, not for addressing). */
  email: string;
}

/** A user row the recipient rule considers — id and account email. */
export interface RegisteredUser {
  id: number;
  email: string | null;
}

/**
 * The registered user a fix should be delivered to, or null when there is none.
 *
 * The rule is strict: a fix is delivered to its author only when
 * the commit's email matches a registered Piwi user (case-insensitively).
 * An absent author, an author with no email, and an author who is not a
 * registered user all return null — the fix outcome then reaches people only
 * through the normal subscription routing, never as a mail to an address Piwi
 * does not own an account for.
 */
export function selectFixAuthorRecipient(
  fixAuthor: FixAuthor | null | undefined,
  candidates: RegisteredUser[],
): FixAuthorRecipient | null {
  const email = fixAuthor?.email?.trim().toLowerCase();
  if (!email) return null;
  const match = candidates.find((u) => u.email?.trim().toLowerCase() === email);
  return match?.email ? { userId: match.id, email: match.email } : null;
}

/** The registered user for a fix author's commit email, or null. */
async function resolveRecipient(db: Db, fixAuthor: FixAuthor | undefined): Promise<FixAuthorRecipient | null> {
  const email = fixAuthor?.email?.trim();
  if (!email) return null;
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(isNotNull(users.email), sql`lower(${users.email}) = ${email.toLowerCase()}`))
    .limit(1);
  return selectFixAuthorRecipient(fixAuthor, rows);
}

/** Find the user's auto-managed personal_email channel, creating it if absent. */
async function personalEmailChannelId(db: Db, userId: number): Promise<number> {
  const [existing] = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(and(eq(notificationChannels.type, 'personal_email'), eq(notificationChannels.userId, userId)))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(notificationChannels)
    .values({ name: 'Account email', type: 'personal_email', config: {}, userId, verified: true })
    .returning({ id: notificationChannels.id });
  return created!.id;
}

/**
 * Deliver a fix outcome to its author. Returns the user id to target the browser
 * notification at (null when the author is not a registered user), and enqueues
 * the personal email when SMTP is configured. Best-effort: any failure is
 * swallowed, because the run is already stored and the normal routing still ran.
 */
export async function notifyFixAuthor(
  db: Db,
  event: NotificationEvent,
  payload: NotificationPayload,
): Promise<{ targetUserId: number | null }> {
  try {
    const fixAuthor = (payload as { fixAuthor?: FixAuthor }).fixAuthor;
    const recipient = await resolveRecipient(db, fixAuthor);
    if (!recipient) return { targetUserId: null };

    // Email is best-effort on top of the targeted browser notification: a
    // registered author is targeted in the browser whether or not SMTP is up.
    if (
      isEmailConfigured() &&
      (await emailDestinationVerified(db, { type: 'personal_email', userId: recipient.userId }))
    ) {
      const channelId = await personalEmailChannelId(db, recipient.userId);
      const dedupeKey = `${buildNotificationDedupeKey(event, payload, channelId)}:fixauthor${recipient.userId}`;
      try {
        await db.insert(notificationDeliveries).values({
          subscriptionId: null,
          channelId,
          event,
          payload: payload as unknown as Record<string, unknown>,
          dedupeKey,
          status: 'pending',
          scheduledFor: new Date(),
          createdAt: new Date(),
        });
        sweepOutbox(db).catch((e) => console.error('[fix-author] sweep after enqueue failed', e));
      } catch {
        // Unique dedupeKey → already enqueued for this author+run, skip silently.
      }
    }

    return { targetUserId: recipient.userId };
  } catch (e) {
    console.error('[fix-author] notifyFixAuthor failed', e);
    return { targetUserId: null };
  }
}
