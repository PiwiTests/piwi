import { getDatabase } from '../../../../database';
import { connectionByWebhookToken } from '../../../../utils/integrations/connections';
import { refreshLinksForIssue, type IssueRef } from '../../../../utils/integrations/sync';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Jira inbound webhook',
    description:
      'Refresh one tracked issue from a Jira "issue updated" webhook. The secret token in the path selects the connection; the issue id and key in the payload name the issue, and the handler only ever refreshes the links to that issue (matched by either) of the projects bound to that connection and applies the resolve/reopen policies — it can never create or transition anything. Public and rate-limited.',
    parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
    security: [],
  },
});

/** Pull the Jira issue's stable id and key out of a webhook payload; null when it names neither. */
function issueFromBody(body: unknown): IssueRef | null {
  const issue = (body as { issue?: { id?: unknown; key?: unknown } } | null)?.issue;
  let id: string | null = null;
  if (typeof issue?.id === 'string' && issue.id) id = issue.id;
  else if (typeof issue?.id === 'number' && Number.isFinite(issue.id)) id = String(issue.id);
  const key = typeof issue?.key === 'string' && issue.key ? issue.key : null;
  return id || key ? { id, key } : null;
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
  const issue = issueFromBody(body);
  if (!issue) return { ok: true };

  const refreshed = await refreshLinksForIssue(db, connection.id, issue).catch(() => false);
  return { ok: true, refreshed };
});
