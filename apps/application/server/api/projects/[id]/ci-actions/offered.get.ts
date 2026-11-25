import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { ciOffered } from '../../../../utils/ci-rerun';
import { requestCredentialActor } from '../../../../utils/credentials';
import { parseCiDispatchSource } from '#shared/ci-dispatch-request';

defineRouteMeta({
  openAPI: {
    tags: ['CI dispatches'],
    summary: 'The CI actions a place is offered',
    description:
      "What a place may dispatch to CI, before anything is sent. The query names the place as `POST /api/projects/{id}/ci-dispatches` names its `source`: `clusterId`, `executionId` with `scope` (`test` or `cluster`), `runId` with `tests=failed` (or alone for the whole suite on its branch), `testCaseId` with `flakeLab` (`reproduce` or `verify`), `tags` (one key per tag, or one empty key while none is picked) with `match` (`any` or `all`) for the project's tests carrying them, or none for the project's whole suite. Answers `{ enabled, kind, actions, defaultActionId, lastDispatch }`. `enabled` says whether CI actions are on for the project; `kind` is the kind the place dispatches (`tests`, `suite`, `tags`, `flakeLab`). `actions` lists, in their order, the project's actions that accept that kind, each as `{ id, name, target: { type, label }, environment, branch: { mode, default }, inputs, available, reason, credential, userToken, targetDigest }`: `target.type` is `github`, `gitlab`, `bitbucket` or `ci-server`, and `label` how a list names it (`GitHub · e2e.yml`); `branch.mode` is `list` (a repository host, which runs any branch: `GET /api/projects/{id}/ci-actions/{actionId}/branches` lists them), `typed` (a Jenkins job with `{branch}` in its path, or a Custom request naming `{{ref}}` or `{{branchJob}}`) or `fixed` (the job's configured branch; a dispatch with `ref` is refused), and `branch.default` the branch a dispatch without `ref` runs on (null for `fixed`, or when the CI picks it); `inputs` are the action's inputs, fixed ones with their `value` and choices with their `options` and the `default` a dispatch that sets none sends (the value the source run's own dispatch sent through this action, else the configured default); `available` and `reason` say whether a dispatch through it would be sent, with the same checks the dispatch makes (CI actions on, an action serving the run's repository, an SCM credential or a CI server request its credential allows, a test whose file path a re-run can name). An action on a per-user credential, which runs in the name of whoever starts it, names it as `credential` (`{ id, name }`, else null) with the caller's `userToken` for it (`ready`, `missing` or `invalid`; null for an API key, which never starts it, and without sign-in) and the `targetDigest` a dispatch through it sends back; while the token is not `ready` it is not `available`, and `reason` says to give it. `defaultActionId` is the action a dispatch that names none uses: the one that started the source's run, else the one of its environment, else the project's default for the kind (null when none can be picked). `lastDispatch` is the place's last dispatch the provider took, as `GET /api/ci-dispatches/{id}` answers it: its cluster's last re-run for a cluster or an execution, the test's last Flake Lab dispatch for Flake Lab, null for a run, the project or tags. A bad source answers 400, an id outside the project 404.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'clusterId', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'executionId', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'scope', in: 'query', required: false, schema: { type: 'string', enum: ['test', 'cluster'] } },
      { name: 'runId', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'tests', in: 'query', required: false, schema: { type: 'string', enum: ['failed'] } },
      { name: 'testCaseId', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'flakeLab', in: 'query', required: false, schema: { type: 'string', enum: ['reproduce', 'verify'] } },
      {
        name: 'tags',
        in: 'query',
        required: false,
        schema: { type: 'array', items: { type: 'string' } },
        style: 'form',
        explode: true,
      },
      { name: 'match', in: 'query', required: false, schema: { type: 'string', enum: ['any', 'all'] } },
    ],
    responses: {
      200: { description: 'The actions offered, the default and the last dispatch' },
      400: { description: 'The query names no place' },
      404: { description: 'An id outside the project' },
    },
    'x-required-permission': 'run:control',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  // `run:control` on this project, from `x-required-permission` above.
  const user = await requireProjectAccess(event, projectId);
  const source = parseCiDispatchSource(getQuery(event));
  if (!source.ok) throw apiError({ statusCode: 400, message: source.message });
  const result = await ciOffered(
    await getDatabase(),
    projectId,
    source.value,
    user.id,
    requestCredentialActor(event, user),
  );
  if (!result.ok) throw apiError({ statusCode: result.error === 'not-found' ? 404 : 400, message: result.message });
  return result.offered;
});
