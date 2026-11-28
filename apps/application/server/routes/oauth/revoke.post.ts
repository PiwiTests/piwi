import { getDatabase } from '../../database';
import { MCP_OAUTH_RATE_LIMITS, readClientCredentials } from '../../utils/mcp-oauth-helpers';
import { readOAuthParams, requireMcpOAuthEnabled, revokeToken, sendOAuthError } from '../../utils/mcp-oauth';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['MCP OAuth'],
    summary: 'Revoke an MCP connection',
    description:
      'Token revocation (RFC 7009), form-encoded: `token` (an access or refresh token) and the client’s credentials. Ends the connection the token belongs to, and deletes the API key that represents it. Answers 200 with an empty body, also for an unknown token. Rate-limited per client address; 409 with `errorCode` `READ_ONLY` while the instance is read-only; 404 when authentication is off.',
    security: [],
  },
});

export default eventHandler(async (event) => {
  requireMcpOAuthEnabled(event);
  const rateKey = `mcp-oauth:token:${rateLimitClientIp(event)}`;
  const { limit, windowMs } = MCP_OAUTH_RATE_LIMITS.token;
  if (!checkRateLimit(rateKey, limit, windowMs)) throw rateLimitedError(event, [rateKey]);

  const params = await readOAuthParams(event);
  const creds = readClientCredentials(getRequestHeader(event, 'authorization'), params);
  const err = await revokeToken(await getDatabase(), params.token, creds);
  if (err) return sendOAuthError(event, err, creds.basic);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return {};
});
