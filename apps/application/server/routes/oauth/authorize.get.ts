import { getDatabase } from '../../database';
import { MCP_OAUTH_RATE_LIMITS } from '../../utils/mcp-oauth-helpers';
import { requireMcpOAuthEnabled, startAuthorization } from '../../utils/mcp-oauth';
import { publicBaseUrl } from '../../utils/public-base-url';
import { checkRateLimit, clientNetwork, rateLimitClientIp, rateLimitedError } from '../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['MCP OAuth'],
    summary: 'Start an MCP client authorization',
    description:
      'The authorization endpoint of the authorization code flow (RFC 6749 §4.1), opened by the MCP client in the browser. Query: `response_type=code`, `client_id` (a registered client’s, or, with `PIWI_MCP_CLIENT_METADATA_DOCUMENTS=true`, the HTTPS URL of the client’s metadata document, which is fetched and checked here once the rest of the request is), `redirect_uri`, `code_challenge` with `code_challenge_method=S256` (required), `state`, and optionally `scope` and `resource` (RFC 8707, the `/mcp` URL). Redirects to the consent page, where the signed-in user allows or denies. An invalid request also lands on the consent page, with `error` naming the reason: it is never sent to the client’s redirect URI before the user answers, since anyone can register one; while the instance is read-only, every request lands there with `error=read_only`. 404 when authentication is off.',
    security: [],
  },
});

export default eventHandler(async (event) => {
  requireMcpOAuthEnabled(event);
  // An IPv6 client counts by its /64, which one host holds whole.
  const rateKey = `mcp-oauth:authorize:${clientNetwork(rateLimitClientIp(event))}`;
  const { limit, windowMs } = MCP_OAUTH_RATE_LIMITS.authorize;
  if (!checkRateLimit(rateKey, limit, windowMs)) throw rateLimitedError(event, [rateKey]);

  const start = await startAuthorization(await getDatabase(), getQuery(event), publicBaseUrl(event));
  const consent = start.kind === 'consent' ? `request=${start.requestId}` : `error=${start.error}`;
  return sendRedirect(event, `/oauth/consent?${consent}`, 302);
});
