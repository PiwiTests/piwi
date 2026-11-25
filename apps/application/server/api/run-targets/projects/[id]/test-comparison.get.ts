import { can } from '#shared/permissions';
import { isPassiveCapabilityDeclined } from '#shared/handlers/capabilities';
import { testComparisonQuerySchema } from '#shared/test-comparison';
import { requireRouteId } from '../../../../utils/project-access';
import { requireRunTarget } from '../../../../utils/run-requests';
import { compareTestWithTeam } from '../../../../utils/test-comparison';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: "Compare a test with the project's CI for a connected app",
    description:
      'How a test that ran on the desktop app’s machine does in this project’s CI (Compare with team instance). The test is named as ingestion matches one: `externalId` first, then `filePath`, `suitePath` (the describe titles joined by `\\x1f`) and `title`. Answers `{ testCase, defaultBranch, playwrightProjectMatched, history, fingerprintComparable, cluster, closestPass }`: the test’s latest final attempts in CI runs (`ci`, `ci-rerun`) and, marked `local`, in the teammates’ own runs, of every environment and branch, and on `commit` even when older, narrowed to `playwrightProject` unless the CI never ran the test there; the cluster holding `fingerprint` with what the CI saw of it, unless `fingerprintVersion` is not this instance’s (`fingerprintComparable: false`); and the environment snapshot of the closest CI pass (on `commit`, else ranked by `environment` and `branch`). Pages are named by their path on this instance. `testCase` is null for a test the project does not hold. Authenticated with the key of a connected desktop app that holds `project:read`; refused (403) when the key lacks it (`RUN_TARGET_KEY_CANNOT_COMPARE`), the owner cannot read the project, or the project declines Compare with team instance.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'filePath', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'title', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'suitePath', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'externalId', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'playwrightProject', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'environment', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'branch', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'commit', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'fingerprint', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'fingerprintVersion', in: 'query', required: false, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'project:read',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The comparison' },
      400: { description: 'The query does not name a test, or a value is malformed' },
      403: {
        description:
          'Not a connected app’s key, a key that cannot compare, an owner who cannot read the project, or a project that declines it',
      },
    },
  },
});

export default eventHandler(async (event) => {
  const caller = await requireRunTarget(event, { permission: 'project:read' });
  const id = requireRouteId(event, 'id', 'project ID');
  if (!can(caller.access, 'project:read', id)) {
    throw apiError({ statusCode: 403, message: 'This app’s owner cannot read this project' });
  }
  if (await isPassiveCapabilityDeclined(caller.db, id, 'team-comparison')) {
    throw apiError({ statusCode: 403, message: 'Compare with team instance is off for this project' });
  }
  const parsed = testComparisonQuerySchema.safeParse(getQuery(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid test comparison query', data: parsed.error.issues });
  }
  return compareTestWithTeam(caller.db, id, parsed.data);
});
