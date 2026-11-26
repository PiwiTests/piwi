import { requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { getDatabase } from '../../database';
import { sanitizeFilename } from '../../utils/sanitize-filename';
import { exportPiwiVersion, exportSourceUrl } from '../../utils/export-request';
import { collectReportBundle } from '#shared/reports/collect';
import { buildReport } from '#shared/reports/build';
import { parseReportRequest, ReportRequestError } from '#shared/reports/request';
import { reportDashboardFor } from '#shared/handlers/dashboards';
import { dashboardActor, dashboardRoute } from '../../utils/dashboards';

defineRouteMeta({
  openAPI: {
    tags: ['Reports'],
    summary: 'Preview or download a quality report',
    description:
      'Renders a built-in dashboard (`overview`, `executive`, `engineering`, `team` with an `owner` test filter, or `gaps-digest`) over a scope as a quality report: the report bundle as JSON, or a download as `html` (one self-contained file), `pdf` (vector charts, no browser), `md` (tables and text sparklines) `csv` (every table and series, formula-guarded) or `xlsx` (an Excel workbook, a sheet per table). The scope takes the same query keys as `GET /api/widgets/[widget]` (`period`, `compare`, `projects`, `environments`, `allEnvironments`, `branches`, `allBranches`, `sel`, `tags`, `browsers`, …) and is intersected with the caller’s project access. `lang` picks English or French; by default the ticket language of a single project’s tracker binding, else the instance locale, else English. Probe runs are never counted.',
    parameters: [
      {
        name: 'dashboard',
        in: 'query',
        required: false,
        schema: {
          type: 'string',
          default: 'executive',
        },
        description:
          'A built-in dashboard (`overview`, `executive`, `engineering`, `team`, `gaps-digest`) or a saved dashboard id the caller may open',
      },
      {
        name: 'format',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['json', 'html', 'pdf', 'md', 'csv', 'xlsx'], default: 'json' },
      },
      { name: 'lang', in: 'query', required: false, schema: { type: 'string', enum: ['en', 'fr'] } },
      {
        name: 'period',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Period in compact form (`last-7d`, `last-month`, `2026-08-01..2026-08-31`, …), as the analytics widgets read it',
      },
      {
        name: 'projects',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Comma-separated project ids',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  let request;
  try {
    request = parseReportRequest(getQuery(event));
  } catch (error) {
    if (error instanceof ReportRequestError) throw apiError({ statusCode: 400, message: error.message });
    throw error;
  }
  const db = await getDatabase();
  const access = await getProjectScope(db, user as any);
  const dashboard = await dashboardRoute(async () =>
    reportDashboardFor(db as any, request.dashboard, await dashboardActor(event, user as any)),
  );
  const bundle = await collectReportBundle(db, {
    dashboard,
    scope: request.scope,
    access,
    language: request.language,
    locale: request.scope.locale,
    timeZone: request.scope.timeZone,
    baseUrl: exportSourceUrl(event, ''),
    piwiVersion: exportPiwiVersion(),
  });
  if (request.format === 'json') return bundle;

  const built = await buildReport(bundle, request.format);
  setResponseHeader(event, 'Content-Type', built.contentType);
  setResponseHeader(event, 'Content-Length', String(built.bytes.length));
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${sanitizeFilename(built.fileName)}"`);
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return Buffer.from(built.bytes);
});
