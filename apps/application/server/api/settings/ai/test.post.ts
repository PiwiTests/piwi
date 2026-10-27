import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { assistantRole, resolveAiConfig, callAiProvider, storedKeyFor } from '../../../utils/ai-provider';
import { embedTexts } from '../../../utils/ai-embeddings';
import { AI_ROLES } from '../../../utils/ai-settings';
import type { AiModelRole, AiProvider, ResolvedAiRole } from '~~/types/api';

defineRouteMeta({
  openAPI: {
    tags: ['Settings'],
    summary: 'Test AI provider connection',
    description:
      'Sends a connectivity test to the configured AI provider for a given model role (`diagnosis`, `research`, `embedding` or `assistant` — the embedding role is probed via the embeddings endpoint). Accepts optional role, provider, apiKey, model, and baseUrl in the request body; omitted fields fall back to the saved configuration. Requires `settings:manage` (administrators only). Soft-fail: a reachable provider that rejects the probe (bad key, wrong model, network error) returns HTTP 200 with `{ success: false, error }` — the request was processed, only the provider call failed. HTTP error statuses are reserved for request-level problems (unconfigured role → 503).',
    'x-required-permission': 'settings:manage',
    responses: {
      '200': {
        description: 'Probe result. `success` reports the outcome; a failed probe still returns 200.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['success'],
              properties: {
                success: { type: 'boolean' },
                model: { type: 'string', description: 'Present only when success is true.' },
                error: { type: 'string', description: 'Present only when success is false.' },
              },
            },
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);

  const body = (await readBody(event).catch(() => null)) as {
    role?: string;
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    temperature?: number | null;
  } | null;

  const role: AiModelRole = AI_ROLES.includes(body?.role as AiModelRole) ? (body!.role as AiModelRole) : 'diagnosis';

  const db = await getDatabase();
  const resolved = await resolveAiConfig(db);

  let config: ResolvedAiRole | null;

  if (!body?.provider) {
    // An unset assistant role answers with the diagnosis model, so that is the one to probe.
    config = resolved ? (role === 'assistant' ? assistantRole(resolved) : resolved.roles[role]) : null;
  } else {
    // Form values win; a blank key falls back to the saved key for this role
    // (users leave the field empty to keep the stored secret), then to the
    // diagnosis role's key (the common "reuse" source), each only for the
    // provider and base URL it was saved for.
    const apiKey =
      body.apiKey ||
      storedKeyFor(resolved?.roles[role], body.provider, body.baseUrl) ||
      storedKeyFor(resolved?.roles.diagnosis, body.provider, body.baseUrl);
    config = {
      provider: body.provider as AiProvider,
      apiKey,
      model: body.model || '',
      baseUrl: body.baseUrl || null,
      temperature: body.temperature ?? resolved?.roles[role]?.temperature ?? null,
    };
  }

  if (!config)
    throw apiError({ statusCode: 503, errorCode: 'AI_NOT_CONFIGURED', message: `The ${role} role is not configured` });

  try {
    if (role === 'embedding') {
      const vectors = await embedTexts(config, ['connectivity check']);
      if (!vectors[0]?.length) throw new Error('embeddings endpoint returned no vector');
      return { success: true, model: config.model };
    }
    const result = await callAiProvider(config, {
      system: 'You are a connectivity check.',
      user: 'Reply with the single word OK.',
      maxTokens: 8,
    });
    return { success: true, model: result.model };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
});
