import { BUG_REPORT_MEDIA_TYPE } from '@piwitests/core/bug-report';
import { executionBugReportArchive, getExecutionBugReport } from '#shared/handlers/execution-bug-report';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';
import { serverAssetReader } from '../../../utils/export-assets';
import { sanitizeFilename } from '../../../utils/sanitize-filename';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'An execution as a Piwi Picker bug report (.piwibug)',
    description:
      "Downloads this execution as a bug report Piwi Picker's Replay plays in a browser: a `.piwibug` zip archive holding `steps.json` (the test's steps up to the failure, the failing assertion with its expected and received values), `evidence.json` (the failed requests, the console's errors and warnings, the step the test failed at and the calls the steps leave out, with why), `bug-report.md`, the failing spec, and the failure screenshot when the run kept one. Calls Replay cannot play are manual steps a person does by hand.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');

  // Authorize by the execution's own project: the id may be opened from a cluster page in another project.
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  const built = await getExecutionBugReport(db, id);
  if (!built) throw apiError({ statusCode: 404, message: 'Test run case not found' });
  const bytes = await executionBugReportArchive(built, serverAssetReader);

  setResponseHeader(event, 'Content-Type', BUG_REPORT_MEDIA_TYPE);
  setResponseHeader(event, 'Content-Length', bytes.length);
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${sanitizeFilename(built.fileName)}"`);
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return Buffer.from(bytes);
});
