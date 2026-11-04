import { getDatabase } from '../../database';
import { findUserByEmail } from '#shared/handlers/users';
import { mintAccountToken } from '../../utils/account-tokens';
import { isEmailConfigured, sendEmail, renderPasswordResetEmail } from '../../utils/email';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../utils/rate-limit';
import { z } from 'zod';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Request password reset',
    description:
      'If a non-OAuth user with the given email exists (letter case ignored), sends a password reset link to the address that account stores. Always returns 200 to prevent user enumeration. Rate-limited.',
    security: [],
  },
});

const schema = z.object({ email: z.string().email() });

export default eventHandler(async (event) => {
  const rateKey = `forgot:${rateLimitClientIp(event)}`;
  if (!checkRateLimit(rateKey, 5, 15 * 60 * 1000)) {
    throw rateLimitedError(event, [rateKey]);
  }

  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { success: true }; // silently ignore bad input (no enumeration)
  }

  const { email } = parsed.data;
  const db = await getDatabase();
  const user = await findUserByEmail(db, email);

  // Silently no-op for: user not found, OAuth-only accounts, or email not configured
  if (!user?.email || !user.password || !isEmailConfigured()) {
    return { success: true };
  }

  const token = await mintAccountToken(db, user.id, 'reset', user.email);
  const { html, text } = renderPasswordResetEmail(token, user.username);

  sendEmail({ to: user.email, subject: 'Reset your Piwi Dashboard password', html, text }).catch((e) =>
    console.error('[auth/forgot-password] Failed to send email:', e),
  );

  return { success: true };
});
