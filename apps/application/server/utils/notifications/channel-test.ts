import { createHash, createHmac } from 'node:crypto';
import { slackDelivery, type DeliverableChannelType } from '#shared/notifications/channel-setup';
import { renderTestEmail, isEmailConfigured, sendEmail } from '../email';
import { safeFetch } from '../safe-fetch';
import { teamsMessage } from './teams';
import { postSlackApiMessage, postSlackWebhook } from './slack-api';

/**
 * A destination to send a test notification to. `secret` holds, in plain text,
 * the credential the config keeps encrypted once saved: a webhook's signing
 * secret, or the bot token of a Slack channel posting through the Web API.
 */
export interface ChannelTestTarget {
  type: DeliverableChannelType;
  config: Record<string, unknown>;
  secret?: string | null;
}

/** The test target for a channel not saved yet, whose config carries its credential in plain text. */
export function unsavedTestTarget(type: DeliverableChannelType, config: Record<string, unknown>): ChannelTestTarget {
  const key = type === 'webhook' ? 'secret' : type === 'slack' && slackDelivery(config) === 'api' ? 'token' : null;
  const value = key ? config[key] : null;
  return { type, config, secret: typeof value === 'string' && value ? value.trim() : null };
}

const TEST_TEXT = ':bell: Test notification from Piwi Dashboard';

/** The short text a chat webhook answers a refusal with (`no_service`, `invalid_payload`), or ''. */
async function refusalDetail(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('<')) return '';
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

async function refusal(service: string, res: Response): Promise<Error> {
  const detail = await refusalDetail(res);
  return new Error(detail ? `${service} returned ${res.status}: ${detail}` : `${service} returned ${res.status}`);
}

/**
 * Send one test notification. Throws with the destination's own refusal on
 * failure, so the caller can show it and derive a hint from it.
 */
export async function deliverChannelTest(target: ChannelTestTarget): Promise<void> {
  const { type, config } = target;
  if (type === 'email') {
    const to = config.address as string;
    if (!to) throw new Error('No email address configured');
    if (!isEmailConfigured()) throw new Error('SMTP not configured');
    const { html, text } = renderTestEmail(to);
    await sendEmail({ to, subject: 'Test notification — Piwi Dashboard', html, text });
    return;
  }
  if (type === 'slack' && slackDelivery(config) === 'api') {
    if (!target.secret) throw new Error('No Slack bot token');
    await postSlackApiMessage(target.secret, (config.channelId as string).trim(), { text: TEST_TEXT });
    return;
  }
  if (type === 'slack') {
    const webhookUrl = config.webhookUrl as string;
    if (!webhookUrl) throw new Error('No Slack webhook URL');
    const res = await postSlackWebhook(webhookUrl, { text: TEST_TEXT });
    if (!res.ok) throw await refusal('Slack', res);
    return;
  }
  if (type === 'teams') {
    const webhookUrl = config.webhookUrl as string;
    if (!webhookUrl) throw new Error('No Microsoft Teams webhook URL');
    const res = await safeFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        teamsMessage([{ type: 'TextBlock', text: 'Test notification from Piwi Dashboard', wrap: true }]),
      ),
    });
    if (!res.ok) throw await refusal('Microsoft Teams', res);
    return;
  }
  const url = config.url as string;
  if (!url) throw new Error('No webhook URL');
  const body = JSON.stringify({ event: 'test', payload: {}, timestamp: new Date().toISOString() });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (target.secret) {
    headers['X-Piwi-Signature'] = `sha256=${createHmac('sha256', target.secret).update(body).digest('hex')}`;
  }
  const res = await safeFetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw await refusal('Webhook', res);
}

/** How long a delivered pre-save test counts toward saving the channel as verified. */
const TESTED_TTL_MS = 15 * 60 * 1000;
const TESTED_MAX_ENTRIES = 500;

/** Destinations a pre-save test reached, keyed by owner and destination, with the time it happened. */
const testedDestinations = new Map<string, number>();

function destinationKey(owner: string, target: ChannelTestTarget): string {
  const { type, config } = target;
  let destination: unknown = config.webhookUrl;
  if (type === 'email') destination = config.address;
  else if (type === 'webhook') destination = [config.url, target.secret ?? ''];
  else if (type === 'slack' && slackDelivery(config) === 'api') {
    destination = [(config.channelId as string).trim(), target.secret ?? ''];
  }
  return createHash('sha256')
    .update(JSON.stringify([owner, type, destination ?? null]))
    .digest('hex');
}

/** Record that a pre-save test reached this destination for this owner. */
export function rememberTestedDestination(owner: string, target: ChannelTestTarget): void {
  const now = Date.now();
  for (const [key, at] of testedDestinations) {
    if (now - at > TESTED_TTL_MS) testedDestinations.delete(key);
  }
  if (testedDestinations.size >= TESTED_MAX_ENTRIES) {
    const oldest = testedDestinations.keys().next().value;
    if (oldest !== undefined) testedDestinations.delete(oldest);
  }
  testedDestinations.set(destinationKey(owner, target), now);
}

/**
 * Whether this owner's pre-save test reached this exact destination within the
 * last few minutes, so the channel it then saves starts verified.
 */
export function wasDestinationTested(owner: string, target: ChannelTestTarget): boolean {
  const at = testedDestinations.get(destinationKey(owner, target));
  return at !== undefined && Date.now() - at <= TESTED_TTL_MS;
}
