/**
 * The database reads and writes of the credential manager that never touch a
 * secret, shared by the server's routes and the demo's: the credentials a
 * caller lists or picks, who may change one, the CI actions that name one, and
 * a credential's log. Sealing, opening and sending a secret are
 * `server/utils/credentials.ts`' alone, and nothing here selects the column
 * that holds it.
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  apiKeys,
  credentialProjects,
  credentials,
  credentialUses,
  projects,
  users,
} from '../../server/database/schema';
import { can, type AccessSummary } from '#shared/permissions';
import { resolveCiActionsSettings } from '#shared/ci-actions';
import { isUnderBaseUrl } from '#shared/ci-server';
import {
  CREDENTIAL_FEATURES,
  CREDENTIAL_USE_RESULTS,
  type CredentialFeature,
  type CredentialInput,
  type CredentialOption,
  type CredentialReference,
  type CredentialRules,
  type CredentialService,
  type CredentialSummary,
  type CredentialUseEntry,
  type CredentialUseResult,
} from '#shared/credentials';
import type { DrizzleDB } from './db';

/** A credential's record, without its secret: what a use is planned and checked with. */
export interface CredentialRecord extends CredentialRules {
  id: number;
  service: CredentialService;
  user: string | null;
  description: string | null;
  allowedInputs: string[] | null;
  managedBy: 'db' | 'env';
  /** The `PIWI_CREDENTIAL_*` variable its secret is read from; null for a saved secret. */
  secretEnv: string | null;
  /** Who created it, while that user exists. */
  createdBy: number | null;
  createdAt: Date;
  rotatedAt: Date;
  lastUsedAt: Date | null;
}

/** Who reads or changes credentials: their access, and their user id (null for nobody, or the instance without sign-in). */
export interface CredentialViewer {
  access: AccessSummary;
  userId: number | null;
}

/** Every column but the secret. */
const RECORD_COLUMNS = {
  id: credentials.id,
  name: credentials.name,
  description: credentials.description,
  service: credentials.service,
  user: credentials.userName,
  destination: credentials.destination,
  allProjects: credentials.allProjects,
  allowedInputs: credentials.allowedInputs,
  customRequests: credentials.customRequests,
  disabled: credentials.disabled,
  managedBy: credentials.managedBy,
  secretEnv: credentials.secretEnv,
  createdBy: credentials.createdBy,
  createdAt: credentials.createdAt,
  rotatedAt: credentials.rotatedAt,
  lastUsedAt: credentials.lastUsedAt,
};

interface RecordRow {
  id: number;
  name: string;
  description: string | null;
  service: string;
  user: string | null;
  destination: string;
  allProjects: boolean;
  allowedInputs: unknown;
  customRequests: boolean;
  disabled: boolean;
  managedBy: string;
  secretEnv: string | null;
  createdBy: number | null;
  createdAt: Date | number;
  rotatedAt: Date | number;
  lastUsedAt: Date | number | null;
}

const toDate = (value: Date | number | null): Date | null =>
  value == null ? null : value instanceof Date ? value : new Date(value);

function toRecord(row: RecordRow, projectIds: number[]): CredentialRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    service: row.service as CredentialService,
    user: row.user ?? null,
    destination: row.destination,
    allProjects: Boolean(row.allProjects),
    projectIds,
    allowedInputs: Array.isArray(row.allowedInputs) ? (row.allowedInputs as string[]) : null,
    customRequests: Boolean(row.customRequests),
    disabled: Boolean(row.disabled),
    managedBy: row.managedBy === 'env' ? 'env' : 'db',
    secretEnv: row.secretEnv ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: toDate(row.createdAt)!,
    rotatedAt: toDate(row.rotatedAt)!,
    lastUsedAt: toDate(row.lastUsedAt),
  };
}

async function projectIdsOf(db: DrizzleDB, ids: number[]): Promise<Map<number, number[]>> {
  const byCredential = new Map<number, number[]>();
  if (ids.length === 0) return byCredential;
  const rows = await db
    .select({ credentialId: credentialProjects.credentialId, projectId: credentialProjects.projectId })
    .from(credentialProjects)
    .where(inArray(credentialProjects.credentialId, ids));
  for (const row of rows) {
    const list = byCredential.get(row.credentialId) ?? [];
    list.push(row.projectId);
    byCredential.set(row.credentialId, list);
  }
  for (const list of byCredential.values()) list.sort((a, b) => a - b);
  return byCredential;
}

/** A credential's record, or null when it does not exist. */
export async function loadCredentialRecord(db: DrizzleDB, id: number): Promise<CredentialRecord | null> {
  const [row] = await db.select(RECORD_COLUMNS).from(credentials).where(eq(credentials.id, id));
  if (!row) return null;
  return toRecord(row, (await projectIdsOf(db, [id])).get(id) ?? []);
}

