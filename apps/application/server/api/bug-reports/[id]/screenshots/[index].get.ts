import {
  requireResolvedProjectAccess,
  requireRouteId,
  requireRouteIndex,
  resolveBugReportProjectId,
} from '../../../../utils/project-access';
import { apiError } from '../../../../utils/api-error';
import { getStorage } from '../../../../storage';
import { bugReportStorageDir, getBugReport } from '#shared/handlers/bug-reports';

defineRouteMeta({
  openAPI: {
    tags: ['Bug reports'],
    summary: 'Get a bug report’s screenshot',
    description: 'The PNG at `index` (0-based) in the report’s `evidence.screenshots`.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'index', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'bug report ID');
  const index = requireRouteIndex(event, 'index', 'screenshot index');
  const { db } = await requireResolvedProjectAccess(event, id, resolveBugReportProjectId, 'Bug report');
  const report = await getBugReport(db, id);
  const shot = report?.evidence.screenshots[index];
  if (!shot) throw apiError({ statusCode: 404, message: 'Screenshot not found' });
  const path = `${bugReportStorageDir(id)}/${shot.file.replace(/^screenshots\//, '')}`;
  const storage = getStorage();
  if (!(await storage.exists(path))) throw apiError({ statusCode: 404, message: 'Screenshot not found' });
  setResponseHeader(event, 'Content-Type', 'image/png');
  setResponseHeader(event, 'Cache-Control', 'private, max-age=3600');
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  return await storage.readFile(path);
});
