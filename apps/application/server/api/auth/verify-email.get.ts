import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../../database';
import { users } from '../../database/schema';
import { validateAccountToken, consumeAccountToken } from '../../utils/account-tokens';
import { refuseWhileReadOnly } from '../../utils/operator-limits';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Verify email address',
    description:
      'Validates a verify token from the emailed link and marks the account email as verified. A link sent to an address the account no longer holds is refused (400), and every link while the instance is read-only (409, `READ_ONLY`).',
    security: [],
    parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
  },
});

export default eventHandler(async (event) => {
  refuseWhileReadOnly();
  const token = getQuery(event).token as string | undefined;
  if (!token) throw apiError({ statusCode: 400, message: 'Missing token' });

  const db = await getDatabase();
  const validated = await validateAccountToken(db, token, 'verify');
  if (!validated) throw apiError({ statusCode: 400, message: 'Invalid or expired verification link' });

  // The write matches the address again: one changed since the validation verifies nothing.
  const verified = await db
    .update(users)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(and(eq(users.id, validated.userId), eq(users.email, validated.email)))
    .returning({ id: users.id });
  if (!verified.length) throw apiError({ statusCode: 400, message: 'Invalid or expired verification link' });
  await consumeAccountToken(db, validated.tokenId);

  // Redirect to settings with success indicator
  return sendRedirect(event, '/settings/account?verified=1');
});
