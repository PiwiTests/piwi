import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getDatabase } from '../../../database';
import { createSelection, SelectionError } from '#shared/handlers/selections';

defineRouteMeta({
  openAPI: {
    tags: ['Selections'],
    summary: 'Create a test selection',
    description:
      'Saves a named selection. The `definition` is declarative JSON (include/exclude predicate groups, pins, budget, limit); it is validated on write, and an unknown predicate is rejected rather than silently ignored. The key must be a lowercase slug and may not shadow a built-in.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'test-assets:write',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              definition: { type: 'object' },
            },
            required: ['key', 'name', 'definition'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  const user = await requireProjectAccess(event, projectId);

  const body = (await readBody(event)) as {
    key?: unknown;
    name?: unknown;
    description?: unknown;
    definition?: unknown;
  };

  const db = await getDatabase();
  try {
    return await createSelection(db, projectId, {
      key: String(body.key ?? ''),
      name: String(body.name ?? ''),
      description: typeof body.description === 'string' ? body.description : null,
      definition: (body.definition ?? {}) as never,
      createdBy: (user as { id?: number } | null)?.id ?? null,
    });
  } catch (e) {
    if (e instanceof SelectionError) throw apiError({ statusCode: e.statusCode, message: e.message });
    throw e;
  }
});