/** Every credential's record, by name. */
export async function loadCredentialRecords(db: DrizzleDB): Promise<CredentialRecord[]> {
  const rows = await db.select(RECORD_COLUMNS).from(credentials).orderBy(credentials.name);
  const scopes = await projectIdsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toRecord(row, scopes.get(row.id) ?? []));
}

/**
 * Whether a caller may change a credential and read its log: anyone who holds
 * `credentials:manage`, or the Project admin who created it while it is shared
 * only with projects they manage and its secret is not read from a variable,
 * which is the operator's. A credential an administrator saved for a
 * project stays theirs: its project's admins pick it, and never loosen its
 * rules. Nobody changes a credential the environment sets.
 */
export function canManageCredential(
  viewer: CredentialViewer,
  credential: Pick<CredentialRecord, 'allProjects' | 'projectIds' | 'managedBy' | 'createdBy' | 'secretEnv'>,
): boolean {
  if (credential.managedBy === 'env') return false;
  if (can(viewer.access, 'credentials:manage')) return true;
  return (
    viewer.userId != null &&
    credential.createdBy === viewer.userId &&
    credential.secretEnv === null &&
    !credential.allProjects &&
    credential.projectIds.length > 0 &&
    credential.projectIds.every((projectId) => can(viewer.access, 'project:manage', projectId))
  );
}

/** Whether a caller may read a credential's settings and log: everything for `credentials:manage`, else what they manage. */
export function canReadCredential(viewer: CredentialViewer, credential: CredentialRecord): boolean {
  return can(viewer.access, 'credentials:manage') || canManageCredential(viewer, credential);
}

/**
 * Why a caller may not give a credential this scope, or null: sharing with all
 * projects takes `credentials:manage`, and a Project admin names only projects
 * they manage.
 */
export function credentialScopeRefusal(access: AccessSummary, scope: CredentialInput['scope']): string | null {
  if (can(access, 'credentials:manage')) return null;
  if (scope.allProjects) return 'Sharing a credential with all projects takes the credentials:manage permission.';
  if (scope.projectIds.length === 0) return 'Name at least one project the credential is for.';
  const outside = scope.projectIds.find((projectId) => !can(access, 'project:manage', projectId));
  return outside === undefined ? null : 'A credential names only projects you manage.';
}

/** The CI actions that name each credential, by credential id. */
export async function credentialReferences(db: DrizzleDB): Promise<Map<number, CredentialReference[]>> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, label: projects.label, ciRerun: projects.ciRerun })
    .from(projects);
  const references = new Map<number, CredentialReference[]>();
  for (const project of rows) {
    if (!project.ciRerun) continue;
    for (const action of resolveCiActionsSettings(project.ciRerun).actions) {
      if (action.target.type !== 'ci-server' || action.target.credentialId == null) continue;
      const list = references.get(action.target.credentialId) ?? [];
      list.push({
        projectId: project.id,
        projectName: project.label || project.name,
        actionId: action.id,
        actionName: action.name,
      });
      references.set(action.target.credentialId, list);
    }
  }
  return references;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** Every credential the caller may manage, as the settings page lists them. */
export async function listCredentialSummaries(db: DrizzleDB, viewer: CredentialViewer): Promise<CredentialSummary[]> {
  const [records, references] = await Promise.all([loadCredentialRecords(db), credentialReferences(db)]);
  return records
    .filter((record) => canReadCredential(viewer, record))
    .map((record) => credentialSummary(record, references.get(record.id) ?? [], viewer));
}

/** One credential as its settings page shows it. */
export function credentialSummary(
  record: CredentialRecord,
  usedBy: CredentialReference[],
  viewer: CredentialViewer,
): CredentialSummary {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    service: record.service,
    user: record.user,
    destination: record.destination,
    scope: record.allProjects ? { allProjects: true } : { allProjects: false, projectIds: [...record.projectIds] },
    allowedInputs: record.allowedInputs,
    customRequests: record.customRequests,
    disabled: record.disabled,
    managedBy: record.managedBy,
    secretEnv: record.secretEnv,
    secretEnvSet: null,
    createdAt: record.createdAt.toISOString(),
    rotatedAt: record.rotatedAt.toISOString(),
    lastUsedAt: iso(record.lastUsedAt),
    usedBy,
    canManage: canManageCredential(viewer, record),
  };
}

