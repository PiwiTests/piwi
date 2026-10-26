import { eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { notificationChannels, users } from '../../../database/schema';
import { getRequestAccess, requireAuth } from '../../../utils/auth';
import { decryptSecret, getEncryptionKey } from '../../../utils/crypto';
import { deliverChannelTest } from '../../../utils/notifications/channel-test';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../../utils/rate-limit';
import {
  channelDeliveryHint,
  isDeliverableChannelType,
  slackDelivery,
  type ChannelType,
} from '#shared/notifications/channel-setup';
import { isAdministrator } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'Send test notification',
    description:
      'Sends a test notification through the specified channel and marks it verified on success; an email channel receives notifications only once verified. Global channels can only be tested by administrators. A caller sends at most ten tests a minute, saved or unsaved channels alike (429 past that). Soft-fail: a reachable endpoint that rejects the delivery (bad webhook URL, SMTP failure, non-2xx response) returns HTTP 200 with `{ success: false, error }` — the request was processed, only the delivery attempt failed. HTTP error statuses are reserved for request-level problems (bad id, missing channel, not authorized).',
    'x-required-permission': 'signed-in',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    responses: {
      '200': {
        description: 'Delivery attempt result. `success` reports the outcome; a failed delivery still returns 200.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['success'],
              properties: {
                success: { type: 'boolean' },
                error: { type: 'string', description: 'Present only when success is false.' },
                hint: {
                  type: 'string',
                  description: 'What to do about a failed delivery, when there is more to say than the error.',
                },
              },
            },
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = parseInt(getRouterParam(event, 'id') || '0');
  if (!id) throw apiError({ statusCode: 400, message: 'Invalid channel ID' });

  const db = await getDatabase();
  const [channel] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, id));
  if (!channel) throw apiError({ statusCode: 404, message: 'Channel not found' });

  const isAdmin = isAdministrator(await getRequestAccess(event));
  // Global channels reach every subscriber, so only admins may fire tests at them.
  const allowed = channel.userId === null ? isAdmin : channel.userId === user.id || isAdmin;
  if (!allowed) {
    throw apiError({ statusCode: 403, message: 'Not authorized' });
  }

  // The same budget as testing an unsaved channel. With authentication off every
  // caller is user 0, so the source address tells callers apart.
  const rateKey = `channel-test:${user.id || rateLimitClientIp(event)}`;
  if (!checkRateLimit(rateKey, 10, 60_000)) throw rateLimitedError(event, [rateKey]);

  const config = (channel.config ?? {}) as Record<string, unknown>;
  const type = channel.type as ChannelType | 'personal_email';

  try {
    if (type === 'personal_email') {
      if (!channel.userId) throw new Error('Personal email channel has no owner');
      const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, channel.userId));
      if (!owner?.email) throw new Error('Account has no email address');
      await deliverChannelTest({ type: 'email', config: { address: owner.email } });
    } else if (isDeliverableChannelType(type)) {
      // The stored credential: a webhook's signing secret, or a Slack bot token.
      const key = type === 'webhook' ? 'secret' : type === 'slack' && slackDelivery(config) === 'api' ? 'token' : null;
      const encrypted = key && typeof config[key] === 'string' ? (config[key] as string) : null;
      const secret = encrypted ? decryptSecret(encrypted, getEncryptionKey()) : null;
      await deliverChannelTest({ type, config, secret });
    }

    // A delivered test proves the destination works. personal_email stays
    // driven by account email verification instead.
    if (channel.type !== 'personal_email' && !channel.verified) {
      await db
        .update(notificationChannels)
        .set({ verified: true, updatedAt: new Date() })
        .where(eq(notificationChannels.id, id));
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = channelDeliveryHint(type === 'personal_email' ? 'email' : (type as ChannelType), message);
    return { success: false, error: message, ...(hint ? { hint } : {}) };
  }
});
