import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { accessRefusal, setUserProjectRoles, userProjectRolesSchema } from '#shared/handlers/project-access';
import { requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: "Set a user's project roles",
    description:
      "Replaces the user's own role bindings: `allProjects` (a project role held on every project, current and future, or null) and `projects` (one role per project; a project listed twice keeps its last role). The bindings of the user's groups are untouched. Returns the result in the shape of `GET /api/users/{id}/projects`. 400 for an administrator, who opens every project, or an unknown project; 404 for an unknown user.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'users:manage',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              allProjects: {
                type: 'string',
                nullable: true,
                enum: ['viewer', 'contributor', 'maintainer', 'project_admin', 'uploader'],
              },
              projects: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    projectId: { type: 'integer' },
                    role: {
                      type: 'string',
                      enum: ['viewer', 'contributor', 'maintainer', 'project_admin', 'uploader'],
                    },
                  },
                  required: ['projectId', 'role'],
                },
              },
            },
            required: ['allProjects', 'projects'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const currentUser = await requireAuth(event);

  const id = requireRouteId(event, 'id', 'user ID');

  const parsed = userProjectRolesSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }

  try {
    // With authentication off the caller is a virtual administrator with no users row.
    const roles = await setUserProjectRoles(await getDatabase(), id, parsed.data, currentUser.id || null);
    return { success: true as const, ...roles };
  } catch (err) {
    const refusal = accessRefusal(err);
    if (refusal) throw apiError(refusal);
    throw err;
  }
});
