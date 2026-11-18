import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { apiError } from '../../../../utils/api-error';
import { getPlanSourceCommits, PassReuseError } from '../../../../utils/pass-reuse';
import { parseSelectionKey, requestFingerprint, requirePassReuseOn } from '../../../../utils/pass-reuse-route';

defineRouteMeta({
  openAPI: {
    tags: ['Selections'],
    summary: 'The source commits a pass reuse plan diffs against',
    description:
      'The first step of `piwi plan`. Resolves the selection (`full` for the whole suite) and finds, for each of its tests, its newest pass that may stand in for it: a run of the last 14 days from a clean checkout of a commit, with the same Playwright version, of the same environment, in which every result of the test passed on its first attempt with complete coverage naming its file versions. `environment` is the label the planned run will report, resolved as a run’s label is but never creating an environment: a source is a run of that environment (of any environment, without a label), and for a deployed environment (its application not built from the run’s checkout) a run against the version of the application it runs now, named by the commit of its latest deploy marker or of what its servers report, else by the application versions they report; when nothing names it, none of its passes is reused. Answers the commits of those passes, at most 8, those that cover the most tests first: the client diffs its working tree against each and sends the diffs to `POST /api/projects/{id}/run-plans`. Needs the experimental pass reuse capability. Read-only.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              selection: { type: 'string', description: 'A saved or built-in selection key, or "full"' },
              playwrightVersion: { type: 'string', description: 'The @playwright/test version of the planned run' },
              environment: {
                type: 'string',
                description: 'The environment label the planned run reports (`environment` option or PIWI_ENVIRONMENT)',
              },
            },
            required: ['selection'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);
  const body = ((await readBody(event)) ?? {}) as {
    selection?: unknown;
    playwrightVersion?: unknown;
    environment?: unknown;
  };
  const key = parseSelectionKey(body.selection);

  const db = await getDatabase();
  await requirePassReuseOn(db, projectId);
  try {
    return await getPlanSourceCommits(db, projectId, key, await requestFingerprint(db, projectId, body));
  } catch (e) {
    if (e instanceof PassReuseError) throw apiError({ statusCode: e.statusCode, message: e.message });
    throw e;
  }
});
