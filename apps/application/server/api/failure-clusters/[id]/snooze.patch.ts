import { patchClusterSnooze } from '#shared/handlers/failure-clusters';
import { isSnoozeOption } from '#shared/inbox-queues';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Snooze or unsnooze a failure cluster',
    description:
      'Hide a cluster from every inbox queue until a deadline passes (1 day / 1 week) or, in "until it recurs" mode, until a new run adds an occurrence. Snooze never changes status. Send `{ "snooze": null }` to unsnooze.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'triage:write',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const body = await readBody<{ snooze?: unknown }>(event);
  const snooze = body?.snooze ?? null;
  if (snooze !== null && !isSnoozeOption(snooze)) {
    throw apiError({ statusCode: 400, message: 'snooze must be one of: 1-day, 1-week, until-recurs, or null' });
  }

  const result = await patchClusterSnooze(db, id, snooze);
  if (!result) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });
  return result;
});
