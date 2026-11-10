import { eq } from 'drizzle-orm';
import { getDatabase } from '../../../../database';
import { integrationConnections } from '../../../../database/schema';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { readTestManagementBinding } from '../../../../utils/integrations/test-management/binding';
import { readCatalogCases, readCatalogInfo } from '../../../../utils/integrations/test-management/catalog';
import { zephyrCaseUrl } from '../../../../utils/integrations/test-management/zephyr-scale';

/** The most keys one request names: a page of tags, not a whole suite. */
const MAX_KEYS = 100;
const KEY = /^[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9_-]{1,40}$/;

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

  const raw = getQuery(event).keys;
  const keys = [...new Set((typeof raw === 'string' ? raw : '').split(',').map((key) => key.trim()))].filter(Boolean);
  if (keys.length === 0 || keys.length > MAX_KEYS || keys.some((key) => !KEY.test(key))) {
    throw apiError({ statusCode: 400, message: `Name 1 to ${MAX_KEYS} test case keys, separated by commas` });
  }

  const binding = await readTestManagementBinding(db, id);
  if (binding.connectionId === null || binding.providerProjectKey === null) {
    return { bound: false, projectKey: null, fetchedAt: null, cases: {} };
  }

  const [connection] = await db
    .select({ provider: integrationConnections.provider })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, binding.connectionId));
  const info = await readCatalogInfo(db, binding.connectionId, binding.providerProjectKey);
  const found = new Map(
    (await readCatalogCases(db, binding.connectionId, binding.providerProjectKey, keys)).map((c) => [c.key, c]),
  );
  const url = connection?.provider === 'zephyr-scale' ? zephyrCaseUrl() : null;
  return {
    bound: true,
    projectKey: binding.providerProjectKey,
    fetchedAt: info.fetchedAt ? info.fetchedAt.toISOString() : null,
    cases: Object.fromEntries(
      keys.map((key) => {
        const hit = found.get(key);
        return [key, hit ? { name: hit.name, status: hit.status, url } : null];
      }),
    ),
  };
});
