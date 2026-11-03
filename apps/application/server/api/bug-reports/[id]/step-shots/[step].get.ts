import {
  requireResolvedProjectAccess,
  requireRouteId,
  requireRouteIndex,
  resolveBugReportProjectId,
} from '../../../../utils/project-access';
import { apiError } from '../../../../utils/api-error';
import { bugReportFilePath } from '../../../../utils/bug-report-store';
import { getStorage } from '../../../../storage';
import { getBugReport } from '#shared/handlers/bug-reports';

defineRouteMeta({
  openAPI: {
    tags: ['Bug reports'],
    summary: 'Get the screenshot of a bug report’s step',
    description:
      'The JPEG of the page as the step at `step` (0-based) began, when the report’s `evidence.stepShots` has one. Its entry there gives the box of the step’s element on it and the viewport it shows.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'step', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'bug report ID');
  const step = requireRouteIndex(event, 'step', 'step');
  const { db } = await requireResolvedProjectAccess(event, id, resolveBugReportProjectId, 'Bug report');
  const report = await getBugReport(db, id);
  const shot = report?.evidence.stepShots?.find((s) => s.step === step);
  if (!shot) throw apiError({ statusCode: 404, message: 'Step screenshot not found' });
  const path = bugReportFilePath(id, shot.file);
  const storage = getStorage();
  if (!(await storage.exists(path))) throw apiError({ statusCode: 404, message: 'Step screenshot not found' });
  setResponseHeader(event, 'Content-Type', 'image/jpeg');
  setResponseHeader(event, 'Cache-Control', 'private, max-age=3600');
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  return await storage.readFile(path);
});
