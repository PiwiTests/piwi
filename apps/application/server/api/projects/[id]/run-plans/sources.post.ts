import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { apiError } from '../../../../utils/api-error';
import { getPlanSourceCommits, PassReuseError } from '../../../../utils/pass-reuse';
import { parseFingerprint, parseSelectionKey, requirePassReuseOn } from '../../../../utils/pass-reuse-route';

defineRouteMeta({
  openAPI: {
    tags: ['Selections'],
    summary: 'The source commits a pass reuse plan diffs against',
    description:
      'The first step of `piwi plan`. Resolves the selection (`full` for the whole suite) and finds, for each of its tests, its newest pass that may stand in for it: a run of the last 14 days from a clean checkout of a commit, with the same Playwright version, in which every result of the test passed on its first attempt with complete coverage naming its file versions. Answers the commits of those passes, at most 8, those that cover the most tests first: the client diffs its working tree against each and sends the diffs to `POST /api/projects/{id}/run-plans`. Needs the experimental pass reuse capability. Read-only.',
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
  const body = ((await readBody(event)) ?? {}) as { selection?: unknown; playwrightVersion?: unknown };
  const key = parseSelectionKey(body.selection);

  const db = await getDatabase();
  await requirePassReuseOn(db, projectId);
  try {
    return await getPlanSourceCommits(db, projectId, key, parseFingerprint(body.playwrightVersion));
  } catch (e) {
    if (e instanceof PassReuseError) throw apiError({ statusCode: e.statusCode, message: e.message });
    throw e;
  }
});
