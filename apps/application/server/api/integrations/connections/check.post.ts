import { z } from 'zod';
import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { isIntegrationProvider, type IntegrationProviderName } from '#shared/integrations/registry';
import type { ConnectionCheckResult } from '#shared/integrations/types';
import { CONNECTION_CHECKS, ConnectionCheckRefusal } from '../../../utils/integrations/connection-check';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Check a connection before saving it',
    description:
      "Runs the provider's own check, with each step carrying a plain-language `hint` when it fails. Nothing is stored. When `connectionId` names the connection being edited and a credential field is blank, the stored value is used, but only while the site stays the same. For Jira: reads the typed address down to the Jira site URL, checks it is a Jira Cloud site through its public `serverInfo` (and resolves its cloud id), then — when credentials are supplied — signs in, reports whether the token is classic or scoped, and counts the projects the account sees.",
    'x-required-permission': 'connections:manage',
  },
});

const schema = z.object({
  provider: z.string().refine(isIntegrationProvider, 'Unknown provider'),
  baseUrl: z.string().min(1).max(2000).optional(),
  region: z.string().max(50).optional(),
  credentials: z.record(z.string(), z.string()).nullable().optional(),
  connectionId: z.number().int().positive().nullable().optional(),
});

export default eventHandler(async (event): Promise<ConnectionCheckResult> => {
  await requireAuth(event);
  const parsed = schema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }

  const { provider, ...input } = parsed.data;
  try {
    return await CONNECTION_CHECKS[provider as IntegrationProviderName](await getDatabase(), input);
  } catch (err) {
    if (err instanceof ConnectionCheckRefusal) throw apiError({ statusCode: 400, message: err.message });
    throw err;
  }
});
