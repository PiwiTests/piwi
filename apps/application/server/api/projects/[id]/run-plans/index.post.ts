import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { apiError } from '../../../../utils/api-error';
import { decideRunPlan, PassReuseError, storeRunPlan } from '../../../../utils/pass-reuse';
import {
  parseCommit,
  parseFingerprint,
  parseSelectionKey,
  parseSourceDiffs,
  planSummary,
  requirePassReuseOn,
} from '../../../../utils/pass-reuse-route';

defineRouteMeta({
  openAPI: {
    tags: ['Selections'],
    summary: 'Plan a run that reuses the passes whose code has not changed',
    description:
      'The second step of `piwi plan`. For each test of the selection, decides whether the run executes it or reuses its newest pass (see `POST /api/projects/{id}/run-plans/sources`): reused when the impact of the change from that pass’s commit to the working tree, sent in `diffs` as `piwi run impact` sends one, does not select the test and does not widen to the whole suite, and no file the pass’s coverage names changed. A test runs when it is quarantined, in an open failure cluster, failed or was retried in its last 20 executions of the last 90 days, is tagged `@no-reuse`, belongs to a spec file holding a serial group, has no pass to reuse, has a name a Playwright test list cannot state exactly, or its pass’s commit has no diff. Stores the plan for 24 hours, so every shard of a CI matrix reads the same answer, and returns its id, the counts and how many tests each reason accounts for. Needs the experimental pass reuse capability.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              selection: { type: 'string', description: 'A saved or built-in selection key, or "full"' },
              playwrightVersion: { type: 'string' },
              commit: { type: 'string', description: 'The commit the working tree is at' },
              worktree: {
                type: 'string',
                enum: ['clean', 'dirty'],
                description:
                  'Whether the working tree matched its commit; `piwi run --plan` uses a plan of a clean one only',
              },
              branch: { type: 'string' },
              diffs: {
                type: 'array',
                maxItems: 8,
                description:
                  'One per source commit the client could read: the changed files and lines from it to the working tree',
                items: {
                  type: 'object',
                  properties: {
                    commit: { type: 'string' },
                    changedFiles: { type: 'array', items: { type: 'string' } },
                    changes: { type: 'array', items: { type: 'object' } },
                  },
                  required: ['commit', 'changedFiles'],
                },
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
  const user = await requireProjectAccess(event, projectId);
  const body = ((await readBody(event)) ?? {}) as Record<string, unknown>;
  const key = parseSelectionKey(body.selection);
  const diffs = parseSourceDiffs(body.diffs);

  const db = await getDatabase();
  await requirePassReuseOn(db, projectId);
  try {
    const worktree = body.worktree === 'clean' || body.worktree === 'dirty' ? body.worktree : null;
    const { plan, resolved } = await decideRunPlan(
      db,
      projectId,
      key,
      parseFingerprint(body.playwrightVersion),
      diffs,
      new Date(),
      worktree,
    );
    const durations = new Map(resolved.tests.map((t) => [t.testCaseId, t.avgDurationMs ?? 0]));
    const sum = (ids: number[]) => ids.reduce((total, id) => total + (durations.get(id) ?? 0), 0);
    const userId = (user as { id?: number } | null)?.id;
    const stored = await storeRunPlan(db, projectId, plan, {
      commit: parseCommit(body.commit),
      branch: typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim().slice(0, 255) : null,
      createdBy: typeof userId === 'number' && userId > 0 ? userId : null,
    });
    return {
      id: stored.id,
      expiresAt: stored.expiresAt.toISOString(),
      ...planSummary(plan),
      estimate: { runDurationMs: sum(plan.run), reusedDurationMs: sum(plan.reused.map((r) => r.testCaseId)) },
    };
  } catch (e) {
    if (e instanceof PassReuseError) throw apiError({ statusCode: e.statusCode, message: e.message });
    throw e;
  }
});
