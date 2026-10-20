import { z } from 'zod';
import { requireAuth } from '../../utils/auth';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../utils/rate-limit';
import { deliverChannelTest, rememberTestedDestination } from '../../utils/notifications/channel-test';
import { channelConfigProblem, channelDeliveryHint } from '#shared/notifications/channel-setup';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'Send a test notification to an unsaved channel',
    description:
      'Sends a test notification to a destination before the channel is created (`email`, `slack`, `teams` or `webhook`, with the same `config` the create endpoint takes; a webhook `secret` is plain text here). Nothing is stored except a short-lived note that this destination was reached, so creating the same channel within a few minutes saves it as verified. A caller sends at most ten tests a minute (429 past that). Soft-fail like the saved-channel test: a rejected delivery returns HTTP 200 with `{ success: false, error, hint? }`.',
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

  const target = { type, config, secret: typeof config.secret === 'string' && config.secret ? config.secret : null };
  try {
    await deliverChannelTest(target);
    rememberTestedDestination(String(user.id), target);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = channelDeliveryHint(type, message);
    return { success: false, error: message, ...(hint ? { hint } : {}) };
  }
});
