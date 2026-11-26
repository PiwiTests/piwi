import { isAuthEnabled } from '../../../../utils/auth';
import { handleOAuthCallback } from '../../../../utils/oauth';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'OAuth callback',
    description:
      'Handles the OAuth provider callback, exchanges the authorization code, creates or links the user, and sets the session.',
    parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
    security: [],
  },
});

export default eventHandler(async (event) => {
  if (!isAuthEnabled()) {
    return sendRedirect(event, '/login?error=auth-disabled');
  }

  const provider = getRouterParam(event, 'provider');
  if (!provider) {
    return sendRedirect(event, '/login?error=invalid-provider');
  }

  const redirectUrl = await handleOAuthCallback(event, provider);
  return sendRedirect(event, redirectUrl);
});
