import { z } from 'zod';
import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import {
  connectionBaseUrl,
  credentialFieldError,
  isIntegrationProvider,
  type IntegrationProviderName,
} from '#shared/integrations/registry';
import { createConnection } from '../../../utils/integrations/connections';
import {
  connectionCredentialProblem,
  connectionEndpoint,
  hasTypedToken,
  refuseSharedChange,
} from '../../../utils/integrations/connection-credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Create an integration connection',
    description:
      'Creates an integration connection. A provider reached at a typed address takes `baseUrl`; a provider reached on its own regional hosts takes `region`, and the server sets the base URL from it. The token typed in `credentials` is saved as a credential of its own (Settings → Credentials), shared with all projects and sent only to the site or the region of the connection, which names it; `credentialId` names a saved one instead. A token is never returned, and a request carrying one answers HTTP 409 while `PIWI_SECRET_KEY` is unset.',
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
  credentialId: z.number().int().positive().nullable().optional(),
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }

  const provider = parsed.data.provider as IntegrationProviderName;
  const endpoint = connectionBaseUrl(provider, parsed.data);
  if ('error' in endpoint) throw apiError({ statusCode: 400, message: endpoint.error });
  const fieldError = credentialFieldError(provider, parsed.data.credentials);
  if (fieldError) throw apiError({ statusCode: 400, message: fieldError });

  const config = endpoint.region ? { ...parsed.data.config, region: endpoint.region } : (parsed.data.config ?? null);
  const db = await getDatabase();
  if (parsed.data.credentialId != null && !hasTypedToken(parsed.data.credentials)) {
    const problem = await connectionCredentialProblem(
      db,
      provider,
      parsed.data.credentialId,
      connectionEndpoint(provider, endpoint.baseUrl, config),
    );
    if (problem) throw apiError({ statusCode: 400, message: problem });
  }
  const connection = await refuseSharedChange(() =>
    createConnection(db, {
      provider,
      name: parsed.data.name,
      baseUrl: endpoint.baseUrl,
      config,
      credentials: parsed.data.credentials ?? null,
      credentialId: parsed.data.credentialId ?? null,
      createdBy: user.id || null,
    }),
  );
  return { connection };
});
