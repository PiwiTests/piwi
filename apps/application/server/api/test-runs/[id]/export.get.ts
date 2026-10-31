import { collectRunBundle } from '#shared/export/collect';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';
import { exportPiwiVersion, exportSourceUrl, requireExportFormat, sendExport } from '../../../utils/export-request';
import { resolveExportMaxCases } from '../../../utils/export-assets';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Export a whole run as an offline report',
    description:
      'Downloads a test run readable without a network connection: its summary, its tests by outcome, its failures grouped by root cause, its flaky and slowest tests, every test once, and its failing executions in detail with their evidence (the largest groups first, up to `cases` or the configured cap; the rest are listed by name). `html` is one self-contained file with screenshots and video embedded; `pdf` is a formatted document with screenshots embedded, generated directly (no browser print); `zip` adds the raw artifacts (including trace archives) plus a machine-readable `data.json`; `md` and `json` are text only. Evidence beyond the configured size budget is listed in the report as omitted.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'format',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['html', 'zip', 'pdf', 'json', 'md'] },
      },
      {
        name: 'cases',
        in: 'query',
        required: false,
        description: 'How many failing executions to carry in detail, up to the configured cap, or `all` for the cap.',
        schema: { type: 'string' },
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  const format = requireExportFormat(event);

  const cap = resolveExportMaxCases();
  const requested = getQuery(event).cases;
  const maxCases = requested === 'all' ? cap : Math.min(cap, Math.max(1, Number(requested) || cap));

  const bundle = await collectRunBundle(db, id, {
    maxCases,
    sourceUrl: exportSourceUrl(event, `/test-runs/${id}`),
    piwiVersion: exportPiwiVersion(event),
  });
  if (!bundle) {
    throw apiError({ statusCode: 404, message: 'Test run not found' });
  }

  return sendExport(event, bundle, format, id);
});
