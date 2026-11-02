import { randomBytes } from 'node:crypto';
import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { checkSubmitBody } from '../../../utils/batch-payload';
import { createBatchRun } from '../../../utils/batch-run';
import { deliverOnce, readDeliveryKey } from '../../../utils/run-deliveries';
import { runEventBus } from '../../../utils/run-events';
import { getProjectScope } from '../../../utils/project-access';
import { resolveIngestProject } from '../../../utils/ingest-project';
import type { TestRunSubmitPayload } from '#shared/types';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Upload the results of a run ahead of its files',
    description:
      'The first request of a run uploaded in parts, so that no request carries more than one test’s files or one report. Takes the body of `/api/test-runs/submit`, creates the run with its executions and holds it `finalizing`. The answer’s `streamToken` authenticates the files of each test, sent to `/api/test-runs/{id}/case-files` while the run is finalizing. An upload to `/api/test-runs/upload` with `runId` (a report, or none) settles the run to the status sent here, with the finish-time side effects; a run no upload settles is settled ten minutes after its last file. A repeated `deliveryKey` answers with the run its first delivery created, with `duplicate: true` and no token. A shard is refused with 400: its run settles with its last shard, so a shard sends its results and its files in one upload.',
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
              deliveryKey: { type: 'string' },
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
  if (body.shardTotal && body.shardTotal > 1) {
    throw apiError({
      statusCode: 400,
      message: 'A shard sends its results and its files in one upload, to /api/test-runs/upload',
    });
  }

  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any, 'run:submit');

  const project = await resolveIngestProject(db, scope, body.projectName, body.projectDescription);

  // A repeated delivery answers with the run its first delivery created, without its token.
  return deliverOnce(db, project.id, readDeliveryKey(body.deliveryKey), async () => {
    const streamToken = randomBytes(32).toString('hex');
    const testRun = await createBatchRun(db, project.id, body, { streamToken });

    runEventBus.publishGlobal({
      type: 'run-finalizing',
      runId: testRun.id,
      projectId: project.id,
      status: body.status,
    });

    return {
      success: true,
      runId: testRun.id,
      projectId: project.id,
      streamToken,
    };
  });
});
