import { failureClusters, failureDiagnoses } from '../../../../database/schema';
import { queryFlag } from '../../../../utils/query-params';
import { eq, and } from 'drizzle-orm';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveClusterProjectId,
  resolveTestRunCaseProjectId,
} from '../../../../utils/project-access';
import { resolveAiConfig } from '../../../../utils/ai-provider';
import type { AiAttachedImage } from '../../../../utils/ai-provider';
import { streamClusterDiagnosis, isDiagnosisRunning, isDiagnosisStale } from '../../../../utils/ai-diagnosis';
import { diagnosisFrame } from '../../../../utils/diagnosis-stream-frames';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Run AI diagnosis with streaming response',
    description:
      'Triggers an AI-powered diagnosis for the specified failure cluster and returns the result as a Server-Sent Events stream. `event: stage` marks the start of each pipeline stage (`research`, only when a distinct research model is configured, then `diagnosis`); text tokens are pushed as `event: thinking` chunks; the final structured result arrives as `event: result`, and a failure as `event: error`.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      {
        name: 'force',
        in: 'query',
        required: false,
        schema: { type: 'boolean' },
        description: 'Re-run the diagnosis even if one already exists (default false).',
      },
    ],
    'x-required-permission': 'ai:run',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const body = (await readBody(event).catch(() => null)) as {
    additionalContext?: string;
    images?: AiAttachedImage[];
    baseCommit?: string;
    selectedCommitShas?: string[];
    scope?: string;
    executionId?: number;
  } | null;

  const [cluster] = await db.select().from(failureClusters).where(eq(failureClusters.id, id));
  if (!cluster) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });

  const config = await resolveAiConfig(db);
  if (!config)
    throw apiError({ statusCode: 503, errorCode: 'AI_NOT_CONFIGURED', message: 'AI diagnosis is not configured' });

  const isExecutionScope = body?.scope === 'execution' && Boolean(body?.executionId);

  // The execution must belong to the cluster's project: its diagnosis and evidence are that project's.
  if (isExecutionScope && (await resolveTestRunCaseProjectId(db, body!.executionId!, null)) !== projectId) {
    throw apiError({ statusCode: 404, message: 'Test run case not found' });
  }

  if (isDiagnosisRunning(id)) {
    throw apiError({ statusCode: 409, message: 'Diagnosis is already running for this cluster' });
  }

  // Unless `?force` is set, an existing completed diagnosis is returned as a
  // single-event stream.
  const force = queryFlag(event, 'force');
  if (!force) {
    const whereClause = isExecutionScope
      ? and(eq(failureDiagnoses.testRunsCaseId, body!.executionId!), eq(failureDiagnoses.scope, 'execution'))
      : and(eq(failureDiagnoses.clusterId, id), eq(failureDiagnoses.scope, 'cluster'));

    const existingRows = await db.select().from(failureDiagnoses).where(whereClause).limit(1);
    const existing = existingRows[0];
    if (existing) {
      if (existing.status === 'running' && !isDiagnosisStale(existing)) {
        throw apiError({ statusCode: 409, message: 'Diagnosis is already running' });
      }
      if (existing.status === 'completed') {
        // Return existing result as an immediate SSE stream
        setResponseHeaders(event, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(diagnosisFrame.result(existing)));
              controller.close();
            },
          }),
          {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            },
          },
        );
      }
    }
  }

  // SSE headers
  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const encoder = new TextEncoder();
  let clientDisconnected = false;

  event.node.req.on('close', () => {
    clientDisconnected = true;
  });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (frame: string) => {
        if (clientDisconnected) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Stream closed — ignore
        }
      };

      try {
        await streamClusterDiagnosis(db, cluster, config, {
          additionalContext: body?.additionalContext,
          images: body?.images,
          baseCommit: body?.baseCommit,
          selectedCommitShas: body?.selectedCommitShas,
          testRunsCaseId: isExecutionScope ? body!.executionId : undefined,
          onStage: (stage) => send(diagnosisFrame.stage(stage)),
          onChunk: (chunk) => {
            if (chunk.type === 'text') send(diagnosisFrame.thinking(String(chunk.data)));
            else if (chunk.type === 'done') send(diagnosisFrame.result(chunk.data));
            else if (chunk.type === 'error') send(diagnosisFrame.error(String(chunk.data)));
          },
        });
      } catch (err) {
        if (clientDisconnected) return;
        try {
          const msg = err instanceof Error ? err.message : String(err);
          controller.enqueue(encoder.encode(diagnosisFrame.error(msg)));
        } catch {
          // Stream closed
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
    },
  });

  return stream;
});
