import { requireAuth } from '../utils/auth';
import { getProjectScope } from '../utils/project-access';
import { getDatabase } from '../database';
import { parseAnalyticsScope } from '#shared/analytics/scope';
import {
  ROLLUP_EXPORT_COLUMNS,
  ROLLUP_EXPORT_FORMATS,
  rollupCsvHeader,
  rollupCsvRows,
  rollupExportChunks,
  type RollupExportFormat,
} from '#shared/handlers/analytics/rollup-export';

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'Export the daily rollups',
    description: `Streams the daily rollup rows of the caller's projects, for a BI tool (Power BI, Metabase, a spreadsheet): one row per project, UTC day, environment, branch and run kind, with the retained and archived parts summed, so the history retention deleted is included. Takes the scope keys of \`GET /api/widgets/[widget]\` (\`period\`, \`projects\`, \`projectTags\`, \`environments\`, \`allEnvironments\`, \`branches\`, \`allBranches\`, \`fullRunsOnly\`); test filters do not apply, since rollups count runs. Columns: ${ROLLUP_EXPORT_COLUMNS.join(', ')}. For an average, divide \`durationMs\` by \`durationRuns\` (the runs with a duration) and the two \`*TestDurationSumMs\` columns by \`testDurationRuns\` (the runs with measured test durations). \`maxTotalTests\` is the largest suite of one run, never summed. CSV cells that could run as a formula are prefixed with \`'\`.`,
    parameters: [
      {
        name: 'format',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['json', 'csv'], default: 'json' },
        description: '`json` (`{ "items": [...] }`) or `csv` (a download)',
      },
      {
        name: 'period',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Period in compact form (`last-90d`, `this-year`, `2026-01-01..2026-06-30`, `all`); 30 days by default',
      },
      { name: 'projects', in: 'query', required: false, schema: { type: 'string' } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const query = getQuery(event);
  const format = String(query.format ?? 'json').toLowerCase() as RollupExportFormat;
  if (!(ROLLUP_EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw apiError({ statusCode: 400, message: `Unsupported format '${format}'. Use json or csv.` });
  }
  const db = await getDatabase();
  const access = await getProjectScope(db, user as any);
  const chunks = rollupExportChunks(db as any, parseAnalyticsScope(query), access);
  const encoder = new TextEncoder();

  setResponseHeader(event, 'Cache-Control', 'no-store');
  if (format === 'csv') {
    setResponseHeader(event, 'Content-Type', 'text/csv; charset=utf-8');
    setResponseHeader(
      event,
      'Content-Disposition',
      `attachment; filename="piwi-rollups-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
  } else {
    setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8');
  }

  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // A byte-order mark so spreadsheets read the file as UTF-8.
      controller.enqueue(encoder.encode(format === 'csv' ? `﻿${rollupCsvHeader()}` : '{"items":['));
    },
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          if (format === 'json') controller.enqueue(encoder.encode(']}'));
          controller.close();
          return;
        }
        if (format === 'csv') {
          controller.enqueue(encoder.encode(rollupCsvRows(next.value)));
        } else {
          const body = next.value.map((row) => JSON.stringify(row)).join(',');
          controller.enqueue(encoder.encode(`${first ? '' : ','}${body}`));
          first = false;
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return sendStream(event, stream);
});
