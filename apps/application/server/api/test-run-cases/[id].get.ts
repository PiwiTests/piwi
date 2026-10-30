import { eq } from 'drizzle-orm';
import { getTestRunCase } from '#shared/handlers/test-cases';
import { testRunsCases } from '../../database/schema';
import {
  holdsProjectPermission,
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../utils/project-access';
import { resolveWastedSettings } from '../../utils/wasted-settings';
import { codeownersOwnerResolver } from '../../utils/scm/ownership';
import { resolveAiConfig } from '../../utils/ai-provider';
import { ciRerunAvailability, flakeLabCiAvailability } from '../../utils/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Get test run case detail',
    description:
      'Returns detailed information about a test run case (one execution in a test run) including test run data, failure cluster context, reports, and attachments.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  // Only custom patterns force a recompute; with the defaults the stored
  // wasted_time_ms is served as-is.
  const wasted = await resolveWastedSettings(db);

  // The next-step policy needs whether AI diagnosis, a CI re-run and a Flake Lab
  // CI target are configured — signals only the server can resolve. A CI run is
  // offered only to a viewer who may start one.
  const mayDispatch = await holdsProjectPermission(event, projectId, ['run:control']);
  const [row] = await db
    .select({ testRunId: testRunsCases.testRunId, testCaseId: testRunsCases.testCaseId })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, id));
  const [aiConfig, ciRerun, flakeLabCi] = await Promise.all([
    resolveAiConfig(db).catch(() => null),
    row && mayDispatch ? ciRerunAvailability(db, projectId, row.testRunId).catch(() => null) : Promise.resolve(null),
    row?.testCaseId != null && mayDispatch
      ? flakeLabCiAvailability(db, projectId, row.testCaseId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const result = (await getTestRunCase(db, id, wasted.isDefault ? null : wasted.patterns, {
    aiConfigured: aiConfig != null,
    ciRerunAvailable: ciRerun?.available ?? false,
    flakeLabCiAvailable: flakeLabCi?.available ?? false,
    // A test with no `piwi:owner` annotation still has an owner when the
    // repository's CODEOWNERS names one for its spec file.
    resolveOwner: codeownersOwnerResolver(db, projectId),
  })) as any;
  if (!result) {
    throw apiError({
      statusCode: 404,
      message: 'Test run case not found',
    });
  }

  return result;
});
