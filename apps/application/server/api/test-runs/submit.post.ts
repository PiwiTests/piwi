import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { persistRunCases } from '../../utils/persist-run-cases';
import { mapWireCaseToRunCase } from '../../utils/map-wire-case';
import { checkSubmitBody } from '../../utils/batch-payload';
import { runEventBus } from '../../utils/run-events';
import { deliverOnce, readDeliveryKey } from '../../utils/run-deliveries';
import { createBatchRun, renewHeldRunToken } from '../../utils/batch-run';
import {
  addBatchShard,
  batchShardRun,
  batchShardTally,
  finalizeShardedRun,
  publishShardProgress,
} from '../../utils/sharded-runs';
import { runFinalizeSideEffects } from '../../utils/run-finalize-side-effects';
import { getProjectScope } from '../../utils/project-access';
import { resolveIngestProject } from '../../utils/ingest-project';
import { applyReporterKeep } from '#shared/handlers/run-keep';
import { sanitizeResourceReport } from '#shared/resource-report';
import { saveResourceReportPart } from '#shared/handlers/resource-reports';
import { saveEnvironmentSnapshots } from '#shared/handlers/environment-snapshots';
import type { TestRunSubmitPayload } from '#shared/types';
import { publicRunUrl } from '#shared/run-url';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Submit test results as JSON',
    description:
      'Submit Playwright test run results as a JSON payload. Creates or updates a project, test run, and test cases. The answer names the run’s page (`runUrl`): under `PIWI_SITE_URL` when it is set, else as a path under the address the client reached. Supports sharded runs via shardIndex / shardTotal. A body whose run or test case fields have the wrong type answers 400 naming the first such field.',
    'x-required-permission': 'run:submit',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              projectName: { type: 'string' },
              status: { type: 'string', enum: ['passed', 'failed', 'timedout', 'interrupted'] },
              startTime: { type: 'string', format: 'date-time' },
              shardIndex: { type: 'integer' },
              shardTotal: { type: 'integer' },
              deliveryKey: {
                type: 'string',
                description:
                  'An id the client generates once for these results and sends with every attempt to deliver them (16 to 128 letters, digits, `-` or `_`). A delivery repeating a key the project already took stores nothing and answers with the run it went to, with `duplicate: true`; while that run waits `finalizing` for its files (its results went to `/api/test-runs/upload/results`), the answer carries a new `streamToken` for them, which takes the place of the one held before, as a repeat to that route does.',
              },
              runErrors: {
                type: 'array',
                description:
                  'The errors Playwright reported outside any test (a global setup that threw, a spec that did not load, a worker fixture whose teardown threw), each `{ message, stack?, location? }`: the first 20 are kept, each message and stack cut to 4,000 characters, with what may be a secret hidden.',
                items: { type: 'object' },
              },
              replacesRun: {
                type: 'object',
                description:
                  'The run the reporter streamed before it fell back to this delivery, `{ runId, streamToken }` with that run’s stream token. A run that is not sharded is cancelled while it has not settled, a `finalizing` run too, when the token is its own; otherwise the field is ignored, as it is for a shard.',
                properties: { runId: { type: 'integer' }, streamToken: { type: 'string' } },
              },
            },
            required: ['projectName', 'status', 'startTime'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  // `run:submit` on at least one project, from the route meta; the project itself is checked below.
  const user = await requireAuth(event);

  const body = await readBody<TestRunSubmitPayload>(event);
  checkSubmitBody(body);

  const incomingResources = sanitizeResourceReport(body.resourceReport);

  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any, 'run:submit');

  const project = await resolveIngestProject(db, scope, body.projectName, body.projectDescription);

  // A repeated delivery (the reporter gave up waiting and sent the run again)
  // answers with the run its first delivery stored.
  const delivered = await deliverOnce(db, project.id, readDeliveryKey(body.deliveryKey), async () => {
    const shardTotal = body.shardTotal;
    const instanceId = body.instanceId || null;
    const isSharded = !!(shardTotal && shardTotal > 1);

    const testCases = Array.isArray(body.testCases) ? body.testCases : [];

    if (isSharded && instanceId) {
      // A shard of a batch run: its executions join the run its instance's shards
      // share, and the last shard to arrive settles it.
      const run = await batchShardRun(db, project.id, instanceId, body);
      if (incomingResources) await saveResourceReportPart(db, run.id, incomingResources);
      await saveEnvironmentSnapshots(db, run.id, body.environments);
      await applyReporterKeep(db, run.id, body.keep);
      if (testCases.length > 0) await persistRunCases(db, project.id, run.id, testCases.map(mapWireCaseToRunCase));
      await addBatchShard(db, run.id, batchShardTally(body, testCases));
      if (!(await finalizeShardedRun(db, run.id, 'run-submitted'))) await publishShardProgress(db, run.id);
      return { success: true, runId: run.id, runUrl: publicRunUrl(run.id), projectId: project.id };
    }

    // A run of its own: not sharded, or sharded with no instance id to join its shards by
    const testRun = await createBatchRun(db, project.id, body);

    runEventBus.publishGlobal({ type: 'run-submitted', runId: testRun.id, projectId: project.id, status: body.status });

    await runFinalizeSideEffects(db, testRun.id, {
      projectId: project.id,
      metadata: testRun.metadata,
      isFullRun: testRun.isFullRun,
      status: testRun.status,
    });

    return {
      success: true,
      runId: testRun.id,
      runUrl: publicRunUrl(testRun.id),
      projectId: project.id,
    };
  });
  if (!('duplicate' in delivered)) return delivered;

  // A repeat of a run `/upload/results` holds `finalizing` until its files are in answers, as a repeat there does,
  // with a new token for them, which takes the place of the one it held.
  const streamToken = await renewHeldRunToken(db, delivered.runId);
  return streamToken ? { ...delivered, streamToken } : delivered;
});
