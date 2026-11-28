import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveCaseProjectId,
} from '../../../../../utils/project-access';
import { compareTestCaseWithTeam } from '../../../../../utils/desktop-team-comparison';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Compare with team instance: a local test (desktop app)',
    description:
      'Desktop build only — 404 on the server build. How this test does in the CI of the team project its folder is also linked to, asked of the connected team instance with the app’s key: `{ status: "ok", instance, teamProjectId, comparison, rows }` with `conclusion` and `environmentDiff` null, the team history grouped by environment; or `{ status: "unavailable", problem, message }`, as for an execution. Answers are kept two minutes.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  const id = requireRouteId(event, 'id', 'test case ID');
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveCaseProjectId, 'Test case');
  const answer = await compareTestCaseWithTeam(db, projectId, id);
  if (!answer) throw apiError({ statusCode: 404, message: 'Test case not found' });
  setResponseHeader(event, 'cache-control', 'no-store');
  return answer;
});
