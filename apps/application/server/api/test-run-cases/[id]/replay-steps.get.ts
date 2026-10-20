import { executionReplaySummary, getExecutionBugReport } from '#shared/handlers/execution-bug-report';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: "An execution's steps as Piwi Picker replays them",
    description:
      "The steps document (`steps.json`) of this execution's bug report, the one the `.piwibug` download holds, with how many of its steps a person does by hand (`manualSteps`), the calls of the test the steps leave out and why (`notes`, `notReplayed` counting them all), and the step the test failed at (`failedStep`, null when it failed elsewhere). Paste `steps` into Replay's report chooser to play them.",
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
  return executionReplaySummary(built);
});
