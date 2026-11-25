/**
 * The credential routes in the browser demo, on the server's shared handlers.
 * The demo sends nothing, so it stores no secret: a credential it saves holds
 * every field but the secret, which the form still asks for, and the seeded
 * log is the only one it shows. It has no environment, so a variable a secret
 * is read from is never known to be set. A person's token for a per-user
 * credential is checked as the server checks it, and its test takes it as the
 * account its user name names, without sending anything.
 */
import { and, eq } from 'drizzle-orm';
import { can } from '#shared/permissions';
import { credentialUserTokens } from '../../../server/database/schema';
import {
  credentialReferenceText,
  parseCredentialInput,
  credentialServiceProblem,
  userTokenInputProblem,
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
  listMyCredentials,
  listUserTokens,
  loadCredentialRecord,
  myCredential,
  parseCredentialUsesFilter,
  namedForEveryProject,
  deleteUserTokens,
  updateCredential,
  userTokenCounts,
} from '#shared/handlers/credentials';
import { normalizeScmDestination } from '#shared/scm-urls';
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
  return credentialSummary(
    record,
    (await credentialReferences(db as never)).get(id) ?? [],
    viewer,
    (await userTokenCounts(db as never)).get(id) ?? 0,
  );
}

/** `POST /api/credentials` in the demo: the server's checks, and the record without its secret. */
export async function demoCreateCredential(db: DemoDB, viewer: CredentialViewer, body: unknown, userId: number | null) {
  const parsed = parseCredentialInput(body, { partial: false });
  if (!parsed.value) throw demoHttpError(400, parsed.error);
  const input = parsed.value as CredentialInput;
  if (input.service !== 'ci-server') {
    const problem = credentialServiceProblem(input.service, {
      destination: input.destination,
      user: input.user ?? null,
    });
    if (problem) throw demoHttpError(400, problem);
    if (input.service === 'scm') input.destination = normalizeScmDestination(input.destination);
    input.allowedInputs = null;
    input.customRequests = false;
  }
  if (input.perUser && !can(viewer.access, 'credentials:manage')) {
    throw demoHttpError(403, 'A per-user credential takes the credentials:manage permission.');
  }
  if (!input.perUser && input.tokenHelpUrl) {
    throw demoHttpError(400, 'Only a per-user credential links to where a person creates a token.');
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
      perUser: input.perUser ?? false,
      tokenHelpUrl: input.tokenHelpUrl ?? null,
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
  if (record.perUser && (patch.user || secret || patch.secretEnv || patch.customRequests)) {
    throw demoHttpError(
      400,
      'A per-user credential holds no user and no secret, each person gives their own token, and never goes with a Custom request.',
    );
  }
  if (!record.perUser && patch.tokenHelpUrl) {
    throw demoHttpError(400, 'Only a per-user credential links to where a person creates a token.');
  }
  if (record.service !== 'ci-server') {
    const problem = credentialServiceProblem(record.service, {
      destination: patch.destination ?? record.destination,
      user: patch.user !== undefined ? patch.user : record.user,
    });
    if (problem) throw demoHttpError(400, problem);
    if (patch.destination !== undefined && record.service === 'scm') {
      patch.destination = normalizeScmDestination(patch.destination);
    }
    delete patch.allowedInputs;
    delete patch.customRequests;
  }
  if (patch.scope && !patch.scope.allProjects && (await namedForEveryProject(db as never, id))) {
    throw demoHttpError(
      409,
      'Something that serves every project names this credential (the instance’s source control, an AI role, a connection or a Slack channel of the instance): name another one there first.',
    );
  }
  const moved = patch.destination !== undefined && patch.destination !== record.destination;
  if (moved && !record.perUser && !secret && !patch.secretEnv) {
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
  if (moved && record.perUser) await deleteUserTokens(db as never, id, null);
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

/** The signed-in person of the demo, who holds tokens; the demo always has one. */
function tokenHolder(viewer: CredentialViewer): { access: CredentialViewer['access']; userId: number } {
  if (!viewer.userId) throw demoHttpError(400, 'A per-user credential holds the tokens of signed-in people only.');
  return { access: viewer.access, userId: viewer.userId };
}

async function myEntry(db: DemoDB, viewer: CredentialViewer, id: number) {
  const holder = tokenHolder(viewer);
  const entry = await myCredential(db as never, holder, id);
  if (!entry) throw demoHttpError(404, 'Credential not found');
  return { holder, entry };
}

/** `GET /api/credentials/mine` in the demo. */
export async function demoMyCredentials(db: DemoDB, viewer: CredentialViewer) {
  if (!viewer.userId) return { items: [] };
  return { items: await listMyCredentials(db as never, tokenHolder(viewer)) };
}

/** `PUT /api/credentials/:id/token` in the demo: the server's checks, a test that takes the user name as the account, no secret kept. */
export async function demoSaveUserToken(db: DemoDB, viewer: CredentialViewer, id: number, body: unknown) {
  const { holder, entry } = await myEntry(db, viewer, id);
  if (!entry.usable) throw demoHttpError(404, 'Credential not found');
  const raw = (body ?? {}) as { user?: unknown; secret?: unknown };
  const user = typeof raw.user === 'string' ? raw.user.trim() : '';
  const secret = typeof raw.secret === 'string' ? raw.secret.trim() : '';
  const problem = userTokenInputProblem(user, secret);
  if (problem) throw demoHttpError(400, problem);
  if (entry.disabled) throw demoHttpError(400, `The credential "${entry.name}" is disabled.`);
  const others = await listUserTokens(db as never, id);
  if (others.some((t) => t.userId !== holder.userId && t.remoteUser.toLowerCase() === user.toLowerCase())) {
    throw demoHttpError(
      409,
      `Another person already gave a token for the account "${user}": each person gives their own.`,
    );
  }
  const now = new Date();
  const fields = { remoteUser: user, secret: '', state: 'ready', testedAt: now };
  if (entry.token) {
    await db
      .update(credentialUserTokens)
      .set(fields)
      .where(and(eq(credentialUserTokens.credentialId, id), eq(credentialUserTokens.userId, holder.userId)));
  } else {
    await db
      .insert(credentialUserTokens)
      .values({ ...fields, credentialId: id, userId: holder.userId, createdAt: now });
  }
  return { credential: await myCredential(db as never, holder, id) };
}

/** `POST /api/credentials/:id/token/test` in the demo: the token is taken again, as the demo sends nothing. */
export async function demoTestUserToken(db: DemoDB, viewer: CredentialViewer, id: number) {
  const { holder, entry } = await myEntry(db, viewer, id);
  if (!entry.token) throw demoHttpError(404, 'You gave no token for this credential.');
  if (entry.disabled) throw demoHttpError(400, `The credential "${entry.name}" is disabled.`);
  await db
    .update(credentialUserTokens)
    .set({ state: 'ready', testedAt: new Date() })
    .where(and(eq(credentialUserTokens.credentialId, id), eq(credentialUserTokens.userId, holder.userId)));
  return { ok: true, reason: null, message: null, credential: await myCredential(db as never, holder, id) };
}

/** `DELETE /api/credentials/:id/token` in the demo. */
export async function demoRemoveUserToken(db: DemoDB, viewer: CredentialViewer, id: number) {
  const { holder } = await myEntry(db, viewer, id);
  return { removed: await deleteUserTokens(db as never, id, holder.userId) };
}

async function perUserCredential(db: DemoDB, id: number) {
  const record = await loadCredentialRecord(db as never, id);
  if (!record?.perUser) throw demoHttpError(404, 'Credential not found');
  return record;
}

/** `GET /api/credentials/:id/tokens` in the demo. */
export async function demoListUserTokens(db: DemoDB, id: number) {
  await perUserCredential(db, id);
  return { items: await listUserTokens(db as never, id) };
}

/** `DELETE /api/credentials/:id/tokens` and `.../tokens/:userId` in the demo. */
export async function demoRemoveUserTokens(db: DemoDB, id: number, userId: number | null) {
  await perUserCredential(db, id);
  return { removed: await deleteUserTokens(db as never, id, userId) };
}
