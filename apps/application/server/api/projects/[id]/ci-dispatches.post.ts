import { getDatabase } from '../../../database';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { ciDispatchError, dispatchCi } from '../../../utils/ci-rerun';
import { parseCiDispatchRequest } from '#shared/ci-dispatch-request';

defineRouteMeta({
  openAPI: {
    tags: ['CI dispatches'],
    summary: 'Dispatch CI for a place',
    description:
      "Starts one of the project's CI actions for a place, the one route every page, the API and `rerun_cluster_in_ci` dispatch through. The body is `{ source, action?, kind?, ref?, inputs? }`. `source` names the tests: `{ clusterId }` a failure cluster's affected tests, each at the line and in the Playwright projects of its latest failure, on the cluster's last run; `{ executionId, scope: 'test' }` one execution's test, or `scope: 'cluster'` every affected test of its cluster, on the execution's run; `{ runId, tests: 'failed' }` the tests that failed in a run (their final attempts, at most 100); `{ runId }` the whole suite on that run's branch; `{ testCaseId, flakeLab: 'reproduce' | 'verify' }` the test's Flake Lab experiment (`flake <id>` or `flake verify <id>`) on the run of its newest execution in a team run (never a lab or private run); `{}` the project's whole suite, on its pinned repository; `{ tags, match? }` the project's tests carrying those tags, on its pinned repository, sent as one `--grep` that matches each tag in a test's titles or tags after any character and up to a space or the end (a tag of 60 characters, the most Piwi keeps, as a tag's start), ignoring case: `tags` lists 1 to 10 names, each with or without its `@`, at most 60 characters after it, with no space, double quote or `$`, backtick, `\\`, `%` or `!`, and `match` is `any` (the default: a test carrying one of them runs) or `all`. Each id must belong to the project, and a private run the caller does not own is not found. The kind follows from the source (`tests`, `suite`, `tags` or `flakeLab`); a `kind` that contradicts it answers 400. Without `action`, the action that started the source's run is used, else the one of that run's environment, else the project's default for the kind, else the first that accepts it; `action` (an id or exact name) names another, which must accept the kind and serve the run's repository. `ref` is the branch to run on, an empty one none: git's ref-name rules apply (as `git check-ref-format --branch`), a Jenkins job path refuses one that climbs once decoded, and a target that runs its job's configured branch (a Jenkins job without `{branch}`, a Custom request naming neither `{{ref}}` nor `{{branchJob}}`) takes none. Without it, the source run's branch is used, else the project's default branch (for `{}` and tags), else the target's configured ref; a reported branch git refuses counts as none. `inputs` sets the action's choice inputs, each to one of its options; a fixed input or a name the action does not declare answers 400. A choice left out takes the value the dispatch that started the source's run sent when it used this action, else its default. The dispatch is stored before it is sent, with `origin` `page` from a browser session and `api` from an API key. Answers 201 with the stored dispatch: `id` (the dispatch id the run hands back as `PIWI_ORIGIN_REF`), `actionId`, `actionName`, `kind`, `origin`, `provider`, `preset`, `url` (the provider's run when it answered one, else its runs list), `args`, `ref`, `tests`, `state` (`dispatched` until a run reports), `detail`, `runId`, `run`, `at`, `byName` and `byUserId`. Answers 400 for a bad source, branch or input, tagged tests that name no tag, or a dispatch that cannot be sent (CI actions off, no action accepting the kind, no credential, no test with a file path a re-run can name), 404 for an id outside the project or an unknown action, 409 with the earlier dispatch as `data.dispatch` when the same dispatch (action, kind, arguments, branch and inputs) was stored less than 10 seconds before, and 502 with the provider's text for a dispatch the provider refused, which is stored as `refused`.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['source'],
            properties: {
              source: {
                type: 'object',
                properties: {
                  clusterId: { type: 'integer' },
                  executionId: { type: 'integer' },
                  scope: { type: 'string', enum: ['test', 'cluster'] },
                  runId: { type: 'integer' },
                  tests: { type: 'string', enum: ['failed'] },
                  testCaseId: { type: 'integer' },
                  flakeLab: { type: 'string', enum: ['reproduce', 'verify'] },
                  tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
                  match: { type: 'string', enum: ['any', 'all'] },
                },
              },
              action: { type: 'string', description: 'A CI action id or its exact name' },
              kind: { type: 'string', enum: ['tests', 'suite', 'tags', 'flakeLab'] },
              ref: { type: 'string', description: 'The branch to run on' },
              inputs: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'The stored dispatch' },
      400: { description: 'A bad source, kind, branch or input, or a dispatch that cannot be sent' },
      404: { description: 'An id outside the project, or an unknown CI action' },
      409: { description: 'The same dispatch was stored less than 10 seconds before: `data.dispatch`' },
      502: { description: 'The provider refused the dispatch, with its text' },
    },
    'x-required-permission': 'run:control',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  // `run:control` on this project, from `x-required-permission` above.
  const user = await requireProjectAccess(event, projectId);
  const parsed = parseCiDispatchRequest(await readBody(event).catch(() => null));
  if (!parsed.ok) throw apiError({ statusCode: 400, message: parsed.message });
  const apiKeyId = (event.context.apiKeyId as number | undefined) ?? null;
  const outcome = await dispatchCi(
    await getDatabase(),
    projectId,
    parsed.value,
    { id: user.id, name: user.name || user.username || null, apiKeyId },
    { origin: apiKeyId == null ? 'page' : 'api', viewerId: user.id },
  );
  if (!outcome.ok) throw ciDispatchError(outcome);
  setResponseStatus(event, 201);
  return outcome.dispatch;
});
