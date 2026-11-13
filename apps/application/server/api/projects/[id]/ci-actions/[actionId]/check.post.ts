import { getDatabase } from '../../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../../utils/project-access';
import { checkCiAction, getCiActionsSettings } from '../../../../../utils/ci-actions';
import { ciActionsProblem, resolveCiActionsSettings } from '#shared/ci-actions';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Check a CI action',
    description:
      "Says whether a CI action's target takes what a dispatch sends, without starting anything. The body is `{ action }`, the action as `PATCH /api/projects/:id` takes it in `ciRerun.actions`, saved or not; without a body, the saved action with the id in the path is checked. A GitHub action reads its workflow file at the action's ref on the project's repository and must find a `workflow_dispatch` trigger that declares the arguments input, the dispatch id input when set, and every action input. A Jenkins action reads its job and must find the arguments and dispatch id parameters and every action input declared, since Jenkins drops a parameter its job does not declare. The request carries the credential a dispatch would carry (the project's stored SCM or CI server token), never one from the body. GitLab and Bitbucket pipelines and Custom requests declare nothing Piwi can read without starting them. An action that cannot dispatch answers 400, and an unknown saved action 404. Returns `{ ok, missing, message }`: `ok` is true or false, or null when the target cannot be checked, `missing` the names a dispatch sends that the target does not declare. Requires `project:manage` (Project admin on the project).",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'actionId', in: 'path', required: true, schema: { type: 'string' } },
    ],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  // `project:manage` on this project, from `x-required-permission` above.
  await requireProjectAccess(event, id);
  const actionId = getRouterParam(event, 'actionId') ?? '';

  const db = await getDatabase();
  const body = (await readBody(event).catch(() => null)) as { action?: unknown } | null;
  if (body?.action != null) {
    const posted = { actions: [{ ...(body.action as Record<string, unknown>), id: actionId }] };
    const problem = ciActionsProblem(posted);
    const [action] = problem ? [] : resolveCiActionsSettings(posted).actions;
    if (!action) throw apiError({ statusCode: 400, message: problem ?? 'Invalid CI action' });
    return checkCiAction(db, id, action);
  }

  const saved = (await getCiActionsSettings(db, id)).actions.find((a) => a.id === actionId);
  if (!saved) throw apiError({ statusCode: 404, message: 'CI action not found' });
  return checkCiAction(db, id, saved);
});
