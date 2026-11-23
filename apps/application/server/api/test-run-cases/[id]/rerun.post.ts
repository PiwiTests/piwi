import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';
import { rerunExecutionInCi, ciDispatchError } from '../../../utils/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: "Re-run an execution's test in CI",
    description:
      "Dispatches a CI workflow/pipeline to re-run this one test, at its line and in its Playwright project, on the branch of its run, using the project's default CI action for re-runs, with the SCM credential of the action or the project, or one request to the project's CI server. The dispatch names the execution's failure cluster, as its last re-run. Returns the dispatch, with the provider's run or runs URL. The dispatch is stored, with its run once one reports; the same dispatch sent again within 10 seconds answers 409 with the earlier one in `data.dispatch`.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:control',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db, user } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  // Availability is re-checked on dispatch so the API is safe on its own.
  const outcome = await rerunExecutionInCi(db, id, {
    id: user.id,
    name: user.name || user.username || null,
    apiKeyId: (event.context.apiKeyId as number | undefined) ?? null,
  });
  if (!outcome.ok) throw ciDispatchError(outcome);
  return { ok: true, dispatch: outcome.dispatch };
});
