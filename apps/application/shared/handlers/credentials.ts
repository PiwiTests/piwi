/**
 * The database reads and writes of the credential manager that never touch a
 * secret, shared by the server's routes and the demo's: the credentials a
 * caller lists or picks, who may change one, the CI actions that name one, and
 * a credential's log. Sealing, opening and sending a secret are
 * `server/utils/credentials.ts`' alone, and nothing here selects the column
 * that holds it.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  apiKeys,
  appSettings,
  credentialProjects,
  credentials,
  credentialUses,
  integrationConnections,
  notificationChannels,
  projects,
  users,
} from '../../server/database/schema';
import { can, type AccessSummary } from '#shared/permissions';
import { resolveCiActionsSettings } from '#shared/ci-actions';
import { isUnderBaseUrl } from '#shared/ci-server';
import {
  CREDENTIAL_FEATURES,
  CREDENTIAL_USE_RESULTS,
  MAX_CREDENTIAL_NAME_LENGTH,
  SLACK_POST_MESSAGE_URL,
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
import { scmDestinationHost, scmRepositoryApiUrl, shortCommit } from '#shared/scm-urls';
import { repositoryUrlFromRemote } from '../../server/utils/scm/git-url';
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
 * which is the operator's. A change by someone who holds `credentials:manage`
 * makes the credential theirs (`created_by`), so its creator never loosens
 * what an administrator set or undoes a Disable. A credential an administrator saved for a
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

/** The app setting that lists the instance's SCM credentials (`{ ids }`), the fallback of every project's repository calls. */
export const INSTANCE_SCM_CREDENTIALS_SETTING = 'scm_credentials';

/** The instance's SCM credentials, by id, in the order they were saved. */
export async function readInstanceScmCredentialIds(db: DrizzleDB): Promise<number[]> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, INSTANCE_SCM_CREDENTIALS_SETTING));
  const ids = (row?.value as { ids?: unknown } | undefined)?.ids;
  return Array.isArray(ids) ? ids.filter((id): id is number => Number.isInteger(id) && id > 0) : [];
}

/** The AI roles, in the order Settings → AI shows them, with the label a reference names them by. */
const AI_ROLE_REFERENCES = [
  ['diagnosis', 'AI · Diagnosis'],
  ['research', 'AI · Research'],
  ['embedding', 'AI · Embedding'],
  ['assistant', 'AI · Assistant'],
] as const;

/** The credential each AI role of Settings → AI names, from the `ai` app setting. */
async function aiRoleCredentialIds(db: DrizzleDB): Promise<Array<[string, number]>> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, 'ai'));
  const roles = (row?.value as { roles?: Record<string, { credentialId?: unknown } | undefined> } | undefined)?.roles;
  return AI_ROLE_REFERENCES.flatMap(([role, label]) => {
    const id = roles?.[role]?.credentialId;
    return typeof id === 'number' ? [[label, id] as [string, number]] : [];
  });
}

/**
 * What names each credential, by credential id: CI actions, projects' source
 * control, the instance's source control, the AI roles, the Jira and Zephyr
 * Scale connections, the Slack channels of the instance.
 */
