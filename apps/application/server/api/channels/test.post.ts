import { z } from 'zod';
import { getRequestAccess, isAuthEnabled, requireAuth } from '../../utils/auth';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../utils/rate-limit';
import {
  CHANNEL_TEST_TEXT,
  deliverChannelTest,
  rememberTestedDestination,
  unsavedTestTarget,
} from '../../utils/notifications/channel-test';
import { channelConfigProblem, channelDeliveryHint } from '#shared/notifications/channel-setup';
import { getDatabase } from '../../database';
import { requestCredentialActor } from '../../utils/credentials';
import { channelCredentialId, postSlackWithCredential } from '../../utils/notifications/slack-credentials';
import { slackChannelCredentialProblem } from '#shared/handlers/credentials';
import { isAdministrator } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'Send a test notification to an unsaved channel',
    description:
      'Sends a test notification to a destination before the channel is created (`email`, `slack`, `teams` or `webhook`, with the same `config` the create endpoint takes; a webhook `secret` and a Slack bot `token` are plain text here; a Slack `credentialId` sends with a saved Slack credential, for an administrator, and the message is logged under it). Nothing is stored except a short-lived note that this destination was reached, so creating the same channel within a few minutes saves it as verified. A caller sends at most ten tests a minute (429 past that). Soft-fail like the saved-channel test: a rejected delivery returns HTTP 200 with `{ success: false, error, hint? }`.',
    'x-required-permission': 'signed-in',
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

const schema = z.object({
  type: z.enum(['email', 'slack', 'teams', 'webhook']),
  config: z.record(z.string(), z.unknown()),
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  // With authentication off every caller is user 0, so the source address tells callers apart.
  const rateKey = `channel-test:${user.id || rateLimitClientIp(event)}`;
  if (!checkRateLimit(rateKey, 10, 60_000)) throw rateLimitedError(event, [rateKey]);
  const parsed = schema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }
  const { type, config } = parsed.data;
  const problem = channelConfigProblem(type, config);
  if (problem) throw apiError({ statusCode: 400, message: problem });

  const target = unsavedTestTarget(type, config);
  const credentialId = type === 'slack' ? channelCredentialId(config) : null;
  if (credentialId != null) {
    // A saved credential goes only with a channel of the instance, which only an administrator creates.
    if (isAuthEnabled(event) && !isAdministrator(await getRequestAccess(event))) {
      throw apiError({ statusCode: 403, message: 'Only administrators can send with a saved credential' });
    }
    const refused = await slackChannelCredentialProblem(await getDatabase(), credentialId);
    if (refused) throw apiError({ statusCode: 400, message: refused });
  }
  try {
    if (credentialId != null) {
      await postSlackWithCredential(await getDatabase(), {
        credentialId,
        channel: { id: null, slackChannelId: String(config.channelId ?? '').trim() },
        message: { text: CHANNEL_TEST_TEXT },
        actor: requestCredentialActor(event, user),
      });
    } else {
      await deliverChannelTest(target);
    }
    rememberTestedDestination(String(user.id), target);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = channelDeliveryHint(type, message);
    return { success: false, error: message, ...(hint ? { hint } : {}) };
  }
});
