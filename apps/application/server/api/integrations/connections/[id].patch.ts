import { z } from 'zod';
import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { connectionEndpoint, getConnectionRow, updateConnection } from '../../../utils/integrations/connections';
import { connectionBaseUrl, credentialFieldError, providerEndpoint } from '#shared/integrations/registry';
import { requireRouteId } from '../../../utils/project-access';
import { connectionCredentialProblem, hasTypedToken } from '../../../utils/integrations/connection-credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Update an integration connection',
    description:
      'Updates a connection. A new `baseUrl` (or `region`, for a provider reached on its own regional hosts) is checked as on create. A token typed in `credentials` rotates the credential the connection names, or saves a new one, and an e-mail alone changes its user; `credentialId` names a saved credential instead, and an empty map keeps the one named. A move to another site or region keeps no credential that is not sent there. A typed token answers HTTP 409 while `PIWI_SECRET_KEY` is unset, since it cannot be encrypted. Environment-managed connections are read-only.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'connections:manage',
  },
});

const schema = z.object({
  name: z.string().min(1).max(200).optional(),
  baseUrl: z.string().max(2000).optional(),
  region: z.string().max(50).optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  credentials: z.record(z.string(), z.string()).nullable().optional(),
  credentialId: z.number().int().positive().nullable().optional(),
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'connection ID');

  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }

  const db = await getDatabase();
  const row = await getConnectionRow(db, id);
  if (!row) throw apiError({ statusCode: 404, message: 'Connection not found' });
  if (row.managedBy === 'env') {
    throw apiError({
      statusCode: 403,
      message: 'This connection is managed through environment variables and cannot be edited here.',
    });
  }

  const fieldError = credentialFieldError(row.provider, parsed.data.credentials);
  if (fieldError) throw apiError({ statusCode: 400, message: fieldError });

  // A typed address moves a `url` provider; a region moves a `region` provider, which keeps its region otherwise.
  const { region, ...input } = parsed.data;
  const regional = providerEndpoint(row.provider)?.kind === 'region';
  if (regional ? region !== undefined : input.baseUrl !== undefined) {
    const endpoint = connectionBaseUrl(row.provider, parsed.data);
    if ('error' in endpoint) throw apiError({ statusCode: 400, message: endpoint.error });
    input.baseUrl = endpoint.baseUrl;
    if (endpoint.region) {
      const config = input.config === undefined ? (row.config as Record<string, unknown> | null) : input.config;
      input.config = { ...config, region: endpoint.region };
    }
  } else if (regional) {
    delete input.baseUrl;
    const stored = (row.config as Record<string, unknown> | null)?.region;
    if (input.config !== undefined && typeof stored === 'string') input.config = { ...input.config, region: stored };
  }

  if (input.credentialId != null && !hasTypedToken(input.credentials)) {
    const config = (input.config === undefined ? row.config : input.config) as Record<string, unknown> | null;
    const problem = await connectionCredentialProblem(
      db,
      row.provider,
      input.credentialId,
      connectionEndpoint(row.provider, input.baseUrl ?? row.baseUrl, config),
    );
    if (problem) throw apiError({ statusCode: 400, message: problem });
  }

  const connection = await updateConnection(db, id, { ...input, createdBy: user.id || null });
  return { connection };
});
