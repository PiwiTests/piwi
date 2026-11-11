import { apiError } from '../../../../utils/api-error';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { createTracker } from '../../../../utils/integrations/connections';
import { requireConnectionAccess } from '../../../../utils/integrations/connection-access';
import { IntegrationHttpError } from '../../../../utils/integrations/http-error';
import { assignableCache, assignableFailureCache } from '../../../../utils/integrations/picker-cache';
import { CONNECTION_NOT_FOUND } from '#shared/integrations/connection-access';

/** Longer than any Jira account id. */
const ACCOUNT_ID_MAX = 128;

/** What the search answers when Jira never answered it. */
const NO_ANSWER = 'Jira did not answer the search for assignable people.';

/**
 * A failed search as this route answers it: the tracker's refusal with its
 * status, or no status when the call timed out or never reached the tracker.
 * Undefined for anything else.
 */
function searchFailure(err: unknown): { message: string; providerStatus: number | null } | undefined {
  if (err instanceof IntegrationHttpError) return { message: err.message, providerStatus: err.status };
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { message: NO_ANSWER, providerStatus: null };
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message))
    return { message: NO_ANSWER, providerStatus: null };
  return undefined;
}

/** The tracker's status goes in the data, never as this answer's own status. */
function searchFailed(failure: { message: string; providerStatus: number | null }) {
  return apiError({
    statusCode: 502,
    errorCode: 'TRACKER_SEARCH_FAILED',
    message: failure.message,
    data: { providerStatus: failure.providerStatus },
  });
}

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Search assignable users',
    description:
      "Assignable users for a tracker project, for the create-issue modal and the project's Issue tracker settings: those matching `q`, or the one person `accountId` names, so a saved account id shows with its name. Cached for five minutes. When the tracker refuses the search, answers 502 with `errorCode` `TRACKER_SEARCH_FAILED`, the tracker's own message and its status in `data.providerStatus` (a 403 when the account may not browse users); when Jira does not answer, the same 502 with a null `providerStatus`. A failed search is kept for 30 seconds. Requires `issue:create` on a project bound to the connection (Contributor and above), `project:manage` on any project (Project admin) or `connections:manage` (administrators); any other caller holding `issue:create` gets the 404 of a missing connection.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { in: 'query', name: 'project', required: true, schema: { type: 'string' }, description: 'Tracker project key' },
      {
        in: 'query',
        name: 'q',
        schema: { type: 'string' },
        description: 'Words of a name or an email; trimmed and cut at 200 characters',
      },
      {
        in: 'query',
        name: 'accountId',
        schema: { type: 'string' },
        description: 'Look up this one account instead of searching; `q` is then ignored',
      },
    ],
    'x-required-permission': 'issue:create',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event);
  const db = await requireConnectionAccess(event, id);
  const query = getQuery(event);
  const project = typeof query.project === 'string' ? query.project : '';
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';
  const accountId = typeof query.accountId === 'string' ? query.accountId.trim() : '';
  if (!project) throw apiError({ statusCode: 400, message: 'project is required' });
  if (accountId.length > ACCOUNT_ID_MAX) throw apiError({ statusCode: 400, message: 'accountId is too long' });

  const cacheKey = JSON.stringify([id, project, accountId ? '' : q, accountId]);
  const cached = assignableCache.get(cacheKey);
  if (cached) return { users: cached };
  const failed = assignableFailureCache.get(cacheKey);
  if (failed) throw searchFailed(failed);

  const tracker = await createTracker(db, id);
  if (!tracker) throw apiError({ statusCode: 404, message: CONNECTION_NOT_FOUND });

  let users;
  try {
    users = await tracker.searchAssignable(project, q, accountId ? { accountId } : undefined);
  } catch (err) {
    const failure = searchFailure(err);
    if (!failure) throw err;
    assignableFailureCache.set(cacheKey, failure);
    throw searchFailed(failure);
  }
  assignableCache.set(cacheKey, users);
  return { users };
});
