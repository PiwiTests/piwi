import { z } from 'zod';
import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { MCP_OAUTH_RATE_LIMITS } from '../../../../utils/mcp-oauth-helpers';
import { decideAuthorization, requireMcpOAuthEnabled } from '../../../../utils/mcp-oauth';
import { publicBaseUrl } from '../../../../utils/public-base-url';
import { limitLookupMisses, rateLimitClientIp } from '../../../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['MCP OAuth'],
    summary: 'Allow or deny an MCP client authorization request',
    description:
      'Body: `{ allow }`. Answers `{ status, redirectTo }`: the client’s redirect URI with an authorization code, or with `error=access_denied`, for the consent page to open. Allowing lets the client redeem the code once, within five minutes, for tokens that act on the MCP server with the signed-in user’s role and project access; the connection is listed with the user’s API keys, named after the client, and revoked there. 404 for an unknown request, 409 when it was already answered, 410 when it expired; 404 when authentication is off.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    'x-required-permission': 'signed-in',
  },
});

const bodySchema = z.object({ allow: z.boolean() });

export default eventHandler(async (event) => {
  requireMcpOAuthEnabled(event);
  const user = await requireAuth(event);
  const missKey = `mcp-oauth:miss:${user.id}:${rateLimitClientIp(event)}`;
  const parsed = bodySchema.safeParse(await readBody(event));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });

  const db = await getDatabase();
  const decision = await limitLookupMisses(
    event,
    missKey,
    MCP_OAUTH_RATE_LIMITS.lookupMiss,
    () =>
      decideAuthorization(
        db,
        { requestId: getRouterParam(event, 'id'), userId: user.id, allow: parsed.data.allow },
        publicBaseUrl(event),
      ),
    (result) => result.status === 'not-found',
  );
  if (decision.status === 'not-found') {
    throw apiError({ statusCode: 404, message: 'No authorization request has this id' });
  }
  if (decision.status === 'already-decided') {
    throw apiError({ statusCode: 409, message: 'This request was already answered' });
  }
  if (decision.status === 'expired') throw apiError({ statusCode: 410, message: 'This request has expired' });
  return decision;
});
