import { failureClusters } from '../../database/schema';
import { inArray } from 'drizzle-orm';
import { requireAuth } from '../../utils/auth';
import { getDatabase } from '../../database';
import { getProjectScope, scopeAllows } from '../../utils/project-access';
import { bulkTriageClusters, type BulkTriage } from '#shared/handlers/failure-clusters';
import { CLUSTER_STATUSES, isClusterStatus, parseBulkIds, isSnoozeOption } from '#shared/inbox-queues';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Bulk-triage failure clusters',
    description:
      "Apply one triage action — set status (resolve / ignore / reopen), assign, or snooze — to many clusters at once. Clusters outside the caller's project scope are skipped; the response reports how many were requested and updated.",
    'x-required-permission': 'triage:write',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();

  const body = await readBody(event);
  const ids = parseBulkIds(body?.ids);
  if (!ids) {
    throw apiError({ statusCode: 400, message: 'ids must be a non-empty array of positive integers (max 200)' });
  }

  const action = body?.action;
  let patch: BulkTriage;
  if (action === 'status') {
    if (!isClusterStatus(body?.status)) {
      throw apiError({ statusCode: 400, message: `Invalid status. Must be one of: ${CLUSTER_STATUSES.join(', ')}` });
    }
    patch = { action: 'status', status: body.status };
  } else if (action === 'assign') {
    if (body?.assignee != null && typeof body.assignee !== 'string') {
      throw apiError({ statusCode: 400, message: 'assignee must be a string or null' });
    }
    patch = { action: 'assign', assignee: body?.assignee ?? null };
  } else if (action === 'snooze') {
    const snooze = body?.snooze ?? null;
    if (snooze !== null && !isSnoozeOption(snooze)) {
      throw apiError({ statusCode: 400, message: 'snooze must be one of: 1-day, 1-week, until-recurs, or null' });
    }
    patch = { action: 'snooze', snooze };
  } else {
    throw apiError({ statusCode: 400, message: 'action must be one of: status, assign, snooze' });
  }

  // Narrow to the clusters this user may write before applying anything.
  const scope = await getProjectScope(db, user as any, 'triage:write');
  const rows = await db
    .select({ id: failureClusters.id, projectId: failureClusters.projectId })
    .from(failureClusters)
    .where(inArray(failureClusters.id, ids));
  const allowed = rows.filter((r) => scopeAllows(scope, r.projectId)).map((r) => r.id);

  const result = await bulkTriageClusters(db, allowed, patch);
  if (!result) throw apiError({ statusCode: 400, message: 'Invalid bulk triage request' });
  return { requested: ids.length, updated: result.updated };
});
