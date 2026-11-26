import { collectExecutionBundle } from '#shared/export/collect';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';
import { exportPiwiVersion, exportSourceUrl, requireExportFormat, sendExport } from '../../../utils/export-request';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Export one execution as an offline report',
    description:
      'Downloads a single test execution with its evidence, readable without a network connection. `html` is one self-contained file with screenshots and video embedded; `pdf` is a formatted document with screenshots embedded, generated directly (no browser print); `zip` adds the raw artifacts (including trace archives) plus a machine-readable `data.json`; `md` and `json` are text only. Evidence beyond the configured size budget is listed in the report as omitted.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'format',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['html', 'zip', 'pdf', 'json', 'md'] },
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');
  const format = requireExportFormat(event);

  const bundle = await collectExecutionBundle(db, id, {
    maxCases: 1,
    sourceUrl: exportSourceUrl(event, `/test-run-cases/${id}`),
    piwiVersion: exportPiwiVersion(),
  });
  if (!bundle) {
    throw apiError({ statusCode: 404, message: 'Test run case not found' });
  }

  return sendExport(event, bundle, format, id);
});