/** The credentials a project's CI actions may pick: the ones set in the database and shared with the project. */
export async function listCredentialOptions(
  db: DrizzleDB,
  projectId: number,
  viewer: CredentialViewer,
  service?: CredentialService,
): Promise<CredentialOption[]> {
  const records = await loadCredentialRecords(db);
  return records
    .filter(
      (record) =>
        record.managedBy === 'db' &&
        (!service || record.service === service) &&
        (record.allProjects || record.projectIds.includes(projectId)),
    )
    .map((record) => ({
      id: record.id,
      name: record.name,
      service: record.service,
      user: record.user,
      destination: record.destination,
      allowedInputs: record.allowedInputs,
      customRequests: record.customRequests,
      disabled: record.disabled,
      managedBy: record.managedBy,
      secretEnv: record.secretEnv,
      secretEnvSet: null,
      rotatedAt: record.rotatedAt.toISOString(),
      lastUsedAt: iso(record.lastUsedAt),
      canManage: canManageCredential(viewer, record),
    }));
}

/** Whether another credential has this name, ignoring case. */
export async function credentialNameTaken(db: DrizzleDB, name: string, exceptId?: number): Promise<boolean> {
  const rows = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(sql`lower(${credentials.name}) = ${name.toLowerCase()}`);
  return rows.some((row) => row.id !== exceptId);
}

async function writeScope(db: DrizzleDB, id: number, scope: CredentialInput['scope']): Promise<void> {
  await db.delete(credentialProjects).where(eq(credentialProjects.credentialId, id));
  if (scope.allProjects || scope.projectIds.length === 0) return;
  const known = await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, scope.projectIds));
  if (known.length === 0) return;
  await db.insert(credentialProjects).values(known.map((p) => ({ credentialId: id, projectId: p.id })));
}

/**
 * Store a new credential with its secret, or the variable it is read from,
 * already sealed with its destination (`sealed`, or null in the demo, which
 * sends nothing). Returns its id.
 */
export async function insertCredential(
  db: DrizzleDB,
  input: Omit<CredentialInput, 'secret'>,
  sealed: string | null,
  createdBy: number | null,
): Promise<number> {
  const now = new Date();
  const [row] = await db
    .insert(credentials)
    .values({
      name: input.name,
      description: input.description,
      service: input.service,
      userName: input.user,
      destination: input.destination,
      secret: sealed,
      secretEnv: input.secretEnv ?? null,
      allProjects: input.scope.allProjects,
      allowedInputs: input.allowedInputs,
      customRequests: input.customRequests,
      disabled: input.disabled,
      managedBy: 'db',
      createdBy,
      createdAt: now,
      rotatedAt: now,
    })
    .returning({ id: credentials.id });
  await writeScope(db, row!.id, input.scope);
  return row!.id;
}

/**
 * Change a stored credential. `sealed` is the new secret, or the variable it
 * is read from (`patch.secretEnv`, null for a typed one), sealed with the
 * destination the update leaves; given when either was sent, it moves the
 * rotation date.
 */
export async function updateCredential(
  db: DrizzleDB,
  id: number,
  patch: Partial<Omit<CredentialInput, 'secret'>>,
  sealed?: string,
): Promise<void> {
  const set: Partial<typeof credentials.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.user !== undefined) set.userName = patch.user;
  if (patch.destination !== undefined) set.destination = patch.destination;
  if (patch.allowedInputs !== undefined) set.allowedInputs = patch.allowedInputs;
  if (patch.customRequests !== undefined) set.customRequests = patch.customRequests;
  if (patch.disabled !== undefined) set.disabled = patch.disabled;
  if (patch.scope !== undefined) set.allProjects = patch.scope.allProjects;
  if (sealed !== undefined) {
    set.secret = sealed;
    set.secretEnv = patch.secretEnv ?? null;
    set.rotatedAt = new Date();
  }
  if (Object.keys(set).length > 0) await db.update(credentials).set(set).where(eq(credentials.id, id));
  if (patch.scope !== undefined) await writeScope(db, id, patch.scope);
}

/** Delete a credential; its log rows stay, under the name they recorded. */
export async function deleteCredential(db: DrizzleDB, id: number): Promise<void> {
  await db.delete(credentials).where(eq(credentials.id, id));
}

export const CREDENTIAL_USES_PAGE_SIZE = 50;

/** The filters of a credential's log. */
export interface CredentialUsesFilter {
  projectId?: number;
  feature?: CredentialFeature;
  result?: CredentialUseResult;
  /** The id of the last row of the page before. */
  before?: number;
}

/** Read a log filter from a query string, dropping what it does not know. */
export function parseCredentialUsesFilter(query: Record<string, unknown>): CredentialUsesFilter {
  const positive = (v: unknown) => {
    const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };
  const feature = (CREDENTIAL_FEATURES as readonly unknown[]).includes(query.feature)
    ? (query.feature as CredentialFeature)
    : undefined;
  const result = (CREDENTIAL_USE_RESULTS as readonly unknown[]).includes(query.result)
    ? (query.result as CredentialUseResult)
    : undefined;
  return { projectId: positive(query.projectId), feature, result, before: positive(query.before) };
}

