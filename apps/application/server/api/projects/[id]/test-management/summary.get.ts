import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { testManagementMappingSummary } from '#shared/handlers/test-management-summary';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Summarize how the last complete run maps onto the test management project',
    description:
      "Reads the project's last complete run, its test management binding and the stored catalog (never the tool): `summary.mappedTests`, `summary.testsWithoutKey`, the distinct `summary.keys`, the `summary.unknownKeys` the catalog does not hold (up to 20, each with up to 3 example test titles) and the catalog's size and read time. While the catalog was never read `summary.catalogRead` is false and no key is called unknown. `tagsTruncated` is the run's tests whose tags were cut at 20: its `tests` can overstate, so show it as `at least N` when it is above the number of `examples`. `{ bound: false }` for a project with no binding. Requires `project:manage` (Project admin on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const db = await getDatabase();
  return await testManagementMappingSummary(db, id);
});
