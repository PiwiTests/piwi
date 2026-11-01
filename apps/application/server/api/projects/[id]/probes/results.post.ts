import { z } from 'zod';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { recordProbeResults, type ProbeResultInput } from '#shared/handlers/probes';

defineRouteMeta({
  openAPI: {
    tags: ['Scenario gaps'],
    summary: 'Record the outcomes of a probe run',
    description:
      'Writes the probe ledger from a `piwi probe` run: whether each test noticed its injected fault. A noticed or not-noticed result of a fault that breaks a response also sets the `checks` edge of its (test, route) pair; an inconclusive one, or a delay, never replaces it. Requires a reporter API key.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:submit',
  },
});

/** At most this many probe outcomes per request — a probe run's plan is budget-capped well below this. */
const MAX_RESULTS = 500;

const resultSchema = z.object({
  testCaseId: z.number().int(),
  routeKey: z.string().min(1).max(512),
  fault: z.string().min(1).max(64),
  outcome: z.enum(['noticed', 'not-noticed', 'inconclusive']).optional(),
  level: z.enum(['client', 'server']).optional(),
  applied: z.boolean().optional(),
  handled: z.string().max(32).optional(),
  dependency: z.string().max(256).nullable().optional(),
  testTitle: z.string().max(1024).optional(),
  evidence: z.unknown().optional(),
});

const bodySchema = z.object({
  runId: z.number().int().nullable().optional(),
  results: z.array(resultSchema).max(MAX_RESULTS).default([]),
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);

  const validation = bodySchema.safeParse(await readBody(event));
  if (!validation.success) {
    throw apiError({ statusCode: 400, message: 'Invalid probe results', data: validation.error.issues });
  }
  const { runId = null, results } = validation.data;

  const db = await getDatabase();
  // All-or-nothing: the ledger rows, checks edges and resilience findings from one
  // probe run land together or not at all.
  let recorded = 0;
  await db.transaction(async (tx) => {
    ({ recorded } = await recordProbeResults(tx, projectId, runId ?? null, results as ProbeResultInput[]));
  });
  return { success: true, recorded };
});
