import { queryFlag } from '../../../utils/query-params';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';
import type { AiAttachedImage } from '../../../utils/ai-provider';
import { diagnoseExecution, loadExecutionForDiagnosis } from '../../../utils/execution-diagnosis';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Run AI diagnosis for a test run case',
    description:
      'Triggers an AI-powered diagnosis for the specified test run case (execution scope), or returns its completed diagnosis unless `force` is set. Uses its failure cluster for context if available. 400 when the test run case did not fail, 409 while its diagnosis is running, 503 when no AI provider is configured.',
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
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db, user } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  const body = (await readBody(event).catch(() => null)) as {
    additionalContext?: string;
    images?: AiAttachedImage[];
    baseCommit?: string;
    selectedCommitShas?: string[];
  } | null;

  const execution = await loadExecutionForDiagnosis(db, id, user.id);
  if (!execution) throw apiError({ statusCode: 404, message: 'Test run case not found' });
  const outcome = await diagnoseExecution(db, execution, {
    force: queryFlag(event, 'force'),
    additionalContext: body?.additionalContext,
    images: body?.images,
    baseCommit: body?.baseCommit,
    selectedCommitShas: body?.selectedCommitShas,
  });
  if (outcome.ok) return outcome.diagnosis;
  if (outcome.error === 'not-failed') throw apiError({ statusCode: 400, message: 'This test run case did not fail' });
  if (outcome.error === 'not-configured') {
    throw apiError({ statusCode: 503, errorCode: 'AI_NOT_CONFIGURED', message: 'AI diagnosis is not configured' });
  }
  throw apiError({ statusCode: 409, message: 'Diagnosis is already running' });
});
