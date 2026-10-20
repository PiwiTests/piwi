import { getDatabase } from '../../../database';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { addQuarantine } from '#shared/handlers/quarantine';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Quarantine a test',
    description:
      'Marks a test as quarantined. It keeps running and keeps reporting — quarantine only removes it from the CI gate’s verdict, so its passing streak can still accumulate and earn it a release. Quarantining an already-quarantined test is a no-op and preserves the original streak.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'quarantine:write',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              testCaseId: { type: 'integer' },
              reason: { type: 'string' },
              source: { type: 'string', enum: ['manual', 'proposed'] },
            },
            required: ['testCaseId'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  const user = await requireProjectAccess(event, projectId);

  const body = (await readBody(event)) as { testCaseId?: unknown; reason?: unknown; source?: unknown };
  const testCaseId = Number(body?.testCaseId);
  if (!Number.isFinite(testCaseId) || testCaseId <= 0) {
    throw apiError({ statusCode: 400, message: 'testCaseId is required' });
  }

  const db = await getDatabase();
  try {
    const result = await addQuarantine(db, projectId, testCaseId, {
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
      source: typeof body.source === 'string' ? body.source : 'manual',
      createdBy: (user as { id?: number } | null)?.id ?? null,
    });
    return { success: true, ...result };
  } catch (e: any) {
    if (e?.message === 'Test case not found in this project') {
      throw apiError({ statusCode: 404, message: e.message });
    }
    throw e;
  }
});
