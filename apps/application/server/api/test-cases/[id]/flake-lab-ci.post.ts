import { requireResolvedProjectAccess, requireRouteId, resolveCaseProjectId } from '../../../utils/project-access';
import { runFlakeLabInCi } from '../../../utils/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Run a test’s Flake Lab experiment in CI',
    description:
      "Dispatches the project's Flake Lab CI target (`ciRerun.flakeLab`, or the Flake Lab request of `ciRerun.ciServer` when `ciRerun.via` is `ci-server`) with the `piwi flake` arguments for this test: `flake <id>` to reproduce it, `flake verify <id>` to verify its fix. It runs on the branch of the test's newest run, with the project's SCM token or its CI server credential, through the same dispatch as a cluster's CI re-run, and the experiment `piwi flake` records is saved on the test as usual. Returns the dispatch and the provider's runs URL.",
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

const STATUS_BY_ERROR = { 'not-found': 404, unavailable: 400, 'dispatch-failed': 502 } as const;

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
  });
  if (!outcome.ok) throw apiError({ statusCode: STATUS_BY_ERROR[outcome.error], message: outcome.message });
  return { ok: true, dispatch: outcome.dispatch };
});
