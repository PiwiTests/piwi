import { clearUserSession, getCurrentUser, isAuthEnabled, revokeUserSessions } from '../../utils/auth';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Logout',
    description:
      "Clears the current user session and revokes every session of the signed-in user, so a copy of the session cookie stops working and the user's other browsers are signed out too.",
    security: [],
  },
});

export default eventHandler(async (event) => {
  if (!isAuthEnabled(event)) {
    throw apiError({
      statusCode: 400,
      message: 'Authentication is not enabled',
    });
  }

  const user = await getCurrentUser(event);
  if (user) await revokeUserSessions(user.id);
  await clearUserSession(event);

  return {
    success: true,
  };
});
