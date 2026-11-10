import { getDatabase } from '../../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../../utils/project-access';
import { readTestManagementBinding } from '../../../../../utils/integrations/test-management/binding';
import { refreshTestManagementCatalog } from '../../../../../utils/integrations/test-management/catalog-refresh';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: "Read the bound project's test case catalog now",
    description:
      "Reads every test case of the project's bound test management project and replaces the stored catalog with them. All pages are read before anything is written, so a failed read keeps the old catalog. Returns the catalog's `size` and `fetchedAt`. 409 when the project has no binding; 429 while the connection is rate limited; 502 when the tool fails or refuses the token (a refused token also marks the connection failed). Never returns the token. Requires `project:manage` (Project admin on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const db = await getDatabase();

  const binding = await readTestManagementBinding(db, id);
  if (!binding || binding.connectionId === null || binding.providerProjectKey === null) {
    throw apiError({ statusCode: 409, message: 'Bind this project to a test management project first' });
  }
  const result = await refreshTestManagementCatalog(db, binding.connectionId, binding.providerProjectKey);
  if (!result.ok) throw apiError({ statusCode: result.status, message: result.error });
  return { size: result.size, fetchedAt: result.fetchedAt.toISOString() };
});
