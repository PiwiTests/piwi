import { z } from 'zod';
import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { connectionBaseUrl, isIntegrationProvider, type IntegrationProviderName } from '#shared/integrations/registry';
import { createConnection } from '../../../utils/integrations/connections';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Create an integration connection',
    description:
      'Creates an integration connection. A provider reached at a typed address takes `baseUrl`; a provider reached on its own regional hosts takes `region`, and the server sets the base URL from it. Credentials are encrypted at rest and never returned, so a request carrying them answers HTTP 409 while `PIWI_SECRET_KEY` is unset.',
    'x-required-permission': 'connections:manage',
  },
});

const schema = z.object({
  provider: z.string().refine(isIntegrationProvider, 'Unknown provider'),
  name: z.string().min(1).max(200),
  baseUrl: z.string().max(2000).optional(),
  region: z.string().max(50).optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  credentials: z.record(z.string(), z.string()).nullable().optional(),
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }

  const provider = parsed.data.provider as IntegrationProviderName;
  const endpoint = connectionBaseUrl(provider, parsed.data);
  if ('error' in endpoint) throw apiError({ statusCode: 400, message: endpoint.error });

  const db = await getDatabase();
  const { region } = parsed.data;
  const connection = await createConnection(db, {
    provider,
    name: parsed.data.name,
    baseUrl: endpoint.baseUrl,
    config: region ? { ...parsed.data.config, region } : (parsed.data.config ?? null),
    credentials: parsed.data.credentials ?? null,
  });
  return { connection };
});
