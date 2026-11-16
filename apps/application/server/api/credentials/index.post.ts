import { getDatabase } from '../../database';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { sealCredentialSecret } from '../../utils/credentials';
import {
  credentialNameTaken,
  credentialReferences,
  credentialScopeRefusal,
  credentialSummary,
  insertCredential,
  loadCredentialRecord,
} from '#shared/handlers/credentials';
import { parseCredentialInput, type CredentialInput } from '#shared/credentials';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Create a credential',
    description:
      'Saves a credential: `{ name, service, secret, destination, scope, user?, description?, allowedInputs?, customRequests?, disabled? }`. `destination` is the base URL the secret may be sent under (an http(s) URL without a user, query or fragment), `scope` is `{ allProjects: true }` or `{ allProjects: false, projectIds }`, `allowedInputs` the CI action inputs a request carrying it may send (null or absent for every input), and `customRequests` whether a Custom CI server request may carry it (off by default). The secret is encrypted with its destination and never returned, so saving one answers HTTP 409 while `PIWI_SECRET_KEY` is unset. A name another credential has, ignoring case, answers 409. Someone who holds `credentials:manage` gives any scope; a Project admin names only projects they manage, and never all projects (403). Returns the credential as `GET /api/credentials/:id` does.',
    'x-required-permission': ['credentials:manage', 'project:manage'],
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const access = await getRequestAccess(event);
  // The virtual administrator of an instance without sign-in is id 0, no user row.
  const viewer = { access, userId: user.id || null };
  const parsed = parseCredentialInput(await readBody(event).catch(() => null), { partial: false });
  if (!parsed.value) throw apiError({ statusCode: 400, message: parsed.error });
  const input = parsed.value as CredentialInput;
  // Someone who holds credentials:manage gives any scope; a Project admin names only projects they manage.
  const refusal = can(access, 'credentials:manage') ? null : credentialScopeRefusal(access, input.scope);
  if (refusal) throw apiError({ statusCode: 403, message: refusal });

  const db = await getDatabase();
  if (await credentialNameTaken(db, input.name)) {
    throw apiError({ statusCode: 409, message: `A credential is already named "${input.name}".` });
  }
  const sealed = sealCredentialSecret(input.destination, input.secret);
  const { secret: _secret, ...fields } = input;
  const id = await insertCredential(
    db,
    {
      ...fields,
      description: input.description ?? null,
      user: input.user ?? null,
      allowedInputs: input.allowedInputs ?? null,
      customRequests: input.customRequests ?? false,
      disabled: input.disabled ?? false,
    },
    sealed,
    // The virtual administrator of an instance without sign-in is id 0, no user row.
    user.id || null,
  );
  const record = (await loadCredentialRecord(db, id))!;
  setResponseStatus(event, 201);
  return { credential: credentialSummary(record, (await credentialReferences(db)).get(id) ?? [], viewer) };
});
