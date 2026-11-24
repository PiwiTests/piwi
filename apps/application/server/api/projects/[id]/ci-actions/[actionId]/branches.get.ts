import { getDatabase } from '../../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../../utils/project-access';
import { ciActionBranches } from '../../../../../utils/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['CI dispatches'],
    summary: 'The branches a CI action may run on',
    description:
      "The branches a dispatch through this action may name as its `ref`, as `{ items: [{ name, source }] }`, at most 50: first the branches the project's runs reported, the most recently run first (`source: 'runs'`), then, for a GitHub, GitLab or Bitbucket action, the live branches of the project's pinned repository read with the action's SCM credential, else the project's (`source: 'repository'`), each name once. An action whose branch is typed or fixed (a CI server action) gets the run branches only, as suggestions. `q` keeps the names that hold it, ignoring case and accents. A repository that cannot be read leaves the run branches. An unknown action answers 404.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'actionId', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
    ],
    responses: {
      200: { description: 'The branches, as `items`' },
      400: { description: 'A `q` longer than 200 characters' },
      404: { description: 'The project has no CI action with this id' },
    },
    'x-required-permission': 'run:control',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  // `run:control` on this project, from `x-required-permission` above.
  const user = await requireProjectAccess(event, projectId);
  const raw = getQuery(event).q;
  if (raw != null && (typeof raw !== 'string' || raw.length > 200)) {
    throw apiError({ statusCode: 400, message: 'q must be text of at most 200 characters' });
  }
  const items = await ciActionBranches(
    await getDatabase(),
    projectId,
    getRouterParam(event, 'actionId') ?? '',
    raw ?? null,
    {
      // The virtual administrator of an instance without sign-in is id 0, no user row.
      userId: user.id || null,
      apiKeyId: (event.context.apiKeyId as number | undefined) ?? null,
    },
  );
  if (!items) throw apiError({ statusCode: 404, message: 'CI action not found' });
  return { items };
});
