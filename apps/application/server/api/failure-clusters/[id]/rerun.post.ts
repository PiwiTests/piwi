import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';
import { rerunClusterInCi } from '../../../utils/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Re-run a cluster in CI',
    description:
      "Dispatches the project's default CI action for re-runs to re-run exactly the cluster's affected tests, using the project's SCM token, or one request to the project's CI server when the action targets one. An optional `action` (a CI action id or exact name) picks a different action that accepts tests. Returns the provider's runs URL.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: { type: 'object', properties: { action: { type: 'string' } } },
        },
      },
    },
    'x-required-permission': 'run:control',
  },
});

const STATUS_BY_ERROR = { 'not-found': 404, unavailable: 400, 'dispatch-failed': 502 } as const;

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db, user } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  // Availability is re-checked on dispatch so the API is safe on its own — the
  // button's disabled state is a convenience, not the boundary.
  const body = ((await readBody(event).catch(() => null)) ?? {}) as { action?: unknown };
  if (body.action != null && (typeof body.action !== 'string' || body.action.length > 100)) {
    throw apiError({ statusCode: 400, message: 'action must be a CI action id or name' });
  }
  const outcome = await rerunClusterInCi(
    db,
    id,
    { id: user.id, name: user.name || user.username || null },
    { actionId: typeof body.action === 'string' && body.action.trim() ? body.action.trim() : undefined },
  );
  if (!outcome.ok) throw apiError({ statusCode: STATUS_BY_ERROR[outcome.error], message: outcome.message });
  return { ok: true, dispatch: outcome.dispatch };
});
