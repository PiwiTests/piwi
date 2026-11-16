import { getDatabase } from '../../database';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { requireRouteId } from '../../utils/project-access';
import { sealCredentialSecret } from '../../utils/credentials';
import {
  canManageCredential,
  credentialNameTaken,
  credentialReferences,
  credentialScopeRefusal,
  credentialSummary,
  loadCredentialRecord,
  updateCredential,
} from '#shared/handlers/credentials';
import { parseCredentialInput } from '#shared/credentials';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Update a credential',
    description:
      'Changes the fields a body holds, as `POST /api/credentials` takes them; `service` cannot change. A `secret` replaces the stored one (a rotation) and moves `rotatedAt`; a new `destination` needs the secret in the same body, since a secret is sealed with the one destination it may be sent under (400 without it). `disabled: true` refuses every use until it is turned off. The rules of a create apply: 409 for a name another credential has or while `PIWI_SECRET_KEY` is unset with a secret, 403 for a scope the caller may not give. A credential the environment sets cannot change (409). Someone who holds `credentials:manage` changes any credential; a Project admin those they created that are shared only with projects they manage. Any other answers 404.',
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
      message: 'This credential is set by environment variables: change them instead.',
    });
  }

  const parsed = parseCredentialInput(await readBody(event).catch(() => null), { partial: true });
  if (!parsed.value) throw apiError({ statusCode: 400, message: parsed.error });
  const { secret, service, ...patch } = parsed.value;
  if (service !== undefined && service !== record.service) {
    throw apiError({ statusCode: 400, message: 'A credential’s service cannot change: create another one.' });
  }
  if (patch.destination !== undefined && patch.destination !== record.destination && !secret) {
    throw apiError({
      statusCode: 400,
      message: 'Enter the secret again to change the destination: it is sealed with the one it may be sent under.',
    });
  }
  if (patch.scope) {
    const refusal = credentialScopeRefusal(access, patch.scope);
    if (refusal) throw apiError({ statusCode: 403, message: refusal });
  }
  if (patch.name !== undefined && (await credentialNameTaken(db, patch.name, id))) {
    throw apiError({ statusCode: 409, message: `A credential is already named "${patch.name}".` });
  }
  const sealed = secret ? sealCredentialSecret(patch.destination ?? record.destination, secret) : undefined;
  await updateCredential(db, id, patch, sealed);
  const updated = (await loadCredentialRecord(db, id))!;
  return { credential: credentialSummary(updated, (await credentialReferences(db)).get(id) ?? [], viewer) };
});
