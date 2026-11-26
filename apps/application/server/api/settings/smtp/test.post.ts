import { requireAuth } from '../../../utils/auth';
import { isEmailConfigured, sendEmail, renderTestEmail } from '../../../utils/email';
import { z } from 'zod';

defineRouteMeta({
  openAPI: {
    tags: ['Settings'],
    summary: 'Send test email',
    description:
      'Sends a test email via the env-configured SMTP settings to verify the configuration. Requires `settings:manage` (administrators only). Soft-fail: when SMTP is reachable but the send fails, the response is HTTP 200 with `{ success: false, error }` — the request was processed, only the delivery failed. HTTP error statuses are reserved for request-level problems (SMTP not configured → 503, invalid recipient → 400).',
    'x-required-permission': 'settings:manage',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['to'],
            properties: { to: { type: 'string', format: 'email' } },
          },
        },
      },
    },
    responses: {
      '200': {
        description: 'Delivery attempt result. `success` reports the outcome; a failed send still returns 200.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['success'],
              properties: {
                success: { type: 'boolean' },
                error: { type: 'string', description: 'Present only when success is false.' },
              },
            },
          },
        },
      },
    },
  },
});

const schema = z.object({ to: z.string().email() });

export default eventHandler(async (event) => {
  await requireAuth(event);

  if (!isEmailConfigured()) {
    throw apiError({ statusCode: 503, errorCode: 'SMTP_NOT_CONFIGURED', message: 'SMTP is not configured' });
  }

  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request: to must be a valid email address' });
  }

  const { to } = parsed.data;
  const { html, text } = renderTestEmail(to);

  try {
    await sendEmail({ to, subject: 'Test email — Piwi', html, text });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[smtp/test] Failed to send test email:', message);
    return { success: false, error: message };
  }
});
