import { getDatabase } from '../../database';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { requireRouteId } from '../../utils/project-access';
import { sealCredentialEnv, sealCredentialSecret, withSecretEnvState } from '../../utils/credentials';
import { isUniqueViolation } from '../../utils/db-errors';
import {
  canManageCredential,
  credentialNameTaken,
  credentialReferences,
  credentialScopeRefusal,
  credentialSummary,
  loadCredentialRecord,
  namedForEveryProject,
  updateCredential,
} from '#shared/handlers/credentials';
import { credentialServiceProblem, parseCredentialInput } from '#shared/credentials';
import { configuredGitlabHosts } from '../../utils/scm/gitlab-hosts';
import { normalizeScmDestination } from '#shared/scm-urls';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Update a credential',
    description:
      'Changes the fields a body holds, as `POST /api/credentials` takes them; `service` cannot change. A `secret` replaces the stored one (a rotation) and moves `rotatedAt`, as does a `secretEnv`, which reads it from that `PIWI_CREDENTIAL_*` variable instead (`credentials:manage` only, 403); a new `destination` needs the secret or its variable in the same body, since either is sealed with the one destination it may be sent under (400 without it). `disabled: true` refuses every use until it is turned off. The rules of a create apply: 409 for a name another credential has or while `PIWI_SECRET_KEY` is unset with a secret, 403 for a scope the caller may not give. A credential the environment sets cannot change (409). A change by someone who holds `credentials:manage` makes the credential theirs, so a Project admin who created it no longer changes it. Someone who holds `credentials:manage` changes any credential; a Project admin those they created that are shared only with projects they manage and read no variable. Any other answers 404.',
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
  if (record.service !== 'ci-server') {
    const problem = credentialServiceProblem(
      record.service,
      {
        destination: patch.destination ?? record.destination,
        user: patch.user !== undefined ? patch.user : record.user,
      },
      configuredGitlabHosts(),
    );
    if (problem) throw apiError({ statusCode: 400, message: problem });
    if (patch.destination !== undefined && record.service === 'scm') {
      patch.destination = normalizeScmDestination(patch.destination);
    }
    delete patch.allowedInputs;
    delete patch.customRequests;
  }
  if (patch.scope && !patch.scope.allProjects && (await namedForEveryProject(db, id))) {
    throw apiError({
      statusCode: 409,
      message:
        'The instance’s source control or an AI role names this credential, and they serve every project: name another one there first.',
    });
  }
  if (patch.destination !== undefined && patch.destination !== record.destination && !secret && !patch.secretEnv) {
    throw apiError({
      statusCode: 400,
      message:
        'Enter the secret, or name its variable, again to change the destination: it is sealed with the one it may be sent under.',
    });
  }
  // The server's environment is the operator's: only credentials:manage reads a secret from it.
  if (patch.secretEnv && !can(access, 'credentials:manage')) {
    throw apiError({
      statusCode: 403,
      message: 'Reading a secret from a variable takes the credentials:manage permission.',
    });
  }
  if (patch.scope) {
    const refusal = credentialScopeRefusal(access, patch.scope);
    if (refusal) throw apiError({ statusCode: 403, message: refusal });
  }
  if (patch.name !== undefined && (await credentialNameTaken(db, patch.name, id))) {
    throw apiError({ statusCode: 409, message: `A credential is already named "${patch.name}".` });
  }
  const destination = patch.destination ?? record.destination;
  const sealed = patch.secretEnv
    ? sealCredentialEnv(destination, patch.secretEnv)
    : secret
      ? sealCredentialSecret(destination, secret)
      : undefined;
  // A change by an administrator makes the credential theirs: its creator never loosens it afterwards.
  const owner = can(access, 'credentials:manage') && record.createdBy !== viewer.userId ? viewer.userId : undefined;
  try {
    await updateCredential(db, id, patch, sealed, owner);
  } catch (e) {
    // Two renames to one name at once: the database's unique index answers for the slower one.
    if (isUniqueViolation(e))
      throw apiError({ statusCode: 409, message: `A credential is already named "${patch.name}".` });
    throw e;
  }
  const updated = (await loadCredentialRecord(db, id))!;
  return {
    credential: withSecretEnvState(credentialSummary(updated, (await credentialReferences(db)).get(id) ?? [], viewer)),
  };
});
