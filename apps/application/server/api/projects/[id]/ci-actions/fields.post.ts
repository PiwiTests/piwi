import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { listCiJobFields, resolveCiListingRequest } from '../../../../utils/ci-jobs';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "List the fields a CI action's job declares",
    description:
      "The fields the CI action editor offers for a target's job, read without starting anything. The body is `{ target, name?, actionId?, refresh? }`, as `POST /api/projects/:id/ci-actions/jobs` takes it, with the job named; a target whose job is not picked answers `{ fields: null, message }`. A GitHub target reads its workflow file at its `ref` and answers the inputs of its `workflow_dispatch` trigger; a GitLab target the variables `.gitlab-ci.yml` sets at its `ref`, at the top level and in each job (GitLab takes any variable, so these are suggestions; included files are not read); a Bitbucket target the variables its custom pipeline declares in `bitbucket-pipelines.yml` on the default branch; a Jenkins target the parameters its job declares, a multibranch job read on its default branch. Each field is `{ name, type, required, default?, description?, options? }`: `type` is `string`, `text`, `number`, `boolean`, `choice`, `environment` or `secret`, `required` is a GitHub input's own (GitHub refuses a dispatch that leaves out a required input with no default), `options` are a choice's (`true` and `false` for a boolean), and a secret's default is never returned. Returns `{ fields, message }`: `fields` null when the job could not be read, `message` saying why or what was left out. The reads and the five-minute keeping are those of the job listing. A target that cannot be read at all (a Custom request, a GitHub or GitLab target with no ref, a base URL that is not http(s)), or a credential the project may not name, answers 400. Requires `project:manage` (Project admin on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    responses: {
      200: { description: 'The fields, or why none were read' },
      400: { description: 'The target cannot be read at all, or names a credential the project may not name' },
    },
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  // `project:manage` on this project, from `x-required-permission` above.
  const user = await requireProjectAccess(event, id);
  const db = await getDatabase();
  const request = await resolveCiListingRequest(db, id, await readBody(event).catch(() => null));
  if ('error' in request) throw apiError({ statusCode: 400, message: request.error });
  return listCiJobFields(
    db,
    id,
    request.target,
    // The virtual administrator of an instance without sign-in is id 0, no user row.
    {
      actor: { userId: user.id || null, apiKeyId: (event.context.apiKeyId as number | undefined) ?? null },
      ...(request.actionId ? { actionId: request.actionId } : {}),
    },
    { refresh: request.refresh },
  );
});
