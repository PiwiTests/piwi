import { getDatabase } from '../../../../database';
import { connectionByWebhookToken } from '../../../../utils/integrations/connections';
import { refreshLinkByExternalId } from '../../../../utils/integrations/sync';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Jira inbound webhook',
    description:
      'Refresh one tracked issue from a Jira "issue updated" webhook. The secret token in the path selects the connection; the handler only ever refreshes the links to that issue of the projects bound to that connection and applies the resolve/reopen policies — it can never create or transition anything. Public and rate-limited.',
    parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
    security: [],
  },
});

/** Pull the Jira issue's stable id out of a webhook payload. */
function issueIdFromBody(body: unknown): string | null {
  const issue = (body as { issue?: { id?: unknown } } | null)?.issue;
  const id = issue?.id;
  if (typeof id === 'string' && id) return id;
  if (typeof id === 'number') return String(id);
  return null;
}

export default eventHandler(async (event) => {
  // Rate-limit by client IP so a leaked or guessed token cannot be hammered.
  const ip = rateLimitClientIp(event);
  const key = `jira-webhook:${ip}`;
  if (!checkRateLimit(key, 60, 60_000)) throw rateLimitedError(event, [key]);

  const token = getRouterParam(event, 'token') ?? '';
  const db = await getDatabase();
  const connection = await connectionByWebhookToken(db, token);
  // A wrong token looks like success — never confirm which tokens exist.
  if (!connection) return { ok: true };

  const body = await readBody(event).catch(() => null);
  const issueId = issueIdFromBody(body);
  if (!issueId) return { ok: true };

  const refreshed = await refreshLinkByExternalId(db, connection.id, issueId).catch(() => false);
  return { ok: true, refreshed };
});
