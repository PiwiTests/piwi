import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { MCP_OAUTH_RATE_LIMITS } from '../../../utils/mcp-oauth-helpers';
import { describeAuthorization, requireMcpOAuthEnabled } from '../../../utils/mcp-oauth';
import { limitLookupMisses, rateLimitClientIp } from '../../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['MCP OAuth'],
    summary: 'Describe an MCP client authorization request',
    description:
      'What the consent page at `/oauth/consent` shows before the user allows or denies: the name the client registered (self-asserted), its `client_uri`, where the answer is sent (`web` with the host, `loopback` for an application on the user’s computer, `app` with the scheme), the expiry and the status (`pending`, `approved`, `denied`, `consumed` or `expired`). The path parameter is the request id the authorize endpoint put in the consent page URL. Failed lookups are rate-limited; 404 when authentication is off.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  requireMcpOAuthEnabled(event);
  const user = await requireAuth(event);
  const missKey = `mcp-oauth:miss:${user.id}:${rateLimitClientIp(event)}`;
  const db = await getDatabase();
  const view = await limitLookupMisses(
    event,
    missKey,
    MCP_OAUTH_RATE_LIMITS.lookupMiss,
    () => describeAuthorization(db, getRouterParam(event, 'id')),
    (found) => !found,
  );
  if (!view) throw apiError({ statusCode: 404, message: 'No authorization request has this id' });
  return view;
});
