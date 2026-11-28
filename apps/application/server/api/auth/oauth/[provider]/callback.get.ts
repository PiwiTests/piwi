import { isAuthEnabled } from '../../../../utils/auth';
import { handleOAuthCallback } from '../../../../utils/oauth';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'OAuth callback',
    description:
      'Handles the OAuth provider callback, exchanges the authorization code, creates or links the user, and sets the session. While the instance is read-only, the account already linked to the provider identity signs in with its profile as stored, and a sign-in or a connection that would create or link an account goes back with `error=read-only`.',
    parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
    security: [],
  },
});

export default eventHandler(async (event) => {
  if (!isAuthEnabled(event)) {
    return sendRedirect(event, '/login?error=auth-disabled');
  }

  const provider = getRouterParam(event, 'provider');
  if (!provider) {
    return sendRedirect(event, '/login?error=invalid-provider');
  }

  const redirectUrl = await handleOAuthCallback(event, provider);
  return sendRedirect(event, redirectUrl);
});
