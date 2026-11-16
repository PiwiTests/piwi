/**
 * The credential routes in the browser demo, on the server's shared handlers.
 * The demo sends nothing, so it stores no secret: a credential it saves holds
 * every field but the secret, which the form still asks for, and the seeded
 * log is the only one it shows. It has no environment, so a variable a secret
 * is read from is never known to be set.
 */
import { can } from '#shared/permissions';
import {
  credentialReferenceText,
  parseCredentialInput,
  scmCredentialProblem,
  type CredentialInput,
  CREDENTIAL_SERVICES,
  type CredentialService,
} from '#shared/credentials';
import {
  canManageCredential,
  type CredentialViewer,
  credentialNameTaken,
  credentialReferences,
  credentialScopeRefusal,
  credentialSummary,
  deleteCredential,
  insertCredential,
  listCredentialOptions,
  listCredentialSummaries,
  listCredentialUses,
  loadCredentialRecord,
  parseCredentialUsesFilter,
  readInstanceScmCredentialIds,
  updateCredential,
} from '#shared/handlers/credentials';
import type { getDemoDb } from '../db.client';
import { demoHttpError } from './http-error';

type DemoDB = Awaited<ReturnType<typeof getDemoDb>>;

/** `GET /api/credentials`: the ones the visitor may change, or with `projectId` the ones a CI action of it may name. */
export async function demoListCredentials(
  db: DemoDB,
  viewer: CredentialViewer,
  query: Record<string, unknown>,
  assertProject: (projectId: number) => void,
) {
  if (query.projectId !== undefined) {
    const projectId = Number(query.projectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw demoHttpError(400, 'projectId must be a project ID');
    assertProject(projectId);
    const service = (CREDENTIAL_SERVICES as readonly unknown[]).includes(query.service)
      ? (query.service as CredentialService)
      : undefined;
    return { credentials: await listCredentialOptions(db as never, projectId, viewer, service), canEncrypt: true };
  }
  return { credentials: await listCredentialSummaries(db as never, viewer), canEncrypt: true };
}

async function manageable(db: DemoDB, viewer: CredentialViewer, id: number) {
  const record = await loadCredentialRecord(db as never, id);
  if (!record || !(can(viewer.access, 'credentials:manage') || canManageCredential(viewer, record))) {
    throw demoHttpError(404, 'Credential not found');
  }
  return record;
}

async function summaryOf(db: DemoDB, viewer: CredentialViewer, id: number) {
  const record = (await loadCredentialRecord(db as never, id))!;
  return credentialSummary(record, (await credentialReferences(db as never)).get(id) ?? [], viewer);
}

/** `POST /api/credentials` in the demo: the server's checks, and the record without its secret. */
export async function demoCreateCredential(db: DemoDB, viewer: CredentialViewer, body: unknown, userId: number | null) {
  const parsed = parseCredentialInput(body, { partial: false });
  if (!parsed.value) throw demoHttpError(400, parsed.error);
  const input = parsed.value as CredentialInput;
  if (input.service === 'scm') {
    const problem = scmCredentialProblem({ destination: input.destination, user: input.user ?? null });
    if (problem) throw demoHttpError(400, problem);
    input.allowedInputs = null;
    input.customRequests = false;
  }
  const refusal = can(viewer.access, 'credentials:manage') ? null : credentialScopeRefusal(viewer.access, input.scope);
  if (refusal) throw demoHttpError(403, refusal);
  if (await credentialNameTaken(db as never, input.name)) {
    throw demoHttpError(409, `A credential is already named "${input.name}".`);
  }
  if (input.secretEnv && !can(viewer.access, 'credentials:manage')) {
    throw demoHttpError(403, 'Reading a secret from a variable takes the credentials:manage permission.');
  }
  const { secret: _secret, ...fields } = input;
  const id = await insertCredential(
    db as never,
    {
      ...fields,
      description: input.description ?? null,
      user: input.user ?? null,
      allowedInputs: input.allowedInputs ?? null,
      customRequests: input.customRequests ?? false,
      disabled: input.disabled ?? false,
    },
    null,
    userId,
  );
  return { credential: await summaryOf(db, viewer, id) };
}

/** `GET /api/credentials/:id` in the demo. */
export async function demoGetCredential(db: DemoDB, viewer: CredentialViewer, id: number) {
  await manageable(db, viewer, id);
  return { credential: await summaryOf(db, viewer, id) };
}

/** `PATCH /api/credentials/:id` in the demo: the server's checks; a typed secret only moves the rotation date. */
export async function demoUpdateCredential(db: DemoDB, viewer: CredentialViewer, id: number, body: unknown) {
  const record = await manageable(db, viewer, id);
  if (record.managedBy === 'env') {
    throw demoHttpError(409, 'This credential is set by environment variables: change them instead.');
  }
  const parsed = parseCredentialInput(body, { partial: true });
  if (!parsed.value) throw demoHttpError(400, parsed.error);
  const { secret, service, ...patch } = parsed.value;
  if (service !== undefined && service !== record.service) {
    throw demoHttpError(400, 'A credential’s service cannot change: create another one.');
  }
  if (record.service === 'scm') {
    const problem = scmCredentialProblem({
      destination: patch.destination ?? record.destination,
      user: patch.user !== undefined ? patch.user : record.user,
    });
    if (problem) throw demoHttpError(400, problem);
    delete patch.allowedInputs;
    delete patch.customRequests;
    if (patch.scope && !patch.scope.allProjects && (await readInstanceScmCredentialIds(db as never)).includes(id)) {
      throw demoHttpError(
        409,
        'This credential is one of the instance’s SCM credentials, which serve every project: take it out of Settings → Source control first.',
      );
    }
  }
  if (patch.destination !== undefined && patch.destination !== record.destination && !secret && !patch.secretEnv) {
    throw demoHttpError(
      400,
      'Enter the secret, or name its variable, again to change the destination: it is sealed with the one it may be sent under.',
    );
  }
  if (patch.secretEnv && !can(viewer.access, 'credentials:manage')) {
    throw demoHttpError(403, 'Reading a secret from a variable takes the credentials:manage permission.');
  }
  if (patch.scope) {
    const refusal = can(viewer.access, 'credentials:manage')
      ? null
      : credentialScopeRefusal(viewer.access, patch.scope);
    if (refusal) throw demoHttpError(403, refusal);
  }
  if (patch.name !== undefined && (await credentialNameTaken(db as never, patch.name, id))) {
    throw demoHttpError(409, `A credential is already named "${patch.name}".`);
  }
  // The demo keeps no secret: a rotation stores none, and only moves the date and the variable named.
  const owner =
    can(viewer.access, 'credentials:manage') && record.createdBy !== viewer.userId ? viewer.userId : undefined;
  await updateCredential(db as never, id, patch, secret || patch.secretEnv ? '' : undefined, owner);
  return { credential: await summaryOf(db, viewer, id) };
}

/** `DELETE /api/credentials/:id` in the demo, refused while something names it. */
export async function demoDeleteCredential(db: DemoDB, viewer: CredentialViewer, id: number) {
  const record = await manageable(db, viewer, id);
  if (record.managedBy === 'env') {
    throw demoHttpError(409, 'This credential is set by environment variables: unset them instead.');
  }
  const usedBy = (await credentialReferences(db as never)).get(id) ?? [];
  if (usedBy.length > 0) {
    const names = usedBy.map(credentialReferenceText).join(', ');
    throw demoHttpError(409, `Still named by ${names}: pick another credential in each first.`);
  }
  await deleteCredential(db as never, id);
  return { ok: true };
}

/** `GET /api/credentials/:id/uses` in the demo: the seeded log. */
export async function demoCredentialUses(
  db: DemoDB,
  viewer: CredentialViewer,
  id: number,
  query: Record<string, unknown>,
) {
  await manageable(db, viewer, id);
  return listCredentialUses(db as never, id, parseCredentialUsesFilter(query));
}

/** `GET /api/credentials/uses` in the demo: the seeded log of every credential. */
export async function demoAllCredentialUses(db: DemoDB, query: Record<string, unknown>) {
  return listCredentialUses(db as never, null, parseCredentialUsesFilter(query));
}
