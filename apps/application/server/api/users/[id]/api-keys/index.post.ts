import { z } from 'zod';
import { getDatabase } from '../../../../database';
import { createUserApiKeyRecord } from '#shared/handlers/users';
import { getRequestAccess, requireSessionAuth, generateApiKey } from '../../../../utils/auth';
import { can } from '#shared/permissions';
import { requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Create an API key for a user',
    description:
      'Creates a new API key for a user. The plaintext key is returned once and cannot be retrieved again. Accepts name and optional expiresAt in the request body; an expiry in the past is refused (400). The key carries its owner’s access: their instance role and project roles. Anyone but an administrator can only create keys for themselves. Takes a signed-in session: a request with an API key is refused (403).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
  },
});

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  expiresAt: z.string().datetime().optional(),
});

export default eventHandler(async (event) => {
  const currentUser = await requireSessionAuth(event);

  const targetId = requireRouteId(event, 'id', 'user ID');

  // Non-administrators can only create keys for themselves
  if (!can(await getRequestAccess(event), 'users:manage') && currentUser.id !== targetId) {
    throw apiError({ statusCode: 403, message: 'Insufficient permissions' });
  }

  const body = await readBody(event);
  const validation = createKeySchema.safeParse(body);
  if (!validation.success) {
    throw apiError({
      statusCode: 400,
      message: 'Invalid request body',
      data: validation.error.issues,
    });
  }

  const { name, expiresAt } = validation.data;
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    throw apiError({ statusCode: 400, message: 'The expiry date is in the past' });
  }
  const { plaintext, hash, prefix } = generateApiKey();

  await createUserApiKeyRecord(await getDatabase(), targetId, {
    name,
    hash,
    prefix,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  });

  return {
    key: plaintext,
    prefix,
    name,
  };
});
