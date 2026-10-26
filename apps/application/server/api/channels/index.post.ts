import { getDatabase } from '../../database';
import { notificationChannels } from '../../database/schema';
import { getRequestAccess, requireAuth, isAuthEnabled } from '../../utils/auth';
import { encryptSecret, getEncryptionKey } from '../../utils/crypto';
import { sanitizeChannelConfig } from '../../utils/channels';
import { unsavedTestTarget, wasDestinationTested } from '../../utils/notifications/channel-test';
import {
  CHANNEL_TYPES,
  channelConfigProblem,
  isDeliverableChannelType,
  slackDelivery,
} from '#shared/notifications/channel-setup';
import { isAdministrator } from '#shared/permissions';
import { z } from 'zod';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'Create a notification channel',
    description:
      'Creates a new notification channel (`email`, `slack`, `teams` for a Microsoft Teams incoming webhook, `webhook` or `browser`). The destination is required: an email `address`, a `webhookUrl` for Slack and Teams, a `url` for a webhook. A Slack channel can post through the Web API (`chat.postMessage`) instead of a webhook: give it the bot `token` (`xoxb-…`) and the `channelId`. Webhook secrets and Slack bot tokens are encrypted at rest and never returned, so a webhook `secret` or a Slack `token` answers HTTP 409 while `PIWI_SECRET_KEY` is unset. A channel whose destination the same user reached with `POST /api/channels/test` in the last few minutes is saved as verified. Administrators can create global channels; with authentication disabled every channel is global.',
    'x-required-permission': 'signed-in',
  },
});

const schema = z.object({
  name: z.string().min(1),
  type: z.enum(CHANNEL_TYPES),
  config: z.record(z.string(), z.unknown()),
  global: z.boolean().optional(), // admin only: create a global (userId=null) channel
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }

  const { name, type, config, global: requestedGlobal } = parsed.data;

  if (requestedGlobal && !isAdministrator(await getRequestAccess(event))) {
    throw apiError({ statusCode: 403, message: 'Only administrators can create global channels' });
  }
  const problem = channelConfigProblem(type, config);
  if (problem) throw apiError({ statusCode: 400, message: problem });

  // A destination this user's pre-save test just reached starts verified.
  const verified =
    isDeliverableChannelType(type) && wasDestinationTested(String(user.id), unsavedTestTarget(type, config));

  // Without auth there is no user row to own a channel — everything is global.
  const isGlobal = requestedGlobal || !isAuthEnabled(event);

  // Credentials are stored encrypted: a webhook's signing secret, a Slack bot token.
  let storedConfig: Record<string, unknown> = { ...config };
  if (type === 'webhook' && typeof config.secret === 'string' && config.secret) {
    storedConfig = { ...config, secret: encryptSecret(config.secret, getEncryptionKey()) };
  } else if (type === 'slack' && slackDelivery(config) === 'api') {
    storedConfig = {
      token: encryptSecret((config.token as string).trim(), getEncryptionKey()),
      channelId: (config.channelId as string).trim(),
    };
  } else if (type === 'slack') {
    storedConfig = { webhookUrl: config.webhookUrl };
  }

  const db = await getDatabase();
  const [channel] = await db
    .insert(notificationChannels)
    .values({
      name,
      type,
      config: storedConfig,
      userId: isGlobal ? null : user.id,
      verified,
    })
    .returning();

  return {
    success: true,
    channel: {
      id: channel?.id,
      name: channel?.name,
      type: channel?.type,
      userId: channel?.userId ?? null,
      verified: Boolean(channel?.verified),
      createdAt: channel?.createdAt,
      updatedAt: channel?.updatedAt,
      config: sanitizeChannelConfig((channel?.config ?? {}) as Record<string, unknown>),
    },
  };
});
