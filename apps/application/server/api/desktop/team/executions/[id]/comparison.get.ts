import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../../../utils/project-access';
import { compareExecutionWithTeam } from '../../../../../utils/desktop-team-comparison';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Compare with team instance: a local execution (desktop app)',
    description:
      'Desktop build only — 404 on the server build. How the test of this execution does in the CI of the team project its folder is also linked to, asked of the connected team instance with the app’s key: `{ status: "ok", instance, teamProjectId, comparison, rows, conclusion, environmentDiff }`, the team history grouped by environment, the conclusion of a failing execution, and what differs from the closest CI pass; or `{ status: "unavailable", problem, message }` (`not-connected`, `no-team-project`, `no-folder`, `reconnect`, `refused`, `not-supported`, `unreachable`, `unreadable`). The pages the comparison names are paths of `instance`. Answers are kept two minutes.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  const id = requireRouteId(event, 'id', 'execution ID');
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Execution');
  const answer = await compareExecutionWithTeam(db, projectId, id);
  if (!answer) throw apiError({ statusCode: 404, message: 'Execution not found' });
  setResponseHeader(event, 'cache-control', 'no-store');
  return answer;
});
