import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { mintAccountToken } from '../../utils/account-tokens';
import { isEmailConfigured, sendEmail, renderVerifyEmail } from '../../utils/email';
import { checkRateLimit, rateLimitedError } from '../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Send email verification link',
    description: "Sends a verification link to the authenticated user's email address.",
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  if (!user.email) throw apiError({ statusCode: 400, message: 'No email address on this account' });
  if (!isEmailConfigured())
    throw apiError({ statusCode: 503, errorCode: 'SMTP_NOT_CONFIGURED', message: 'SMTP is not configured' });

  // Bound how often a user can trigger verification emails.
  if (!checkRateLimit(`verify-email:${user.id}`, 5, 15 * 60 * 1000)) {
    throw rateLimitedError(event, [`verify-email:${user.id}`]);
  }

  const db = await getDatabase();
  const token = await mintAccountToken(db, user.id, 'verify', user.email);
  const { html, text } = renderVerifyEmail(token);

  try {
    await sendEmail({ to: user.email, subject: 'Verify your email — Piwi', html, text });
    return { success: true };
  } catch {
    throw apiError({ statusCode: 500, message: 'Failed to send verification email' });
  }
});
