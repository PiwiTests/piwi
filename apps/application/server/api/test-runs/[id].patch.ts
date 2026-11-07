import { parseTestRunPatch, patchTestRun } from '#shared/handlers/test-runs';
import { can } from '#shared/permissions';
import { getRequestAccess } from '../../utils/auth';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../utils/project-access';
import { testRuns } from '../../database/schema';
import { isPrivateRunOrigin } from '#shared/run-eligibility';
import { eq } from 'drizzle-orm';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Update a test run',
    description:
      "Updates a test run's label, or keeps it forever. `keep: true` exempts the run from retention (the nightly sweep and the manual cleanup never delete it) and records who kept it, with an optional `keepReason`; keeping a kept run only replaces its reason. `keep: false` releases the run back to retention and requires `run:delete` (Project admin on the project). A requested run (origin `request`) is never kept (409). Any other update requires `project:read` on the project.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              label: { type: 'string', nullable: true },
              keep: { type: 'boolean', description: 'true keeps the run forever; false releases it (`run:delete`)' },
              keepReason: {
                type: 'string',
                nullable: true,
                description: 'Why the run is kept (up to 200 characters); only accepted with keep: true',
              },
            },
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db, projectId, user } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');

  const patch = parseTestRunPatch(await readBody(event));
  if (typeof patch === 'string') {
    throw apiError({ statusCode: 400, message: patch });
  }
  if (patch.keep === true) {
    const [run] = await db.select({ origin: testRuns.origin }).from(testRuns).where(eq(testRuns.id, id));
    if (isPrivateRunOrigin(run?.origin)) throw apiError({ statusCode: 409, message: 'A requested run is never kept' });
  }
  if (patch.keep === false && !can(await getRequestAccess(event), 'run:delete', projectId)) {
    throw apiError({ statusCode: 403, message: 'Releasing a kept run takes the Project admin role on this project' });
  }

  try {
    return await patchTestRun(db, id, patch, { userId: user.id || null });
  } catch (err: any) {
    if (err?.message === 'Test run not found') {
      throw apiError({ statusCode: 404, message: 'Test run not found' });
    }
    throw err;
  }
});
