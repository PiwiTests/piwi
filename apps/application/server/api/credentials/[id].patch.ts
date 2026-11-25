import { getDatabase } from '../../database';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { requireRouteId } from '../../utils/project-access';
import { sealCredentialEnv, sealCredentialSecret, withSecretEnvState } from '../../utils/credentials';
import { isUniqueViolation } from '../../utils/db-errors';
import { ciServerBaseUrlProblem } from '../../utils/ci-server-dispatch';
import {
  canManageCredential,
  credentialNameTaken,
  credentialReferences,
  credentialScopeRefusal,
  credentialSummary,
  deleteUserTokens,
  loadCredentialRecord,
  namedForEveryProject,
  updateCredential,
  userTokenCounts,
} from '#shared/handlers/credentials';
import { credentialServiceProblem, jenkinsRoot, parseCredentialInput } from '#shared/credentials';
import { configuredGitlabHosts } from '../../utils/scm/gitlab-hosts';
import { normalizeScmDestination, oauthEndpoints } from '#shared/scm-urls';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Update a credential',
    description:
      'Changes the fields a body holds, as `POST /api/credentials` takes them; `service` cannot change. A `secret` replaces the stored one (a rotation) and moves `rotatedAt`, as does a `secretEnv`, which reads it from that `PIWI_CREDENTIAL_*` variable instead (`credentials:manage` only, 403); a new `destination` needs the secret or its variable in the same body, since either is sealed with the one destination it may be sent under (400 without it). `disabled: true` refuses every use until it is turned off. The rules of a create apply: 409 for a name another credential has or while `PIWI_SECRET_KEY` is unset with a secret, 403 for a scope the caller may not give. A credential the environment sets cannot change (409). A per-user credential (`perUser`) takes no `user`, `secretEnv` or Custom request (400). A CI server’s takes no `secret`, and only its `tokenHelpUrl` is its own; a source control one rotates its OAuth client secret with `secret`, changes its application with `oauthClientId`, and takes the secret again for a destination on another host. A new destination, or another OAuth application, removes every person’s token. A change by someone who holds `credentials:manage` makes the credential theirs, so a Project admin who created it no longer changes it. Someone who holds `credentials:manage` changes any credential; a Project admin those they created that are shared only with projects they manage, read no variable and are not per-user. Any other answers 404.',
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
  const oauth = record.perUser && record.service === 'scm';
  if (record.perUser && (patch.user || (secret && !oauth) || patch.secretEnv || patch.customRequests)) {
    throw apiError({
      statusCode: 400,
      message:
        'A per-user credential holds no user and no secret, each person gives their own token, and never goes with a Custom request.',
    });
  }
  if (!record.perUser && patch.tokenHelpUrl) {
    throw apiError({ statusCode: 400, message: 'Only a per-user credential links to where a person creates a token.' });
  }
  if (!oauth && patch.oauthClientId) {
    throw apiError({
      statusCode: 400,
      message: 'Only a per-user source control credential names an OAuth application.',
    });
  }
  if (oauth && patch.oauthClientId === null) {
    throw apiError({ statusCode: 400, message: 'A per-user source control credential names its OAuth application.' });
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
        'Something that serves every project names this credential (the instance’s source control, an AI role, a connection or a Slack channel of the instance): name another one there first.',
    });
  }
  const moved = patch.destination !== undefined && patch.destination !== record.destination;
  if (moved && record.perUser && !oauth) {
    const unsafe = ciServerBaseUrlProblem(jenkinsRoot(patch.destination!));
    if (unsafe) throw apiError({ statusCode: 400, message: unsafe });
  }
  const newEndpoints = oauth ? oauthEndpoints(patch.destination ?? record.destination, configuredGitlabHosts()) : null;
  if (oauth && !newEndpoints) {
    throw apiError({
      statusCode: 400,
      message: 'A per-user source control credential authorizes people on GitLab or Bitbucket.',
    });
  }
  // The client secret is sealed with the host's token endpoint: a credential moved to another host takes it again.
  const oldTokenEndpoint = oauth ? oauthEndpoints(record.destination, configuredGitlabHosts())?.token : null;
  if (oauth && newEndpoints && newEndpoints.token !== oldTokenEndpoint && !secret) {
    throw apiError({
      statusCode: 400,
      message: 'Enter the OAuth client secret again to change the host: it is sealed with the host’s token endpoint.',
    });
  }
  if (moved && !record.perUser && !secret && !patch.secretEnv) {
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
      ? sealCredentialSecret(newEndpoints ? newEndpoints.token : destination, secret)
      : undefined;
  // People's tokens were sealed with the destination it leaves, or given to the OAuth application it leaves.
  const forgetsTokens =
    record.perUser && (moved || (patch.oauthClientId !== undefined && patch.oauthClientId !== record.oauthClientId));
  // A change by an administrator makes the credential theirs: its creator never loosens it afterwards.
  const owner = can(access, 'credentials:manage') && record.createdBy !== viewer.userId ? viewer.userId : undefined;
  try {
    await updateCredential(db, id, patch, sealed, owner);
    // Each person gives theirs again.
    if (forgetsTokens) await deleteUserTokens(db, id, null);
  } catch (e) {
    // Two renames to one name at once: the database's unique index answers for the slower one.
    if (isUniqueViolation(e))
      throw apiError({ statusCode: 409, message: `A credential is already named "${patch.name}".` });
    throw e;
  }
  const updated = (await loadCredentialRecord(db, id))!;
  return {
    credential: withSecretEnvState(
      credentialSummary(
        updated,
        (await credentialReferences(db)).get(id) ?? [],
        viewer,
        (await userTokenCounts(db)).get(id) ?? 0,
      ),
    ),
  };
});
