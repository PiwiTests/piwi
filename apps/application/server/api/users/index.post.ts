import { randomBytes } from 'node:crypto';
import { getDatabase } from '../../database';
import { accessRefusal, createUserAccount, createUserSchema } from '#shared/handlers/project-access';
import { requestedInstanceRole } from '#shared/project-access';
import { hashPassword, requireAuth } from '../../utils/auth';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Create a user',
    description:
      "Creates a user with a username, an optional password (without one, the user sets their own from an invite email), an optional name and email, an instance role and optional groups. `role` is `administrator` or `member`; a new member holds no project role until one is granted (`PUT /api/users/{id}/projects`, the permission grid, or a group in `groupIds`). Deprecated: `role: 'reporter'` and `role: 'user'`, the roles of earlier versions, are still accepted for this release and stored as `member`, with no project role. 409 when the username or the email is taken (the email ignoring case), 400 for an unknown group.",
    'x-required-permission': 'users:manage',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              username: { type: 'string', description: '3 to 200 characters' },
              password: { type: 'string', description: 'At least 8 characters' },
              name: { type: 'string' },
              email: { type: 'string', format: 'email' },
              role: { type: 'string', enum: ['administrator', 'member', 'reporter', 'user'] },
              groupIds: { type: 'array', items: { type: 'integer' } },
            },
            required: ['username', 'role'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const currentUser = await requireAuth(event);

  const validation = createUserSchema.safeParse(await readBody(event));
  if (!validation.success) {
    throw apiError({
      statusCode: 400,
      message: 'Invalid request body',
      data: validation.error.issues,
    });
  }
  const { username, password, role, name, email, groupIds } = validation.data;

  try {
    // Without a password, a random one: the user sets their own from the invite email.
    const hashedPassword = await hashPassword(event, password ?? randomBytes(32).toString('hex'));
    const user = await createUserAccount(
      await getDatabase(),
      { username, password: hashedPassword, role: requestedInstanceRole(role), name, email, groupIds },
      // With authentication off the caller is a virtual administrator with no users row.
      currentUser.id || null,
    );
    return { success: true as const, user };
  } catch (err) {
    const refusal = accessRefusal(err);
    if (refusal) throw apiError(refusal);
    throw err;
  }
});
