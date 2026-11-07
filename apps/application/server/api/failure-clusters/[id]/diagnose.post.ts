import { failureClusters, failureDiagnoses } from '../../../database/schema';
import { queryFlag } from '../../../utils/query-params';
import { eq, and } from 'drizzle-orm';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveClusterProjectId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';
import { resolveAiConfig } from '../../../utils/ai-provider';
import type { AiAttachedImage } from '../../../utils/ai-provider';
import { runClusterDiagnosis, isDiagnosisRunning, isDiagnosisStale } from '../../../utils/ai-diagnosis';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Run AI diagnosis for a cluster',
    description:
      'Triggers an AI-powered diagnosis for the specified failure cluster. The optional `force` flag is a query parameter; additional context, images, base commit, and selected commit SHAs are read from the request body.',
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

  const force = queryFlag(event, 'force');
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

  // Validate executionId if execution scope
  // The execution must belong to the cluster's project: its diagnosis and evidence are that project's.
  if (isExecutionScope && (await resolveTestRunCaseProjectId(db, body!.executionId!, null)) !== projectId) {
    throw apiError({ statusCode: 404, message: 'Test run case not found' });
  }

  // Check if already running
  if (isDiagnosisRunning(id)) {
    throw apiError({ statusCode: 409, message: 'Diagnosis is already running for this cluster' });
  }

  // Return existing completed diagnosis if not forcing
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
        return existing;
      }
    }
  }

  return runClusterDiagnosis(db, cluster, config, {
    additionalContext: body?.additionalContext,
    images: body?.images,
    baseCommit: body?.baseCommit,
    selectedCommitShas: body?.selectedCommitShas,
    testRunsCaseId: isExecutionScope ? body!.executionId : undefined,
  });
});
