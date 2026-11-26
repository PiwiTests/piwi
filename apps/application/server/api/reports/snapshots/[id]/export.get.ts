import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { getProjectScope, requireRouteId } from '../../../../utils/project-access';
import { sanitizeFilename } from '../../../../utils/sanitize-filename';
import { reportRoute } from '../../../../utils/reports/context';
import { getReportSnapshot } from '#shared/handlers/reports';
import { buildReport } from '#shared/reports/build';
import { isReportFormat } from '#shared/reports/types';

defineRouteMeta({
  openAPI: {
    tags: ['Reports'],
    summary: 'Download a report snapshot',
    description:
      'The stored quality report as a download, rendered from its frozen bundle: `html`, `pdf`, `md`, `csv`, `xlsx` or `json`. The numbers are the ones generated, whatever retention did since.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'format',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['json', 'html', 'pdf', 'md', 'csv', 'xlsx'], default: 'pdf' },
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'snapshot ID');
  const format = String(getQuery(event).format ?? 'pdf').toLowerCase();
  if (!isReportFormat(format)) throw apiError({ statusCode: 400, message: `Unsupported format '${format}'` });
  const db = await getDatabase();
  const snapshot = await reportRoute(async () =>
    getReportSnapshot(db as any, id, await getProjectScope(db, user as any)),
  );
  const built = await buildReport(snapshot.bundle, format);
  setResponseHeader(event, 'Content-Type', built.contentType);
  setResponseHeader(event, 'Content-Length', String(built.bytes.length));
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${sanitizeFilename(built.fileName)}"`);
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return Buffer.from(built.bytes);
});
