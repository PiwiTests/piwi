import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';
import { runActionNow } from '../../../utils/integrations/actions';
import { readTestManagementBinding } from '../../../utils/integrations/test-management/binding';
import { failProviderCall, requireTestManagementClient } from '../../../utils/integrations/test-management/endpoint';
import { INTERACTIVE_MAX_WAIT_MS } from '../../../utils/integrations/test-management/limiter';
import { findFailedSync, requeueFailedSync } from '../../../utils/integrations/test-management/sync-again';
import { ZEPHYR_INTERACTIVE_TIMEOUT_MS } from '../../../utils/integrations/test-management/zephyr-scale';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: "Send a run's results to the test management tool again",
    description:
      "Queues the run's failed results sync again and makes one attempt at once. A sync that failed as *Outcome unknown* (the upload may have reached the tool) first looks in the tool for the test run it may have made: one found is linked to the run and not made again; none found uploads again. A sync that failed before sending, or after the test run was made, only repeats the step that failed. Answers `status` (`done`, `failed` or `skipped`) with the sync's `error` or `result` (`runKey`, `runUrl`, `sent`); `failed` with `retrying` stays queued for the outbox. 404 for a missing run, 409 when the run has no failed sync or its project's binding no longer names the sync's connection; 429 with `Retry-After` while the connection is rate limited; 502 when the tool fails or refuses the token (a refused token also marks the connection failed). Never returns the token. Requires `run:control` (Maintainer and above on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:control',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');

  const action = await findFailedSync(db, id);
  if (!action) throw apiError({ statusCode: 409, message: 'This run has no failed results sync' });
  const binding = await readTestManagementBinding(db, projectId);
  if (!binding.enabled || binding.connectionId !== action.connectionId) {
    throw apiError({ statusCode: 409, message: 'This project no longer sends results through that connection' });
  }

  const { client } = await requireTestManagementClient(event, db, action.connectionId, {
    timeoutMs: ZEPHYR_INTERACTIVE_TIMEOUT_MS,
    signal: AbortSignal.timeout(ZEPHYR_INTERACTIVE_TIMEOUT_MS),
    maxWaitMs: INTERACTIVE_MAX_WAIT_MS,
    deadlineAt: Date.now() + ZEPHYR_INTERACTIVE_TIMEOUT_MS,
  });
  let queued;
  try {
    queued = await requeueFailedSync(db, client, action);
  } catch (err) {
    return await failProviderCall(event, db, action.connectionId, err);
  }
  if (!queued) throw apiError({ statusCode: 409, message: 'This results sync changed; reload and try again' });

  const outcome = await runActionNow(db, queued.id);
  if (!outcome) throw apiError({ statusCode: 409, message: 'This results sync is being sent' });
  if (outcome.status === 'done') return { status: 'done', result: outcome.result ?? null };
  if (outcome.status === 'skipped') return { status: 'skipped', error: outcome.reason };
  return { status: 'failed', error: outcome.error, retrying: outcome.retrying === true };
});
