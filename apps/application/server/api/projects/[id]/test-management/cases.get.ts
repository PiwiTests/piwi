import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { lookupCatalogCases } from '#shared/handlers/test-management-cases';
import { CATALOG_LOOKUP_KEYS_MESSAGE, parseCatalogLookupKeys } from '#shared/integrations/test-management-mapping';
import { zephyrCaseUrl } from '../../../../utils/integrations/test-management/zephyr-scale';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Look test case keys up in the stored catalog',
    description:
      "Looks the keys of `keys` (comma separated, up to 100) up in the project's stored test case catalog, for the hover card on a test case key. Reads the database only and never calls the test management tool. `bound` is false when the project has no binding; `fetchedAt` is null while the catalog was never read, and then no key is reported as unknown. Each requested key answers with its case (`name`, `status`, `url`), or null when the catalog holds no such case. Requires `project:read`.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'keys', in: 'query', required: true, schema: { type: 'string' } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const db = await getDatabase();

  const keys = parseCatalogLookupKeys(getQuery(event).keys);
  if (!keys) throw apiError({ statusCode: 400, message: CATALOG_LOOKUP_KEYS_MESSAGE });

  return await lookupCatalogCases(db, id, keys, (provider) => (provider === 'zephyr-scale' ? zephyrCaseUrl() : null));
});
