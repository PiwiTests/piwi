import { getDatabase } from '../../database';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { requireProjectAccess } from '../../utils/project-access';
import { canEncryptSecrets } from '../../utils/crypto';
import { ensureEnvCredentials, withSecretEnvState } from '../../utils/credentials';
import { listCredentialOptions, listCredentialSummaries } from '#shared/handlers/credentials';
import { CREDENTIAL_SERVICES, type CredentialService } from '#shared/credentials';
import { parseRouteId } from '#shared/route-id';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'List credentials',
    description:
      'Lists the credentials Piwi sends to other services, never their secrets. Without `projectId`, it answers the credentials the caller may change, with their scope, what names them (`usedBy`: CI actions, the source control of a project or of the instance, AI roles, Jira and Zephyr Scale connections, Slack channels of the instance) and when each was last used: every credential for someone who holds `credentials:manage` (the ones the environment sets included, read-only), and for a Project admin those they created that are shared only with projects they manage and read no variable. With `projectId`, it answers the credentials that project may name (set in the database and shared with it), without their scope, for a Project admin of that project; `service` narrows them. `secretEnv` names the `PIWI_CREDENTIAL_*` variable a credential reads its secret from, and `secretEnvSet` whether it is set on the server. `canEncrypt` says whether a credential can be saved (`PIWI_SECRET_KEY` is set).',
    parameters: [
      { name: 'projectId', in: 'query', required: false, schema: { type: 'integer' } },
      {
        name: 'service',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['ci-server', 'scm', 'ai', 'jira', 'zephyr-scale', 'slack'] },
      },
    ],
    'x-required-permission': ['credentials:manage', 'project:manage'],
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const query = getQuery(event);
  const db = await getDatabase();
  await ensureEnvCredentials(db);
  // The virtual administrator of an instance without sign-in is id 0, no user row.
  const viewer = { access: await getRequestAccess(event), userId: user.id || null };
  const canEncrypt = canEncryptSecrets();
  if (query.projectId !== undefined) {
    const projectId = parseRouteId(String(query.projectId));
    if (projectId === null) throw apiError({ statusCode: 400, message: 'projectId must be a project ID' });
    await requireProjectAccess(event, projectId, 'project:manage');
    const service = (CREDENTIAL_SERVICES as readonly unknown[]).includes(query.service)
      ? (query.service as CredentialService)
      : undefined;
    const options = await listCredentialOptions(db, projectId, viewer, service);
    return { credentials: options.map(withSecretEnvState), canEncrypt };
  }
  return { credentials: (await listCredentialSummaries(db, viewer)).map(withSecretEnvState), canEncrypt };
});
