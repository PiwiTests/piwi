import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { apiError } from '../../../../utils/api-error';
import { getRunPlan } from '../../../../utils/pass-reuse';
import { planSummary, requirePassReuseOn } from '../../../../utils/pass-reuse-route';

defineRouteMeta({
  openAPI: {
    tags: ['Selections'],
    summary: 'A stored pass reuse plan: the selection to run and the tests to skip',
    description:
      'What `piwi run --plan <id>` reads: the plan’s counts and reasons, the commit it was made at, `args` (the selection’s `playwright test` arguments; none for the whole suite), and `skip`, the Playwright test list lines of the reused tests, each `[project] › file › describe › title`, which the client passes to `--test-list-invert`. A test is skipped only in the Playwright projects its reused pass ran it in, and a test the plan does not name runs. A sharded job adds Playwright’s own `--shard`, so every shard of a matrix filters the same plan. A plan expires 24 hours after it was made. Needs the experimental pass reuse capability. Read-only.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'planId', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  const planId = requireRouteId(event, 'planId', 'plan ID');
  await requireProjectAccess(event, projectId);

  const db = await getDatabase();
  await requirePassReuseOn(db, projectId);
  const stored = await getRunPlan(db, projectId, planId);
  if (!stored) throw apiError({ statusCode: 404, message: `No plan ${planId} in this project, or it has expired` });

  return {
    id: stored.id,
    commit: stored.commit,
    expiresAt: stored.expiresAt.toISOString(),
    ...planSummary(stored.plan),
    args: stored.plan.args,
    skip: stored.plan.reused.flatMap((r) => r.skip),
    reused: stored.plan.reused.map((r) => ({
      testCaseId: r.testCaseId,
      sourceRunId: r.sourceRunId,
      sourceCommit: r.sourceCommit,
      projects: r.projects,
    })),
  };
});
