import { getDatabase } from '../../database';
import { isAuthEnabled } from '../../utils/auth';
import { isEmailConfigured, renderInviteEmail, renderOperatorInviteNoticeEmail, sendEmail } from '../../utils/email';
import { requireOperator } from '../../utils/operator';
import { AdminInviteRefused, adminInviteSchema, inviteAdministrator } from '../../utils/operator-invite';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Invite an administrator',
    description:
      'Creates an administrator account for `email` (and an optional `name`), without a password, and emails that address a one-time link to set one, valid 72 hours. The link is never returned: the answer says only when it ends. Every other administrator with an email address is told, the Users page marks the account, and administrators see a banner, until the invitation is taken or ends. Refused with 409 `AUTH_DISABLED` while authentication is off, 503 `SMTP_NOT_CONFIGURED` without SMTP, 409 `EMAIL_TAKEN` when an account holds the address, and 502 `INVITE_NOT_SENT` when the email could not be sent, in which case no account is kept. Open only to the token of `PIWI_OPERATOR_TOKEN`, as `GET /api/operator/usage` is.',
    security: [{ operatorToken: [] }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { email: { type: 'string', format: 'email' }, name: { type: 'string' } },
            required: ['email'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  requireOperator(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  if (!isAuthEnabled(event)) {
    throw apiError({
      statusCode: 409,
      errorCode: 'AUTH_DISABLED',
      message: 'Authentication is off: every visitor is an administrator already',
    });
  }
  if (!isEmailConfigured()) {
    throw apiError({ statusCode: 503, errorCode: 'SMTP_NOT_CONFIGURED', message: 'SMTP is not configured' });
  }
  const parsed = adminInviteSchema.safeParse(await readBody(event));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid invitation', data: parsed.error.issues });

  try {
    const { expiresAt } = await inviteAdministrator(await getDatabase(), parsed.data, {
      async sendInvite(to, token, username) {
        const { html, text } = renderInviteEmail(token, username, 'the operator of this instance');
        await sendEmail({ to, subject: "You've been invited to Piwi", html, text });
      },
      async tellAdministrator(to, invited) {
        const { html, text } = renderOperatorInviteNoticeEmail(invited);
        await sendEmail({ to, subject: 'An administrator was invited to Piwi', html, text });
      },
    });
    setResponseStatus(event, 201);
    return { invited: true as const, expiresAt: expiresAt.toISOString() };
  } catch (error) {
    if (error instanceof AdminInviteRefused) {
      throw apiError({ statusCode: error.statusCode, errorCode: error.errorCode, message: error.message });
    }
    throw error;
  }
});