/** A page of a credential's log, newest first, and the cursor of the next page. */
export async function listCredentialUses(
  db: DrizzleDB,
  credentialId: number,
  filter: CredentialUsesFilter,
): Promise<{ items: CredentialUseEntry[]; nextCursor: number | null }> {
  const conditions = [eq(credentialUses.credentialId, credentialId)];
  if (filter.projectId) conditions.push(eq(credentialUses.projectId, filter.projectId));
  if (filter.feature) conditions.push(eq(credentialUses.feature, filter.feature));
  if (filter.result) conditions.push(eq(credentialUses.result, filter.result));
  if (filter.before) conditions.push(lt(credentialUses.id, filter.before));
  const rows = await db
    .select({
      id: credentialUses.id,
      credentialName: credentialUses.credentialName,
      feature: credentialUses.feature,
      projectId: credentialUses.projectId,
      projectName: projects.name,
      projectLabel: projects.label,
      userName: users.name,
      username: users.username,
      apiKey: apiKeys.name,
      subjectType: credentialUses.subjectType,
      subjectId: credentialUses.subjectId,
      destination: credentialUses.destination,
      result: credentialUses.result,
      reason: credentialUses.reason,
      count: credentialUses.count,
      createdAt: credentialUses.createdAt,
      lastAt: credentialUses.lastAt,
    })
    .from(credentialUses)
    .leftJoin(projects, eq(projects.id, credentialUses.projectId))
    .leftJoin(users, eq(users.id, credentialUses.userId))
    .leftJoin(apiKeys, eq(apiKeys.id, credentialUses.apiKeyId))
    .where(and(...conditions))
    .orderBy(desc(credentialUses.id))
    .limit(CREDENTIAL_USES_PAGE_SIZE + 1);
  const page = rows.slice(0, CREDENTIAL_USES_PAGE_SIZE);
  return {
    items: page.map((row) => ({
      id: row.id,
      credentialName: row.credentialName,
      feature: row.feature as CredentialFeature,
      projectId: row.projectId ?? null,
      projectName: row.projectLabel || row.projectName || null,
      actor: row.userName || row.username || null,
      apiKey: row.apiKey ?? null,
      subjectType: row.subjectType ?? null,
      subjectId: row.subjectId ?? null,
      destination: row.destination ?? null,
      result: row.result as CredentialUseResult,
      reason: row.reason ?? null,
      count: row.count,
      createdAt: toDate(row.createdAt)!.toISOString(),
      lastAt: toDate(row.lastAt)!.toISOString(),
    })),
    nextCursor: rows.length > CREDENTIAL_USES_PAGE_SIZE ? page[page.length - 1]!.id : null,
  };
}

/**
 * Why a project's CI actions cannot be saved with the credentials they name,
 * or null: each one must exist, be set in the database for a CI server, and be
 * shared with the project; an action's own base URL must lie under its
 * destination, and a Custom request needs a credential that allows one. The
 * same answer for a credential that does not exist and one not shared with
 * the project, so a project admin learns nothing of the others.
 */
export async function ciActionsCredentialProblem(
  db: DrizzleDB,
  projectId: number,
  settings: { actions: Array<{ name: string; target: { type: string } & Record<string, unknown> }> },
): Promise<string | null> {
  const wanted = settings.actions.filter(
    (a) => a.target.type === 'ci-server' && typeof a.target.credentialId === 'number',
  );
  if (wanted.length === 0) return null;
  const records = new Map((await loadCredentialRecords(db)).map((r) => [r.id, r]));
  for (const action of wanted) {
    const id = action.target.credentialId as number;
    const record = records.get(id);
    if (
      !record ||
      record.managedBy !== 'db' ||
      record.service !== 'ci-server' ||
      !(record.allProjects || record.projectIds.includes(projectId))
    ) {
      return `"${action.name}": no CI server credential ${id} is shared with this project.`;
    }
    const baseUrl = typeof action.target.baseUrl === 'string' ? action.target.baseUrl : null;
    if (baseUrl && !isUnderBaseUrl(record.destination, baseUrl)) {
      return `"${action.name}": its base URL ${baseUrl} is not under ${record.destination}, where the credential "${record.name}" is sent.`;
    }
    if (action.target.preset === 'custom' && !record.customRequests) {
      return `"${action.name}": the credential "${record.name}" does not go with a Custom request.`;
    }
  }
  return null;
}
