import { getDatabase } from '../../database';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { requireRouteId } from '../../utils/project-access';
import { withSecretEnvState } from '../../utils/credentials';
import {
  canManageCredential,
  credentialReferences,
  credentialSummary,
  loadCredentialRecord,
} from '#shared/handlers/credentials';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Get a credential',
    description:
      'Returns a credential the caller may read, never its secret: its fields, its scope, the CI actions that name it (`usedBy`) and when it was last used. Someone who holds `credentials:manage` reads every credential; a Project admin reads those they created that are shared only with projects they manage and read no variable. Any other answers 404.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': ['credentials:manage', 'project:manage'],
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'credential ID');
  const access = await getRequestAccess(event);
  // The virtual administrator of an instance without sign-in is id 0, no user row.
  const viewer = { access, userId: user.id || null };
  const db = await getDatabase();
  const record = await loadCredentialRecord(db, id);
  if (!record || !(can(access, 'credentials:manage') || canManageCredential(viewer, record))) {
    throw apiError({ statusCode: 404, message: 'Credential not found' });
  }
  return {
    credential: withSecretEnvState(credentialSummary(record, (await credentialReferences(db)).get(id) ?? [], viewer)),
  };
});
