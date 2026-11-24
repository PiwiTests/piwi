import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { listCiJobs, resolveCiListingRequest } from '../../../../utils/ci-jobs';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "List the jobs a CI action's target can dispatch",
    description:
      "The jobs the CI action editor offers for a target, read without starting anything. The body is `{ target, name?, actionId?, refresh? }`: `target` as `PATCH /api/projects/:id` takes it in `ciRerun.actions[].target`, its job (`workflow`, `pipeline`, the Jenkins `fields.job`) and arguments input optional; `name` names the action in a refusal, and `actionId`, the id of the action being edited (saved or not), is the subject of the credential log's row. A GitHub target lists the workflow files under `.github/workflows/` at its `ref` that have a `workflow_dispatch` trigger (the first 40 files read), as `{ id: file, label: name, description: file }`, and names the files it could not read; a Bitbucket target the custom pipelines of `bitbucket-pipelines.yml` on the repository's default branch; a Jenkins target the jobs under its base URL, folders read three levels deep and a multibranch pipeline as `path/{branch}`, at most 500. A GitLab target lists none: its pipeline runs the CI file of its ref. A repository's branch is read at the commit it names then, past what the SCM provider keeps by branch name. The files are read with the SCM credential the target names, else the project's; Jenkins with the credential a dispatch would carry, its use logged as `ci-list`. Returns `{ jobs, truncated, message }`: `jobs` null when nothing could be listed, `message` saying why or what was left out. An answer whose reads all succeeded is kept five minutes; `refresh: true` reads again. A target that cannot be read at all (a Custom request, a GitHub or GitLab target with no ref, a base URL that is not http(s)), or a credential the project may not name (as `PATCH /api/projects/:id` refuses it), answers 400. Requires `project:manage` (Project admin on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    responses: {
      200: { description: 'The jobs, or why none were listed' },
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
  return listCiJobs(
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
