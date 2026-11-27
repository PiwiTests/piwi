import { getDatabase } from '../../database';
import { resolveAiConfig } from '../../utils/ai-provider';
import { requireAuth } from '../../utils/auth';

defineRouteMeta({
  openAPI: {
    tags: ['AI'],
    summary: 'Get AI configuration status',
    description:
      'Returns the AI configuration status: whether AI diagnosis is configured, the provider, model, and auto-diagnose setting. Requires signing in.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const db = await getDatabase();
  const config = await resolveAiConfig(db);

  if (!config) {
    return { configured: false };
  }

  return {
    configured: true,
    provider: config.provider,
    model: config.model || null,
    autoDiagnose: config.autoDiagnose,
    source: config.source,
  };
});
