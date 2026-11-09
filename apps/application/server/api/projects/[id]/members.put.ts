import { getDatabase } from '../../../database';
import { getRequestAccess } from '../../../utils/auth';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import {
  accessRefusal,
  getProjectMemberViews,
  projectMembersUpdateSchema,
  replaceProjectMembers,
} from '#shared/handlers/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Update project members',
    description:
      "Replaces the project's direct role bindings (users and groups, one role each) with `entries`; a subject listed twice keeps its last role. Bindings on all projects and the roles users hold through groups are untouched. A Project admin may grant, change and remove the roles their own role on this project lets them grant (403 otherwise); an administrator any. A Project admin names the users `GET /api/users` lists them, and anyone else with their whole `username` (ignoring letter case) in the subject: any other user id is answered like an unknown one. Returns the members in the shape of `GET`. 400 for an unknown user or group, or for an administrator, who opens every project without a binding.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:members',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    subject: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['user', 'group'] },
                        id: { type: 'integer' },
                        username: {
                          type: 'string',
                          description: "A user's whole username, for one the caller's user list leaves out",
                        },
                      },
                      required: ['type', 'id'],
                    },
                    role: {
                      type: 'string',
                      enum: ['viewer', 'contributor', 'maintainer', 'project_admin', 'uploader'],
                    },
                  },
                  required: ['subject', 'role'],
                },
              },
            },
            required: ['entries'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  const currentUser = await requireProjectAccess(event, id);

  const parsed = projectMembersUpdateSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }

  const db = await getDatabase();
  try {
    await replaceProjectMembers(db, id, parsed.data.entries, {
      // With authentication off the caller is a virtual administrator with no users row.
      userId: currentUser.id || null,
      access: await getRequestAccess(event),
    });
    return { success: true as const, members: await getProjectMemberViews(db, id) };
  } catch (err) {
    const refusal = accessRefusal(err);
    if (refusal) throw apiError(refusal);
    throw err;
  }
});
