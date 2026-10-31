import { and, eq, inArray, lte, lt } from 'drizzle-orm';
import { notificationDeliveries, notificationChannels, subscriptions, users } from '../../database/schema';
import { sendEmail, renderNotificationEmail, renderDigestEmail, isEmailConfigured, type DigestItem } from '../email';
import { decryptSecret, getEncryptionKey } from '../crypto';
import { safeFetch } from '../safe-fetch';
import type { NotificationEvent, NotificationPayload } from '#shared/notification-events';
import { renderEventSubject } from '#shared/notification-events';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { claimOutboxRows, nextAttempt, OUTBOX_MAX_ATTEMPTS, OUTBOX_SWEEPABLE_STATUSES } from '../outbox';
import { REPORT_READY_EVENT, type ReportReadyPayload } from '#shared/notification-events';
import {
  loadReportForDelivery,
  publishReportNotification,
  reportSlackMessage,
  reportWebhookBody,
  sendReportEmail,
  snapshotUrl,
} from '../reports/deliver';
import { deliveredShareUrl } from '../reports/context';
import { teamsDigestMessage, teamsEventMessage, teamsReportMessage } from './teams';
import { slackDigestMessage, slackEventMessage } from './slack-message';
import { postSlackMessage, slackRetryAfterMs, storedSlackDestination } from './slack-api';
import { emailDestinationVerified } from './email-verified';

const MAX_ATTEMPTS = OUTBOX_MAX_ATTEMPTS;

const siteBase = () => process.env.PIWI_SITE_URL?.replace(/\/$/, '') || 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = LibSQLDatabase<any>;

interface ChannelRow {
  id: number;
  type: string;
  userId: number | null;
  config: unknown;
  verified?: boolean | null;
}

interface DeliveryRow {
  id: number;
  event: string;
  payload: unknown;
  attempts: number | null;
  scheduledFor: Date | null;
}

/** Resolve the destination address for an email or personal_email channel, refusing an unverified one. */
async function resolveEmailAddress(db: Db, channel: ChannelRow): Promise<string> {
  if (!(await emailDestinationVerified(db, channel))) {
    throw new Error(
      channel.type === 'personal_email'
        ? 'Account email not verified'
        : 'Email channel not verified: send it a test from Settings → Notifications',
    );
  }
  if (channel.type === 'personal_email') {
    if (!channel.userId) throw new Error('Personal email channel has no owner');
    const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, channel.userId));
    if (!owner?.email) throw new Error('Account has no email address');
    return owner.email;
  }
  const to = (channel.config as Record<string, unknown> | null)?.address as string;
  if (!to) throw new Error('No email address configured');
  return to;
}

async function sendToEmail(to: string, event: NotificationEvent, payload: NotificationPayload) {
  if (!isEmailConfigured()) throw new Error('SMTP not configured');

  const { html, text } = renderNotificationEmail(event, payload);
  await sendEmail({ to, subject: renderEventSubject(event, payload), html, text });
}

/** Post to a saved Slack channel, through its webhook or the Web API. */
async function postToSlack(config: Record<string, unknown>, body: Record<string, unknown>) {
  await postSlackMessage(storedSlackDestination(config), body);
}

