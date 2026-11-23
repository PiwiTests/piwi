import { requireResolvedProjectAccess, requireRouteId, resolveCaseProjectId } from '../../../utils/project-access';
import { runFlakeLabInCi, ciDispatchError } from '../../../utils/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Run a test’s Flake Lab experiment in CI',
    description:
      "Dispatches the project's default CI action for Flake Lab with the `piwi flake` arguments for this test: `flake <id>` to reproduce it, `flake verify <id>` to verify its fix. It runs on the branch of the test's newest run, with the SCM credential of the action or the project, or its CI server credential, through the same dispatch as a cluster's CI re-run, and the experiment `piwi flake` records is saved on the test as usual. Returns the dispatch, with the provider's run or runs URL. The dispatch is stored, with its run once one reports; the same dispatch sent again within 10 seconds answers 409 with the earlier one in `data.dispatch`.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { kind: { type: 'string', enum: ['reproduce', 'verify'], default: 'reproduce' } },
          },
        },
      },
    },
    'x-required-permission': 'run:control',
  },
});

export default eventHandler(async (event) => {
  const testCaseId = requireRouteId(event, 'id', 'test case ID');
  const { db, user } = await requireResolvedProjectAccess(event, testCaseId, resolveCaseProjectId, 'Test case');
  const body = ((await readBody(event).catch(() => null)) ?? {}) as { kind?: unknown };
  if (body.kind != null && body.kind !== 'reproduce' && body.kind !== 'verify') {
    throw apiError({ statusCode: 400, message: 'kind must be reproduce or verify' });
  }
  const kind = body.kind === 'verify' ? 'verify' : 'reproduce';
  const outcome = await runFlakeLabInCi(db, testCaseId, kind, {
    id: user.id,
    name: user.name || user.username || null,
    apiKeyId: (event.context.apiKeyId as number | undefined) ?? null,
  });
  if (!outcome.ok) throw ciDispatchError(outcome);
  return { ok: true, dispatch: outcome.dispatch };
});
