/**
 * Posting a Slack message, through an incoming webhook or through the Web API
 * (`chat.postMessage` with a bot token). Both take the same `{ text, blocks }`
 * body; the Web API adds the channel ID. The bot token never appears in an
 * error message.
 */
import { slackDelivery } from '#shared/notifications/channel-setup';
import { decryptSecret, getEncryptionKey } from '../crypto';
import { safeFetch } from '../safe-fetch';

const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const SLACK_API_TIMEOUT_MS = 10_000;
/** The wait assumed when Slack answers 429 without a usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** The longest `Retry-After` honored: a Slack-compatible webhook server can name any wait. */
const MAX_RETRY_AFTER_SECONDS = 60 * 60;
/** The longest Slack error code carried into an error message. */
const SLACK_ERROR_MAX = 160;

/** Where a Slack message goes, with any bot token in plain text. */
export type SlackDestination = { webhookUrl: string } | { token: string; channelId: string };

/** Slack asked to wait before the next message (a 429), for `retryAfterSeconds`. */
export class SlackRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'SlackRateLimitError';
  }
}

function retryAfterSeconds(res: Response): number {
  const seconds = Number(res.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS);
}

/**
 * Post through the Web API. Slack answers HTTP 200 with `{ ok: false, error }`
 * for a refusal (`not_in_channel`, `invalid_auth`), which throws with that code.
 */
export async function postSlackApiMessage(
  token: string,
  channelId: string,
  message: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(SLACK_POST_MESSAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...message, channel: channelId }),
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });
  if (res.status === 429) {
    const wait = retryAfterSeconds(res);
    throw new SlackRateLimitError(`Slack API rate limit reached: retry in ${wait} s`, wait);
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (body?.ok === true) return;
  if (typeof body?.error === 'string' && body.error) {
    throw new Error(`Slack API refused the message: ${body.error.slice(0, SLACK_ERROR_MAX)}`);
  }
  throw new Error(`Slack API returned ${res.status}`);
}

/** Post to an incoming webhook and return its answer; only a 429 throws, so a caller words the other refusals. */
export async function postSlackWebhook(webhookUrl: string, message: Record<string, unknown>): Promise<Response> {
  const res = await safeFetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (res.status === 429) {
    const wait = retryAfterSeconds(res);
    throw new SlackRateLimitError(`Slack webhook rate limit reached: retry in ${wait} s`, wait);
  }
  return res;
}

/** Post a message to a Slack destination, throwing on any refusal. */
export async function postSlackMessage(destination: SlackDestination, message: Record<string, unknown>) {
  if ('token' in destination) return postSlackApiMessage(destination.token, destination.channelId, message);
  const res = await postSlackWebhook(destination.webhookUrl, message);
  if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
}

/** A saved Slack channel's destination, its bot token decrypted. */
export function storedSlackDestination(config: Record<string, unknown>): SlackDestination {
  if (slackDelivery(config) === 'api') {
    const encrypted = typeof config.token === 'string' ? config.token : '';
    if (!encrypted) throw new Error('No Slack bot token configured');
    let token: string;
    try {
      token = decryptSecret(encrypted, getEncryptionKey());
    } catch {
      throw new Error('The Slack bot token cannot be decrypted: PIWI_SECRET_KEY changed since it was saved');
    }
    return { token, channelId: typeof config.channelId === 'string' ? config.channelId.trim() : '' };
  }
  const webhookUrl = typeof config.webhookUrl === 'string' ? config.webhookUrl : '';
  if (!webhookUrl) throw new Error('No Slack webhook URL configured');
  return { webhookUrl };
}

/** The delay a failed delivery asks for before its retry, in milliseconds, or null. */
export function slackRetryAfterMs(err: unknown): number | null {
  return err instanceof SlackRateLimitError ? err.retryAfterSeconds * 1000 : null;
}