async function postToTeams(config: Record<string, unknown>, body: Record<string, unknown>) {
  const webhookUrl = config.webhookUrl as string;
  if (!webhookUrl) throw new Error('No Microsoft Teams webhook URL configured');
  const res = await safeFetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Microsoft Teams webhook returned ${res.status}`);
}

async function sendToSlack(config: Record<string, unknown>, event: NotificationEvent, payload: NotificationPayload) {
  await postToSlack(config, slackEventMessage(event, payload, siteBase()));
}

async function sendSlackDigest(config: Record<string, unknown>, items: DigestItem[]) {
  await postToSlack(config, slackDigestMessage(items, siteBase()));
}

async function sendToWebhook(config: Record<string, unknown>, event: NotificationEvent, payload: NotificationPayload) {
  await postSignedWebhook(config, JSON.stringify({ event, payload, timestamp: new Date().toISOString() }));
}

/** POST a JSON body to a webhook channel, HMAC-SHA256 signed in `X-Piwi-Signature` when it has a secret. */
async function postSignedWebhook(config: Record<string, unknown>, body: string) {
  const url = config.url as string;
  if (!url) throw new Error('No webhook URL configured');

  const encryptedSecret = config.secret as string | undefined;
  const secret = encryptedSecret ? decryptSecret(encryptedSecret, getEncryptionKey()) : null;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (secret) {
    // HMAC-SHA256 signature in X-Piwi-Signature
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Piwi-Signature'] = `sha256=${sig}`;
  }

  const res = await safeFetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
}

/**
 * Deliver a quality report (`report.ready`, queued by a report schedule):
 * the snapshot rendered for the channel type.
 */
async function sendQualityReport(db: Db, d: DeliveryRow, c: ChannelRow) {
  const config = (c.config ?? {}) as Record<string, unknown>;
  const payload = (d.payload ?? {}) as ReportReadyPayload;
  const { bundle, projectIds } = await loadReportForDelivery(db as any, payload);
  const shareUrl = deliveredShareUrl(payload.shareToken);
  if (c.type === 'personal_email' || c.type === 'email') {
    await sendReportEmail(await resolveEmailAddress(db, c), bundle, payload, shareUrl);
  } else if (c.type === 'slack') {
    await postToSlack(config, reportSlackMessage(bundle, snapshotUrl(payload.snapshotId), shareUrl));
  } else if (c.type === 'teams') {
    await postToTeams(config, teamsReportMessage(bundle, snapshotUrl(payload.snapshotId), shareUrl));
  } else if (c.type === 'webhook') {
    await postSignedWebhook(config, reportWebhookBody(bundle, payload, shareUrl));
  } else if (c.type === 'browser') {
    publishReportNotification(bundle, payload, c.userId, projectIds);
  } else throw new Error(`Unknown channel type: ${c.type}`);
}

/** Deliver a single outbox row through its channel. */
async function sendSingle(db: Db, d: DeliveryRow, c: ChannelRow) {
  // A quality report is not a notification event: it has its own renderers and no subject line.
  if (d.event === REPORT_READY_EVENT) return sendQualityReport(db, d, c);
  const config = (c.config ?? {}) as Record<string, unknown>;
  const event = d.event as NotificationEvent;
  const payload = (d.payload ?? {}) as NotificationPayload;

  if (c.type === 'personal_email' || c.type === 'email') {
    await sendToEmail(await resolveEmailAddress(db, c), event, payload);
  } else if (c.type === 'slack') await sendToSlack(config, event, payload);
  else if (c.type === 'teams') await postToTeams(config, teamsEventMessage(event, payload, siteBase()));
  else if (c.type === 'webhook') await sendToWebhook(config, event, payload);
  else if (c.type === 'browser') {
    /* Delivered via SSE — the notification/stream endpoint handles this channel type */
  } else throw new Error(`Unknown channel type: ${c.type}`);
}

/** Deliver a batch of digest-mode rows through one channel as one message. */
async function sendDigest(db: Db, c: ChannelRow, rows: DeliveryRow[]) {
  const items: DigestItem[] = rows.map((d) => ({
    event: d.event as NotificationEvent,
    payload: (d.payload ?? {}) as NotificationPayload,
  }));

  if (c.type === 'personal_email' || c.type === 'email') {
    if (!isEmailConfigured()) throw new Error('SMTP not configured');
    const to = await resolveEmailAddress(db, c);
    const { subject, html, text } = renderDigestEmail(items);
    await sendEmail({ to, subject, html, text });
  } else if (c.type === 'slack') {
    await sendSlackDigest((c.config ?? {}) as Record<string, unknown>, items);
  } else if (c.type === 'teams') {
    await postToTeams((c.config ?? {}) as Record<string, unknown>, teamsDigestMessage(items, siteBase()));
  } else {
    throw new Error(`Digest not supported for channel type: ${c.type}`);
  }
}

async function markSent(db: Db, rows: DeliveryRow[], now: Date) {
  for (const d of rows) {
    await db
      .update(notificationDeliveries)
      .set({ status: 'sent', sentAt: now, attempts: (d.attempts ?? 0) + 1, error: null })
      .where(eq(notificationDeliveries.id, d.id));
  }
}

/** Record a failed attempt; a rate-limited one (Slack's 429) retries after the wait it asked for. */
async function markFailed(db: Db, rows: DeliveryRow[], err: unknown, now: Date) {
  const message = err instanceof Error ? err.message : String(err);
  for (const d of rows) {
    const attempts = (d.attempts ?? 0) + 1;
    const next = nextAttempt(attempts, now, d.scheduledFor, slackRetryAfterMs(err));

    await db
      .update(notificationDeliveries)
      .set({
        status: next.status,
        attempts,
        error: message,
        scheduledFor: next.scheduledFor,
      })
      .where(eq(notificationDeliveries.id, d.id));

    console.error(`[notifications] Delivery ${d.id} failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${message}`);
  }
}

export interface SweepResult {
  sent: number;
  failed: number;
}

/** The sweep running in this process, and the one pass queued behind it. */
let activeSweep: Promise<SweepResult> | null = null;
let queuedSweep: Promise<SweepResult> | null = null;

/**
 * Process the deliveries that are due now (see `sweepDue`). One sweep runs at a
 * time in this process: a call made while one is running waits for it, then
 * shares a single follow-up pass with every other call made meanwhile, so rows
 * written during a sweep still go out.
 */
export function sweepOutbox(db: Db): Promise<SweepResult> {
  if (!activeSweep) {
    activeSweep = sweepDue(db).finally(() => {
      activeSweep = null;
    });
    return activeSweep;
  }
  queuedSweep ??= activeSweep
    .catch(() => undefined)
    .then(() => {
      queuedSweep = null;
      return sweepOutbox(db);
    });
  return queuedSweep;
}

/**
 * Send the deliveries that are due now (scheduledFor <= now, attempts < MAX):
 * `pending` ones, and `processing` ones whose claim's lease has run out.
 *
 * Email and Slack deliveries queued by a digest-mode subscription batch into
 * one message per channel; every other delivery (realtime, webhook, browser)
 * sends individually. Each row is claimed just before it is sent and skipped
 * when another sweep holds it. Returns per-row sent/failed counts.
 */
async function sweepDue(db: Db): Promise<SweepResult> {
  const now = new Date();
  let sent = 0;
  let failed = 0;

  const due = await db
    .select({ d: notificationDeliveries, c: notificationChannels, mode: subscriptions.mode })
    .from(notificationDeliveries)
    .innerJoin(notificationChannels, eq(notificationDeliveries.channelId, notificationChannels.id))
    .leftJoin(subscriptions, eq(notificationDeliveries.subscriptionId, subscriptions.id))
    .where(
      and(
        inArray(notificationDeliveries.status, OUTBOX_SWEEPABLE_STATUSES),
        lte(notificationDeliveries.scheduledFor, now),
        lt(notificationDeliveries.attempts, MAX_ATTEMPTS),
      ),
    );

  const digestable = (row: (typeof due)[number]) =>
    row.mode === 'digest' &&
    (row.c.type === 'email' || row.c.type === 'personal_email' || row.c.type === 'slack' || row.c.type === 'teams');

  const singles: (typeof due)[number][] = [];
  const digestGroups = new Map<number, (typeof due)[number][]>();
  for (const row of due) {
    if (!digestable(row)) {
      singles.push(row);
      continue;
    }
    const group = digestGroups.get(row.c.id);
    if (group) group.push(row);
    else digestGroups.set(row.c.id, [row]);
  }
  // A batch of one reads better as the full single-event message.
  for (const [channelId, group] of digestGroups) {
    if (group.length === 1) {
      singles.push(group[0]!);
      digestGroups.delete(channelId);
    }
  }

  for (const { d, c } of singles) {
    const claimed = await claimOutboxRows(db, notificationDeliveries, [d.id]);
    if (!claimed.has(d.id)) continue;
    try {
      await sendSingle(db, d, c);
      await markSent(db, [d], now);
      sent++;
    } catch (err) {
      await markFailed(db, [d], err, now);
      failed++;
    }
  }

  for (const group of digestGroups.values()) {
    const claimed = await claimOutboxRows(
      db,
      notificationDeliveries,
      group.map((g) => g.d.id),
    );
    const rows = group.map((g) => g.d).filter((d) => claimed.has(d.id));
    if (rows.length === 0) continue;
    try {
      await sendDigest(db, group[0]!.c, rows);
      await markSent(db, rows, now);
      sent += rows.length;
    } catch (err) {
      await markFailed(db, rows, err, now);
      failed += rows.length;
    }
  }

  return { sent, failed };
}
