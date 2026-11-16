import { getDatabase } from '../../database';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { requireRouteId } from '../../utils/project-access';
import {
  canManageCredential,
  credentialReferences,
  deleteCredential,
  loadCredentialRecord,
} from '#shared/handlers/credentials';
import { can } from '#shared/permissions';
import { credentialReferenceText } from '#shared/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Delete a credential',
    description:
      'Deletes a credential and its secret. Its log stays, under the name it recorded, until the nightly sweep prunes it. A credential still named by a CI action, by the source control of a project or of the instance, by an AI role or by a Jira or Zephyr Scale connection answers 409 with what names it (`data.usedBy`): pick another credential in each first. A credential the environment sets cannot be deleted (409). Someone who holds `credentials:manage` deletes any credential; a Project admin those they created that are shared only with projects they manage and read no variable. Any other answers 404.',
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
  if (record.managedBy === 'env') {
    throw apiError({
      statusCode: 409,
      message: 'This credential is set by environment variables: unset them instead.',
    });
  }
  const usedBy = (await credentialReferences(db)).get(id) ?? [];
  if (usedBy.length > 0) {
    const names = usedBy.map(credentialReferenceText).join(', ');
    throw apiError({
      statusCode: 409,
      message: `Still named by ${names}: pick another credential in each first.`,
      data: { usedBy },
    });
  }
  await deleteCredential(db, id);
  return { ok: true };
});
