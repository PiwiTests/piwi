import { getDatabase } from '../../../database';
import { integrationConnections } from '../../../database/schema';
import { eq } from 'drizzle-orm';
import { isProviderOfKind } from '#shared/integrations/registry';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { readProjectIntegration, writeProjectIntegration } from '../../../utils/integrations/binding';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Save the project tracker binding',
    description:
      'Replace the project-integration binding with a normalized settings object. A null connection clears the binding; a connection that is not a tracker answers HTTP 400. Requires `project:manage` (Project admin on the project).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const db = await getDatabase();

  const body = (await readBody(event)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    throw apiError({ statusCode: 400, message: 'Invalid request body' });
  }

  // A bound connection must exist (an unknown id would leave a dangling FK) and be a tracker.
  if (typeof body.connectionId === 'number' && body.connectionId > 0) {
    const [conn] = await db
      .select({ id: integrationConnections.id, provider: integrationConnections.provider })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, body.connectionId));
    if (!conn) throw apiError({ statusCode: 400, message: 'Connection not found' });
    if (!isProviderOfKind(conn.provider, 'tracker')) {
      throw apiError({ statusCode: 400, message: 'A project is bound to a tracker connection only' });
    }
  }

  await writeProjectIntegration(db, id, body);
  return await readProjectIntegration(db, id);
});
