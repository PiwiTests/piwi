import { getDatabase } from '../../database';
import { accessRefusal, updateUserAccount, updateUserSchema } from '#shared/handlers/project-access';
import { getRequestAccess, isAuthEnabled, refuseApiKey, requireAuth, revokeUserSessions } from '../../utils/auth';
import { requireRouteId } from '../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Update a user',
    description:
      "Updates a user's name, email, instance role (`role`: `administrator` or `member`) or groups (`groupIds`, replacing the current ones). Administrators can update any user; anyone else only their own name and email (403 otherwise). Demoting the last administrator is refused (400), and so is an email another account already uses, in any letter case (409). Changing the email clears its verified flag; changing one's own takes a signed-in session, and a request with an API key is refused (403). Changing the instance role signs the user out everywhere; group changes apply on their next request.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string', nullable: true },
              email: { type: 'string', format: 'email', nullable: true },
              role: { type: 'string', enum: ['administrator', 'member'] },
              groupIds: { type: 'array', items: { type: 'integer' } },
            },
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  // Any signed-in user may call it for themselves; the handler decides who may change what.
  const currentUser = await requireAuth(event);

  const id = requireRouteId(event, 'id', 'user ID');

  const parsed = updateUserSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }
  // An account's email receives its password reset links: an API key cannot change its own account's.
  if (parsed.data.email !== undefined && id === currentUser.id) refuseApiKey(event);

  try {
    const { user, instanceRoleChanged } = await updateUserAccount(
      await getDatabase(),
      id,
      parsed.data,
      { userId: currentUser.id, access: await getRequestAccess(event) },
      // Only meaningful when authentication is enabled.
      { guardLastAdministrator: isAuthEnabled(event) },
    );
    // A new instance role takes effect immediately by revoking the user's sessions.
    if (instanceRoleChanged) await revokeUserSessions(id);
    return { success: true as const, user };
  } catch (err) {
    const refusal = accessRefusal(err);
    if (refusal) throw apiError(refusal);
    throw err;
  }
});
