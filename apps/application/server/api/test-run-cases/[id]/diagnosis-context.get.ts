import { testRunsCases } from '../../../database/schema';
import { eq } from 'drizzle-orm';
import { buildDiagnosisContext } from '../../../utils/ai-context';
import { loadDiagnosisSystemPrompt } from '../../../utils/ai-diagnosis';
import { buildPromptPreview } from '#shared/ai-prompt-preview';
import { DIAGNOSIS_JSON_SCHEMA } from '#shared/ai-diagnosis';
import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Get execution-scoped diagnosis context preview',
    description:
      'Returns a preview of the full AI context that would be sent for diagnosing a specific test-run-case. `?format=json` gives a structured response with per-section breakdown; `?format=prompt` gives the exact request payload as plain text — system prompt, user message, image count and response schema — for pasting into another assistant or auditing what is sent.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'prompt'] } },
      {
        name: 'baseCommit',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Base commit SHA to diff the SCM context against.',
      },
      {
        name: 'selectedCommitShas',
        in: 'query',
        required: false,
        schema: { type: 'array', items: { type: 'string' } },
        description: 'Specific commit SHAs to include in the context; repeat the parameter for multiple.',
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');

  const [trc] = await db
    .select({ id: testRunsCases.id, failureClusterId: testRunsCases.failureClusterId })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, id))
    .limit(1);
  if (!trc) throw apiError({ statusCode: 404, message: 'Test run case not found' });

  const query = getQuery(event);
  const baseCommit = query.baseCommit as string | undefined;
  const selectedCommitShasRaw = query.selectedCommitShas;
  const selectedCommitShas = Array.isArray(selectedCommitShasRaw)
    ? selectedCommitShasRaw.map(String)
    : selectedCommitShasRaw
      ? [String(selectedCommitShasRaw)]
      : undefined;
  const format = query.format as string | undefined;

  const ctx = await buildDiagnosisContext(db, {
    kind: 'execution',
    executionId: id,
    clusterId: trc.failureClusterId ?? undefined,
    baseCommit,
    selectedCommitShas,
  });

  if (format === 'prompt') {
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8');
    return buildPromptPreview({
      system: await loadDiagnosisSystemPrompt(db, { projectId }),
      user: ctx.text,
      imageCount: ctx.images?.length ?? 0,
      jsonSchema: DIAGNOSIS_JSON_SCHEMA,
    });
  }

  if (format === 'json') {
    return {
      scope: ctx.scope,
      text: ctx.text,
      sections: ctx.sections,
      coverage: ctx.coverage,
      scmChanges: ctx.scmChanges,
      tokenEstimate: ctx.tokenEstimate,
      textTokenEstimate: ctx.textTokenEstimate,
      imageTokenEstimate: ctx.imageTokenEstimate,
      cluster: ctx.cluster,
    };
  }

  return {
    context: ctx.text,
    sections: ctx.sections,
    coverage: ctx.coverage,
    scmChanges: ctx.scmChanges,
    tokenEstimate: ctx.tokenEstimate,
    cluster: ctx.cluster,
  };
});
