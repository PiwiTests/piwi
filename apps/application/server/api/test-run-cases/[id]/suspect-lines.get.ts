import { suspectLinesForExecution } from '../../../utils/suspect-lines';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Get the changed lines a failing execution executed (suspect lines)',
    description:
      'Joins the lines changed between the last green run and this execution’s run (from the project’s source control) with the coverage the execution recorded, and ranks each changed hunk it executed by how many passing executions of the same run executed it too (the Ochiai score of spectrum-based fault localization). `available` is false with a `reason` when there is nothing to join: `not-failing`, `no-coverage` (the execution recorded none), `no-baseline` (no passing run with a commit to compare with), `no-scm` (no repository, no provider for it, or it could not give the patches; never an error) or `no-changes` (the range changes no line). `range` holds the full SHAs compared. `summary` counts the changed files, lines and hunks on the head side, the hunks and lines the execution executed, and the executions with coverage. Each of the `suspects` (at most 50, most suspect first: line granularity, then functions, then files, then score) names a `path`, its `runtime`, the `hunk`’s first and last changed line, the `lines` executed at its `granularity` (`lines`: the executed changed lines; `functions`: the changed lines inside a function that ran; `files`: the whole hunk, when the file was reached or its coverage refers to another version of the file), the `failing` and `passing` counts and the `score` (0 to 1). Answers are kept for five minutes.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Test run case id' },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');
  const answer = await suspectLinesForExecution(db, id);
  if (!answer) throw apiError({ statusCode: 404, message: 'Test run case not found' });
  return answer;
});
