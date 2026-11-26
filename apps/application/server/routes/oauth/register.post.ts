import { getDatabase } from '../../database';
import { MCP_OAUTH_RATE_LIMITS } from '../../utils/mcp-oauth-helpers';
import { readOAuthParams, registerClient, requireMcpOAuthEnabled, sendOAuthError } from '../../utils/mcp-oauth';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['MCP OAuth'],
    summary: 'Register an MCP client',
    description:
      'OAuth 2.0 Dynamic Client Registration (RFC 7591). Body: the client metadata as JSON, `redirect_uris` required (`https`, `http` on a loopback host, or an application scheme such as `cursor://`; no fragment). Answers 201 with the `client_id`; a client asking for `client_secret_post` or `client_secret_basic` also gets a `client_secret`, any other is public and proves itself with PKCE. Registering grants no access: the user still allows each connection. Clients idle for 30 days with no connection are deleted. Rate-limited per client address; 404 when authentication is off.',
    security: [],
  },
});

export default eventHandler(async (event) => {
  requireMcpOAuthEnabled();
  const rateKey = `mcp-oauth:register:${rateLimitClientIp(event)}`;
  const { limit, windowMs } = MCP_OAUTH_RATE_LIMITS.register;
  if (!checkRateLimit(rateKey, limit, windowMs)) throw rateLimitedError(event, [rateKey]);

  const result = await registerClient(await getDatabase(), await readOAuthParams(event));
  if ('error' in result) return sendOAuthError(event, result);
  setResponseStatus(event, 201);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return result;
});
