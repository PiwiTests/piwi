import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';
import { rerunExecutionInCi } from '../../../utils/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: "Re-run an execution's test in CI",
    description:
      "Dispatches a CI workflow/pipeline to re-run this one test, at its line and in its Playwright project, on the branch of its run, using the project's SCM token and the configured CI re-run target. The dispatch is recorded on the execution's failure cluster as its last re-run. Returns the provider's runs URL.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:control',
  },
});

const STATUS_BY_ERROR = { 'not-found': 404, unavailable: 400, 'dispatch-failed': 502 } as const;

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db, user } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  // Availability is re-checked on dispatch so the API is safe on its own.
  const outcome = await rerunExecutionInCi(db, id, { id: user.id, name: user.name || user.username || null });
  if (!outcome.ok) throw apiError({ statusCode: STATUS_BY_ERROR[outcome.error], message: outcome.message });
  return { ok: true, dispatch: outcome.dispatch };
});
