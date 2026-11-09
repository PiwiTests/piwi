import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';
import { rerunClusterInCi } from '../../../utils/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Re-run a cluster in CI',
    description:
      "Dispatches a CI workflow/pipeline to re-run exactly the cluster's affected tests, using the project's SCM token and the configured CI re-run target, or, when `ciRerun.via` is `ci-server`, one request to the project's CI server. Returns the provider's runs URL.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:control',
  },
});

const STATUS_BY_ERROR = { 'not-found': 404, unavailable: 400, 'dispatch-failed': 502 } as const;

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db, user } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  // Availability is re-checked on dispatch so the API is safe on its own — the
  // button's disabled state is a convenience, not the boundary.
  const outcome = await rerunClusterInCi(db, id, { id: user.id, name: user.name || user.username || null });
  if (!outcome.ok) throw apiError({ statusCode: STATUS_BY_ERROR[outcome.error], message: outcome.message });
  return { ok: true, dispatch: outcome.dispatch };
});
