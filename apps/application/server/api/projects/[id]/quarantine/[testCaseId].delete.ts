import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { releaseQuarantine } from '#shared/handlers/quarantine';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Release a test from quarantine',
    description:
      'Lets a quarantined test block the CI gate again. The quarantine row is kept as history rather than deleted, so how long a test spent quarantined stays answerable. An optional `reason` is read from the request body, like every other mutation.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'testCaseId', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              reason: { type: 'string', description: 'Why the test is being released (capped at 500 chars).' },
            },
          },
        },
      },
    },
    'x-required-permission': 'quarantine:write',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  const testCaseId = requireRouteId(event, 'testCaseId', 'test case ID');
  const user = await requireProjectAccess(event, projectId);

  const body = (await readBody(event).catch(() => null)) as { reason?: unknown } | null;
  const reason = body && typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;

  const db = await getDatabase();
  const result = await releaseQuarantine(db, projectId, testCaseId, reason, { channel: 'ui', userId: user.id });
  if (!result.released) throw apiError({ statusCode: 404, message: 'No active quarantine for this test' });
  return { success: true, ...result };
});
