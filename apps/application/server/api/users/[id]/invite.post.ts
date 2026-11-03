import { eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { users } from '../../../database/schema';
import { requireAuth } from '../../../utils/auth';
import { mintAccountToken } from '../../../utils/account-tokens';
import { isEmailConfigured, sendEmail, renderInviteEmail } from '../../../utils/email';
import { requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Send invite email',
    description:
      'Sends an invite email to a user with a link to set their password. Requires the user to have an email address set (400) and SMTP to be configured (503).',
    'x-required-permission': 'users:manage',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
  },
});

export default eventHandler(async (event) => {
  const admin = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'user ID');

  const db = await getDatabase();
  const userRows = await db.select().from(users).where(eq(users.id, id));
  const user = userRows[0];
  if (!user) throw apiError({ statusCode: 404, message: 'User not found' });
  if (!user.email) throw apiError({ statusCode: 400, message: 'User has no email address' });

  if (!isEmailConfigured())
    throw apiError({ statusCode: 503, errorCode: 'SMTP_NOT_CONFIGURED', message: 'SMTP is not configured' });

  const token = await mintAccountToken(db, user.id, 'invite', user.email);
  const { html, text } = renderInviteEmail(token, admin.name || admin.username);

  try {
    await sendEmail({ to: user.email, subject: "You've been invited to Piwi Dashboard", html, text });
    console.info('[users/invite] Invite sent to user %d (%s)', user.id, user.email);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[users/invite] Failed to send invite:', message);
    throw apiError({ statusCode: 500, message: 'Failed to send invite email' });
  }
});
