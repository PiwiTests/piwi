import { getDatabase } from '../../database';
import { MCP_OAUTH_RATE_LIMITS, readClientCredentials } from '../../utils/mcp-oauth-helpers';
import { exchangeToken, readOAuthParams, requireMcpOAuthEnabled, sendOAuthError } from '../../utils/mcp-oauth';
import { publicBaseUrl } from '../../utils/public-base-url';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['MCP OAuth'],
    summary: 'Issue MCP access tokens',
    description:
      'The token endpoint (RFC 6749 §3.2), form-encoded. `grant_type=authorization_code` redeems a code with `code`, `redirect_uri`, `client_id` and the PKCE `code_verifier`; `grant_type=refresh_token` renews with `refresh_token`. Answers `{ access_token, token_type: "Bearer", expires_in, refresh_token, scope }`: the access token (`pdo_` prefix) lasts an hour and authenticates `/mcp` only, the refresh token lasts 30 days from its last use and is replaced on each use. A refresh token presented again within a minute of its exchange answers with the same tokens (two requests refreshing at once); later, like a code presented twice, it ends the connection. Errors are `{ error, error_description }`. Rate-limited per client address; 404 when authentication is off.',
    security: [],
  },
});

export default eventHandler(async (event) => {
  requireMcpOAuthEnabled();
  const rateKey = `mcp-oauth:token:${rateLimitClientIp(event)}`;
  const { limit, windowMs } = MCP_OAUTH_RATE_LIMITS.token;
  if (!checkRateLimit(rateKey, limit, windowMs)) throw rateLimitedError(event, [rateKey]);

  const params = await readOAuthParams(event);
  const creds = readClientCredentials(getRequestHeader(event, 'authorization'), params);
  const result = await exchangeToken(await getDatabase(), params, creds, publicBaseUrl(event));
  if ('error' in result) return sendOAuthError(event, result, creds.basic);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return result;
});
