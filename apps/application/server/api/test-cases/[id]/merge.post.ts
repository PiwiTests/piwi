import { requireResolvedProjectAccess, requireRouteId, resolveCaseProjectId } from '../../../utils/project-access';
import { mergeTestCases } from '#shared/handlers/test-case-merge';
import { testCaseCache } from '../../../utils/test-case-cache';
import { rebuildProjectGraph } from '../../../utils/graph-ingest';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Merge another test case into this one',
    description:
      "Moves the history of the source test case (`sourceId`) to this one and deletes the source: its executions, quarantine, failure-cluster routes, locator snapshots and uses, code reach, coverage, bug reports, links and Flake Lab experiments. This test case keeps its title and place; it takes the source's external ID when it has none. Of two rows recording the same fact, this test case's is kept. Refused with 409 when the two test cases ran in the same run: they are then two tests. Cannot be undone.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object', properties: { sourceId: { type: 'integer' } }, required: ['sourceId'] },
        },
      },
    },
    'x-required-permission': 'project:manage',
  },
});

const STATUS_BY_ERROR = { 'not-found': 404, 'same-case': 400, 'other-project': 400, 'ran-together': 409 } as const;

export default eventHandler(async (event) => {
  const targetId = requireRouteId(event, 'id', 'test case ID');
  const { db } = await requireResolvedProjectAccess(event, targetId, resolveCaseProjectId, 'Test case');
  const body = ((await readBody(event).catch(() => null)) ?? {}) as { sourceId?: unknown };
  const sourceId = Number(body.sourceId);
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw apiError({ statusCode: 400, message: 'sourceId must be a test case id' });
  }

  const outcome = await mergeTestCases(db, targetId, sourceId);
  if (!outcome.ok) throw apiError({ statusCode: STATUS_BY_ERROR[outcome.error], message: outcome.message });

  // The matching cache still holds the deleted test case; the feature graph keys tests by id and is rebuilt off the
  // request path.
  testCaseCache.invalidate(outcome.projectId);
  void rebuildProjectGraph(db, outcome.projectId).catch((error) =>
    console.warn('[merge] the feature graph was not rebuilt after merging test cases', error),
  );
  return outcome;
});
