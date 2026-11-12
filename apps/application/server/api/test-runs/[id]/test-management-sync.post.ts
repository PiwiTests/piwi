import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';
import { runActionNow } from '../../../utils/integrations/actions';
import { readTestManagementBinding } from '../../../utils/integrations/test-management/binding';
import { failProviderCall, requireTestManagementClient } from '../../../utils/integrations/test-management/endpoint';
import { INTERACTIVE_MAX_WAIT_MS } from '../../../utils/integrations/test-management/limiter';
import { findFailedSync, requeueFailedSync } from '../../../utils/integrations/test-management/sync-again';
import { ZEPHYR_INTERACTIVE_TIMEOUT_MS } from '../../../utils/integrations/test-management/zephyr-scale';
import {
  syncAgainRefusedMessage,
  syncBindingMismatch,
  syncLookupUnsureMessage,
  type SyncActionPayload,
} from '#shared/integrations/test-management-sync';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: "Send a run's results to the test management tool again",
    description:
      "Queues the run's failed results sync again and makes one attempt at once. A sync that failed as *Outcome unknown* (the upload may have reached the tool) first looks in the tool for the test run it may have made: one found is linked to the run and not made again; none found uploads again; when the tool gives no answer Piwi can trust (too many executions or cycles to read, or a cycle that cannot be read), nothing is sent and the sync stays failed. A sync that failed before sending, or after the test run was made, only repeats the step that failed. Answers `status` (`done`, `failed` or `skipped`) with the sync's `error` or `result` (`runKey`, `runUrl`, `sent`); `failed` with `retrying` stays queued for the outbox. 404 for a missing run, 409 when the run has no failed sync, or when its project's binding no longer takes it: the binding names another connection or another project in the tool, is turned off or is a dry run (the message says which), when the look for the test run found no answer Piwi can trust, or when another request changed the sync first; 429 with `Retry-After` while the connection is rate limited; 502 when the tool fails or refuses the token (a refused token also marks the connection failed). Never returns the token. Requires `run:control` (Maintainer and above on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:control',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');

  const action = await findFailedSync(db, id);
  if (!action) throw apiError({ statusCode: 409, message: 'This run has no failed results sync' });
  const payload = action.payload as SyncActionPayload;
  const refused = syncBindingMismatch(await readTestManagementBinding(db, projectId), {
    connectionId: action.connectionId,
    providerProjectKey: payload.providerProjectKey,
    dryRun: payload.dryRun === true,
  });
  if (refused) throw apiError({ statusCode: 409, message: syncAgainRefusedMessage(refused) });

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
  if (queued.status === 'changed') {
    throw apiError({ statusCode: 409, message: 'This results sync changed; reload and try again' });
  }
  if (queued.status === 'unsure') throw apiError({ statusCode: 409, message: syncLookupUnsureMessage(queued.reason) });

  const outcome = await runActionNow(db, queued.action.id);
  if (!outcome) throw apiError({ statusCode: 409, message: 'This results sync is being sent' });
  if (outcome.status === 'done') return { status: 'done', result: outcome.result ?? null };
  if (outcome.status === 'skipped') return { status: 'skipped', error: outcome.reason };
  return { status: 'failed', error: outcome.error, retrying: outcome.retrying === true };
});
