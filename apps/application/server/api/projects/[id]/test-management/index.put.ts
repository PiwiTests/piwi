import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { writeTestManagementBinding } from '../../../../utils/integrations/test-management/binding';
import { getConnectionRow, listTestManagementConnections } from '../../../../utils/integrations/connections';
import { isProviderOfKind } from '#shared/integrations/registry';
import { testManagementBindingProblem } from '#shared/integrations/test-management-binding';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Save the project test management binding',
    description:
      'Replace the test management binding with a normalized settings object. A null connection clears the binding. A connection that is not a test management connection, a provider project key that is not a project key, a run name template without `{runId}` or with an unknown variable, a status name over 255 characters, or `flakyAs: "flaky"` without a flaky status answers HTTP 400. The binding is kept apart from the tracker binding: saving one never changes the other. Requires `project:manage` (Project admin on the project).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const db = await getDatabase();

  const body = (await readBody(event)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw apiError({ statusCode: 400, message: 'Invalid request body' });
  }

  const connectionId = body.connectionId;
  if (connectionId !== null && connectionId !== undefined) {
    if (typeof connectionId !== 'number' || !Number.isInteger(connectionId) || connectionId <= 0) {
      throw apiError({ statusCode: 400, message: 'Invalid connection' });
    }
    const connection = await getConnectionRow(db, connectionId);
    if (!connection) throw apiError({ statusCode: 400, message: 'Connection not found' });
    if (!isProviderOfKind(connection.provider, 'test-management')) {
      throw apiError({ statusCode: 400, message: 'A test management binding uses a test management connection only' });
    }
    const problem = testManagementBindingProblem(body);
    if (problem) throw apiError({ statusCode: 400, message: problem });
  }

  const binding = await writeTestManagementBinding(db, id, body);
  return { binding, connections: await listTestManagementConnections(db) };
});
