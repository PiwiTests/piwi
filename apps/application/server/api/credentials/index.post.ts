import { getDatabase } from '../../database';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { sealCredentialEnv, sealCredentialSecret, withSecretEnvState } from '../../utils/credentials';
import { isUniqueViolation } from '../../utils/db-errors';
import {
  credentialNameTaken,
  credentialReferences,
  credentialScopeRefusal,
  credentialSummary,
  insertCredential,
  loadCredentialRecord,
} from '#shared/handlers/credentials';
import { credentialServiceProblem, parseCredentialInput, type CredentialInput } from '#shared/credentials';
import { configuredGitlabHosts } from '../../utils/scm';
import { normalizeScmDestination } from '#shared/scm-urls';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Create a credential',
    description:
      'Saves a credential: `{ name, service, secret, destination, scope, user?, description?, allowedInputs?, customRequests?, disabled? }`, or `secretEnv` in place of `secret`: the name of a `PIWI_CREDENTIAL_*` variable the secret is read from at each use, which only someone who holds `credentials:manage` may give (403), so no other variable of the server can be sent. `destination` is the base URL the secret may be sent under (an http(s) URL without a user, query or fragment), `scope` is `{ allProjects: true }` or `{ allProjects: false, projectIds }`, `allowedInputs` the CI action inputs a request carrying it may send (null or absent for every input), and `customRequests` whether a Custom CI server request may carry it (off by default). `service` is `ci-server` or `scm`: an SCM credential is sent as a bearer token to the API of a repository host, so its destination is the API of GitHub, of Bitbucket, of the GitLab cloud or of a GitLab host of `PIWI_SCM_GITLAB_HOSTS`, over https, or a path under its repositories (one owner, on GitHub: `/repos/acme/`), it names no user (400 otherwise), and it takes no input list or Custom request. The secret, or the name of its variable, is encrypted with its destination and never returned, so saving a credential answers HTTP 409 while `PIWI_SECRET_KEY` is unset. A name another credential has, ignoring case, answers 409. Someone who holds `credentials:manage` gives any scope; a Project admin names only projects they manage, and never all projects (403). Returns the credential as `GET /api/credentials/:id` does.',
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
  if (input.service !== 'ci-server') {
    const problem = credentialServiceProblem(
      input.service,
      { destination: input.destination, user: input.user ?? null },
      configuredGitlabHosts(),
    );
    if (problem) throw apiError({ statusCode: 400, message: problem });
    if (input.service === 'scm') input.destination = normalizeScmDestination(input.destination);
    input.allowedInputs = null;
    input.customRequests = false;
  }
  // Someone who holds credentials:manage gives any scope; a Project admin names only projects they manage.
  const refusal = can(access, 'credentials:manage') ? null : credentialScopeRefusal(access, input.scope);
  if (refusal) throw apiError({ statusCode: 403, message: refusal });

  const db = await getDatabase();
  if (await credentialNameTaken(db, input.name)) {
    throw apiError({ statusCode: 409, message: `A credential is already named "${input.name}".` });
  }
  // The server's environment is the operator's: only credentials:manage reads a secret from it.
  if (input.secretEnv && !can(access, 'credentials:manage')) {
    throw apiError({
      statusCode: 403,
      message: 'Reading a secret from a variable takes the credentials:manage permission.',
    });
  }
  const sealed = input.secretEnv
    ? sealCredentialEnv(input.destination, input.secretEnv)
    : sealCredentialSecret(input.destination, input.secret!);
  const { secret: _secret, ...fields } = input;
  let id: number;
  try {
    id = await insertCredential(
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
  } catch (e) {
    // Two creates of one name at once: the database's unique index answers for the slower one.
    if (isUniqueViolation(e))
      throw apiError({ statusCode: 409, message: `A credential is already named "${input.name}".` });
    throw e;
  }
  const record = (await loadCredentialRecord(db, id))!;
  setResponseStatus(event, 201);
  return {
    credential: withSecretEnvState(credentialSummary(record, (await credentialReferences(db)).get(id) ?? [], viewer)),
  };
});
