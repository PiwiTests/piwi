import { collectClusterBundle } from '#shared/export/collect';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';
import { resolveExportMaxCases } from '../../../utils/export-assets';
import { exportPiwiVersion, exportSourceUrl, requireExportFormat, sendExport } from '../../../utils/export-request';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Export a failure cluster as an offline report',
    description:
      'Downloads a failure cluster — its signature, triage state, AI diagnosis and the most recent failing execution of each affected test, with evidence — readable without a network connection. `html` is one self-contained file; `pdf` is a formatted document with screenshots embedded, generated directly (no browser print); `zip` adds the raw artifacts (including trace archives) plus a machine-readable `data.json`; `md` and `json` are text only. Affected tests beyond `PIWI_EXPORT_MAX_CASES` are listed without evidence, and files beyond the size budget are listed as omitted.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'format',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['html', 'zip', 'pdf', 'json', 'md'] },
      },
      { name: 'cases', in: 'query', required: false, schema: { type: 'string' } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');
  const format = requireExportFormat(event);

  const cap = resolveExportMaxCases();
  const requested = getQuery(event).cases;
  const maxCases = requested === 'all' ? cap : Math.min(cap, Math.max(1, Number(requested) || cap));

  const bundle = await collectClusterBundle(db, id, {
    maxCases,
    sourceUrl: exportSourceUrl(event, `/failure-clusters/${id}`),
    piwiVersion: exportPiwiVersion(),
  });
  if (!bundle) {
    throw apiError({ statusCode: 404, message: 'Failure cluster not found' });
  }

  return sendExport(event, bundle, format, id);
});
