import { getDatabase } from '../../../database';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { checkCiServerTarget } from '../../../utils/ci-server-dispatch';
import { ciServerTargetProblem, resolveCiServerTarget } from '#shared/ci-server';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Check a CI server target',
    description:
      "Reads the jobs a CI server target names, without starting them, and says whether each declares the parameters a dispatch sends: Jenkins drops a parameter its job does not declare. The body is `{ ciServer }`, a target as `PATCH /api/projects/:id` takes it in `ciRerun.ciServer`, saved or not; a target that cannot dispatch answers 400. The request carries the credential a dispatch under the same URL would carry (the project's stored token, then the instance's), never one from the body. Returns `{ results }`, one per job (`kind` `rerun` or `flakeLab`): `ok`, the `missing` parameter names and a `message`. A Custom request names no job and cannot be checked. Requires `project:manage` (Project admin on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  // `project:manage` on this project, from `x-required-permission` above.
  await requireProjectAccess(event, id);

  const body = (await readBody(event).catch(() => null)) as { ciServer?: unknown } | null;
  const problem = ciServerTargetProblem(body?.ciServer);
  const target = problem ? null : resolveCiServerTarget(body?.ciServer);
  if (!target) throw apiError({ statusCode: 400, message: problem ?? 'Invalid CI server target' });

  const db = await getDatabase();
  return { results: await checkCiServerTarget(db, id, target) };
});