export async function credentialReferences(db: DrizzleDB): Promise<Map<number, CredentialReference[]>> {
  const [rows, instanceIds, aiRoles, connections, channels] = await Promise.all([
    db
      .select({
        id: projects.id,
        name: projects.name,
        label: projects.label,
        ciRerun: projects.ciRerun,
        scmCredentialId: projects.scmCredentialId,
      })
      .from(projects),
    readInstanceScmCredentialIds(db),
    aiRoleCredentialIds(db),
    db
      .select({ name: integrationConnections.name, credentialId: integrationConnections.credentialId })
      .from(integrationConnections)
      .where(isNotNull(integrationConnections.credentialId)),
    db
      .select({ name: notificationChannels.name, config: notificationChannels.config })
      .from(notificationChannels)
      .where(and(eq(notificationChannels.type, 'slack'), isNull(notificationChannels.userId))),
  ]);
  const references = new Map<number, CredentialReference[]>();
  const add = (credentialId: number, reference: CredentialReference) => {
    const list = references.get(credentialId) ?? [];
    list.push(reference);
    references.set(credentialId, list);
  };
  for (const id of instanceIds) {
    add(id, { kind: 'instance-scm', projectId: null, projectName: null, actionId: null, name: 'Source control' });
  }
  for (const [name, id] of aiRoles) {
    add(id, { kind: 'ai-role', projectId: null, projectName: null, actionId: null, name });
  }
  for (const connection of connections) {
    add(connection.credentialId!, {
      kind: 'connection',
      projectId: null,
      projectName: null,
      actionId: null,
      name: connection.name,
    });
  }
  for (const channel of channels) {
    const id = (channel.config as { credentialId?: unknown } | null)?.credentialId;
    if (typeof id !== 'number') continue;
    add(id, { kind: 'channel', projectId: null, projectName: null, actionId: null, name: channel.name });
  }
  for (const project of rows) {
    const projectName = project.label || project.name;
    if (project.scmCredentialId != null) {
      add(project.scmCredentialId, {
        kind: 'project-scm',
        projectId: project.id,
        projectName,
        actionId: null,
        name: 'Source control',
      });
    }
    if (!project.ciRerun) continue;
    for (const action of resolveCiActionsSettings(project.ciRerun).actions) {
      if (action.target.credentialId == null) continue;
      add(action.target.credentialId, {
        kind: 'ci-action',
        projectId: project.id,
        projectName,
        actionId: action.id,
        name: action.name,
      });
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

/** `name`, or `name (2)`, `name (3)`… : the first no credential has, ignoring case. */
export async function freeCredentialName(db: DrizzleDB, name: string): Promise<string> {
  const rows = await db.select({ name: credentials.name }).from(credentials);
  const taken = new Set(rows.map((r) => r.name.toLowerCase()));
  const base = name.slice(0, MAX_CREDENTIAL_NAME_LENGTH - 5);
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
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
 * rotation date. `owner`, when given, becomes the user the credential is
 * managed by (`created_by`).
 */
export async function updateCredential(
  db: DrizzleDB,
  id: number,
  patch: Partial<Omit<CredentialInput, 'secret'>>,
  sealed?: string,
  owner?: number | null,
): Promise<void> {
  const set: Partial<typeof credentials.$inferInsert> = {};
  if (owner !== undefined) set.createdBy = owner;
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

/**
 * Why a Slack channel of the instance cannot name this credential, or null: it
 * must hold a Slack token saved in the database, be shared with all projects
 * (a channel of the instance serves every project) and be sent to the Web API.
 */
export async function slackChannelCredentialProblem(db: DrizzleDB, credentialId: number): Promise<string | null> {
  const record = await loadCredentialRecord(db, credentialId);
  if (!record || record.service !== 'slack' || record.managedBy !== 'db') {
    return `No Slack credential ${credentialId} exists.`;
  }
  if (!record.allProjects) return `The credential "${record.name}" is not shared with all projects.`;
  if (!isUnderBaseUrl(record.destination, SLACK_POST_MESSAGE_URL)) {
    return `The credential "${record.name}" is sent only under ${record.destination}, not to Slack’s Web API.`;
  }
  return null;
}

/**
 * Delete the credential a deleted connection or channel named, when the
 * person asked for it: only one saved in the database that nothing names any
 * more. Returns whether it was deleted.
 */
export async function deleteCredentialIfUnused(db: DrizzleDB, id: number): Promise<boolean> {
  const record = await loadCredentialRecord(db, id);
  if (!record || record.managedBy !== 'db') return false;
  if (((await credentialReferences(db)).get(id) ?? []).length > 0) return false;
  await deleteCredential(db, id);
  return true;
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

/** How the log names a subject other than a CI action: a pull request, a commit or a branch. */
function credentialSubjectName(type: string | null, id: string | null): string | null {
  if (!id) return null;
  if (type === 'pull-request') return `pull request #${id}`;
  if (type === 'commit') return `commit ${shortCommit(id)}`;
  if (type === 'branch') return `branch ${id}`;
  if (type === 'channel') return `channel ${id}`;
  return null;
}

/**
 * A page of a credential's log, or of every credential's (`credentialId`
 * null, deleted ones included), newest first, and the cursor of the next page.
 */
export async function listCredentialUses(
  db: DrizzleDB,
  credentialId: number | null,
  filter: CredentialUsesFilter,
): Promise<{ items: CredentialUseEntry[]; nextCursor: number | null }> {
  const conditions = credentialId === null ? [] : [eq(credentialUses.credentialId, credentialId)];
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
      projectCiRerun: projects.ciRerun,
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
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(credentialUses.id))
    .limit(CREDENTIAL_USES_PAGE_SIZE + 1);
  const page = rows.slice(0, CREDENTIAL_USES_PAGE_SIZE);
  const actionNames = new Map<number, Map<string, string>>();
  const actionName = (row: (typeof page)[number]): string | null => {
    if (row.subjectType !== 'ci-action' || !row.subjectId || row.projectId == null) return null;
    let names = actionNames.get(row.projectId);
    if (!names) {
      const actions = row.projectCiRerun ? resolveCiActionsSettings(row.projectCiRerun).actions : [];
      names = new Map(actions.map((a) => [a.id, a.name]));
      actionNames.set(row.projectId, names);
    }
    return names.get(row.subjectId) ?? null;
  };
  const channelIds = [
    ...new Set(page.filter((row) => row.subjectType === 'channel').map((row) => Number(row.subjectId))),
  ].filter((id) => Number.isInteger(id));
  const channelNames = new Map(
    channelIds.length === 0
      ? []
      : (
          await db
            .select({ id: notificationChannels.id, name: notificationChannels.name })
            .from(notificationChannels)
            .where(inArray(notificationChannels.id, channelIds))
        ).map((channel) => [String(channel.id), channel.name]),
  );
  const channelName = (row: (typeof page)[number]): string | null =>
    row.subjectType === 'channel' && row.subjectId ? (channelNames.get(row.subjectId) ?? null) : null;
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
      subjectName:
        actionName(row) ?? channelName(row) ?? credentialSubjectName(row.subjectType ?? null, row.subjectId ?? null),
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

type ActionLike = { id?: string; name: string; target: { type: string } & Record<string, unknown> };

/** The repository hosts whose CI actions may name an SCM credential. */
const SCM_TARGET_TYPES: readonly string[] = ['github', 'gitlab', 'bitbucket'];

/** Whether a posted action names the credential, base URL and preset its stored version already did. */
function unchangedCredentialUse(action: ActionLike, stored: readonly ActionLike[]): boolean {
  const before = stored.find((s) => s.id !== undefined && s.id === action.id);
  if (!before || before.target.type !== action.target.type) return false;
  if (before.target.credentialId !== action.target.credentialId) return false;
  if (before.target.type !== 'ci-server') return SCM_TARGET_TYPES.includes(before.target.type);
  return (
    (before.target.baseUrl ?? null) === (action.target.baseUrl ?? null) && before.target.preset === action.target.preset
  );
}

/**
 * Why an SCM credential does not go with a repository's calls, or null: its
 * destination must hold the repository's API URL (`scmRepositoryApiUrl`). A
 * repository not known yet, in any remote form, passes.
 */
function scmRepositoryProblem(record: CredentialRecord, repositoryUrl: string | null): string | null {
  const apiUrl = scmRepositoryApiUrl(repositoryUrlFromRemote(repositoryUrl));
  if (!apiUrl || isUnderBaseUrl(record.destination, apiUrl)) return null;
  return `The credential "${record.name}" is sent only under ${record.destination}, which does not hold this project's repository (${apiUrl}).`;
}

/** Whether a credential set in the database for `service` is shared with the project. */
function sharedWith(record: CredentialRecord | undefined, service: CredentialService, projectId: number): boolean {
  return (
    !!record &&
    record.managedBy === 'db' &&
    record.service === service &&
    (record.allProjects || record.projectIds.includes(projectId))
  );
}

/**
 * Why a project's CI actions cannot be saved with the credentials they name,
 * or null: each one must exist, be set in the database for the action's
 * service (a CI server, or the repository host's API for a GitHub, GitLab or
 * Bitbucket action), and be shared with the project; a CI server action's own
 * base URL must lie under its destination, and a Custom request needs a
 * credential that allows one. The same answer for a credential that does not
 * exist and one not shared with the project, so a project admin learns
 * nothing of the others. With the stored actions given, an action whose
 * credential, base URL and preset are unchanged is not checked again: a
 * credential narrowed since then is refused at dispatch, and does not block
 * the project's other changes. `gitlabHosts` is `PIWI_SCM_GITLAB_HOSTS`, and
 * `repositoryUrl` the project's repository, whose API an SCM credential must hold.
 */
export async function ciActionsCredentialProblem(
  db: DrizzleDB,
  projectId: number,
  settings: { actions: ActionLike[] },
  stored: readonly ActionLike[] = [],
  gitlabHosts: ReadonlySet<string> = new Set(),
  repositoryUrl: string | null = null,
): Promise<string | null> {
  const wanted = settings.actions.filter(
    (a) => typeof a.target.credentialId === 'number' && !unchangedCredentialUse(a, stored),
  );
  if (wanted.length === 0) return null;
  const records = new Map((await loadCredentialRecords(db)).map((r) => [r.id, r]));
  for (const action of wanted) {
    const id = action.target.credentialId as number;
    const record = records.get(id);
    if (SCM_TARGET_TYPES.includes(action.target.type)) {
      if (!sharedWith(record, 'scm', projectId)) {
        return `"${action.name}": no SCM credential ${id} is shared with this project.`;
      }
      if (scmDestinationHost(record!.destination, gitlabHosts) !== action.target.type) {
        return `"${action.name}": the credential "${record!.name}" is sent to ${record!.destination}, not to the API of this action's host.`;
      }
      const problem = scmRepositoryProblem(record!, repositoryUrl);
      if (problem) return `"${action.name}": ${problem}`;
      continue;
    }
    if (!sharedWith(record, 'ci-server', projectId)) {
      return `"${action.name}": no CI server credential ${id} is shared with this project.`;
    }
    const baseUrl = typeof action.target.baseUrl === 'string' ? action.target.baseUrl : null;
    if (baseUrl && !isUnderBaseUrl(record!.destination, baseUrl)) {
      return `"${action.name}": its base URL ${baseUrl} is not under ${record!.destination}, where the credential "${record!.name}" is sent.`;
    }
    if (action.target.preset === 'custom' && !record!.customRequests) {
      return `"${action.name}": the credential "${record!.name}" does not go with a Custom request.`;
    }
  }
  return null;
}

/**
 * Why a project cannot name this SCM credential, or null: it must exist, be
 * set in the database for source control and be shared with the project, with
 * one answer for the three; and, when the project has a repository, hold its
 * API URL. `gitlabHosts` is `PIWI_SCM_GITLAB_HOSTS`.
 */
export async function projectScmCredentialProblem(
  db: DrizzleDB,
  projectId: number,
  credentialId: number,
  repositoryUrl: string | null,
  gitlabHosts: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const record = (await loadCredentialRecord(db, credentialId)) ?? undefined;
  if (!sharedWith(record, 'scm', projectId)) return `No SCM credential ${credentialId} is shared with this project.`;
  if (!scmDestinationHost(record!.destination, gitlabHosts)) {
    return `The credential "${record!.name}" is sent to ${record!.destination}, which is no repository host's API.`;
  }
  return scmRepositoryProblem(record!, repositoryUrl);
}

/**
 * Whether something that serves every project names the credential (the
 * instance's source control, an AI role, a Jira or Zephyr Scale connection,
 * a Slack channel of the instance), so its scope stays all projects.
 */
export async function namedForEveryProject(db: DrizzleDB, credentialId: number): Promise<boolean> {
  const references = (await credentialReferences(db)).get(credentialId) ?? [];
  return references.some((r) => r.kind !== 'ci-action' && r.kind !== 'project-scm');
}

/**
 * Why the instance cannot list these SCM credentials, or null: each must
 * exist, be set in the database for source control and be shared with all
 * projects, since the instance's serve every project.
 */
export async function instanceScmCredentialsProblem(db: DrizzleDB, ids: readonly number[]): Promise<string | null> {
  const records = new Map((await loadCredentialRecords(db)).map((r) => [r.id, r]));
  for (const id of ids) {
    const record = records.get(id);
    if (!record || record.managedBy !== 'db' || record.service !== 'scm') return `No SCM credential ${id} exists.`;
    if (!record.allProjects) {
      return `The credential "${record.name}" is not shared with all projects, which the instance's credentials serve.`;
    }
  }
  return null;
}
