import { isAuthEnabled, getCurrentUser } from '../../../../utils/auth';
import { initiateOAuth } from '../../../../utils/oauth';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Initiate OAuth login',
    description:
      'Redirects the user to the configured OAuth provider for authentication. Pass `?link=1` while signed in to connect the provider to the current account instead of signing in.',
    parameters: [
      { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'link', in: 'query', required: false, schema: { type: 'string', enum: ['1'] } },
    ],
    security: [],
  },
});

export default eventHandler(async (event) => {
  if (!isAuthEnabled()) {
    throw apiError({
      statusCode: 400,
      message: 'Authentication is not enabled',
    });
  }

  const provider = getRouterParam(event, 'provider');
  if (!provider) {
    throw apiError({
      statusCode: 400,
      message: 'Provider is required',
    });
  }

  // Link mode connects the provider to the signed-in user; it requires a session.
  const link = getQuery(event).link === '1';
  if (link) {
    const user = await getCurrentUser(event);
    if (!user) {
      return sendRedirect(event, '/login?error=link-requires-login');
    }
  }

  const returnTo = typeof getQuery(event).redirect === 'string' ? String(getQuery(event).redirect) : null;
  const redirectUrl = initiateOAuth(event, provider, { link, returnTo });
  if (!redirectUrl) {
    throw apiError({
      statusCode: 400,
      message: `OAuth provider "${provider}" is not configured`,
    });
  }

  return sendRedirect(event, redirectUrl);
});
