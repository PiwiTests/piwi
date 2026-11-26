import { getDatabase } from '../../database';
import { authUserView, getCurrentUser, isAuthEnabled } from '../../utils/auth';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Get current user',
    description:
      'Returns the currently authenticated user details, with their access (instance role and the project roles they hold, own and through groups), or unauthenticated status.',
    security: [],
  },
});

export default eventHandler(async (event) => {
  if (!isAuthEnabled()) {
    return {
      authenticated: false,
      user: null,
    };
  }

  const user = await getCurrentUser(event);

  if (!user) {
    return {
      authenticated: false,
      user: null,
    };
  }

  return {
    authenticated: true,
    user: await authUserView(await getDatabase(), user),
  };
});
