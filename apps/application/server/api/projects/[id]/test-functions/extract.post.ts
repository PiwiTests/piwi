import { z } from 'zod';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { resolveAiConfig } from '../../../../utils/ai-provider';
import { extractTestFunctionFromCode } from '../../../../utils/ai-function-extract';
import { requestCredentialActor } from '../../../../utils/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Test Functions'],
    summary: 'Propose a catalog entry from pasted function source (AI)',
    description:
      'Analyzes pasted Playwright page-object-method/helper source with the configured AI provider and returns a proposed test-function catalog entry — a draft only, not saved. Requires `ai:run` (Maintainer and above on the project), and a configured AI provider (see Settings → AI).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'ai:run',
  },
});

const extractSchema = z.object({
  code: z.string().min(1, 'Paste some function source code first.'),
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  const user = await requireProjectAccess(event, id);

  const body = await readBody(event);
  const validation = extractSchema.safeParse(body);
  if (!validation.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: validation.error.issues });
  }

  const db = await getDatabase();
  const config = await resolveAiConfig(db, { open: true, actor: requestCredentialActor(event, user) });
  const role = config?.roles.research ?? config?.roles.diagnosis;
  if (!role) {
    throw apiError({
      statusCode: 503,
      errorCode: 'AI_NOT_CONFIGURED',
      message: 'AI is not configured for this instance — set it up in Settings → AI, or fill in the pattern by hand.',
    });
  }

  try {
    const proposal = await extractTestFunctionFromCode(role, validation.data.code);
    return { proposal };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to extract a pattern from that code';
    throw apiError({ statusCode: 422, message });
  }
});
