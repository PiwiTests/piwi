import { getExecutionCoverage } from '../../../utils/coverage';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Get an execution’s coverage',
    description:
      'The coverage the execution recorded, as the reporter sent it: `{ v: 1, files }`, one entry per repository-relative file and runtime (`browser` or `server`) with the `functions` (start and end line of each function that ran) and the executed `lines` it recorded, and the git `blob` of the file version those lines refer to. Ranges are 1-based and inclusive. An execution without coverage has no files. `incomplete` is set when the capture was incomplete, or when part of it is no longer stored.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');
  const coverage = await getExecutionCoverage(db, id);
  if (!coverage) throw apiError({ statusCode: 404, message: 'Test run case not found' });
  return coverage;
});
