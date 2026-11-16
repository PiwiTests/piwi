/**
 * The AI keys as credentials of the `ai` service: the endpoint a role's key is
 * sent to, the credential a key typed in Settings → AI is saved in, the
 * environment's keys as read-only credentials, opening a configuration's keys
 * for a call to the model, and the import of the keys stored before
 * credentials existed.
 *
 * A key is opened only by `openAiKeys`, through `withCredential`: resolving
 * the configuration for a status or a form never opens one.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { credentials } from '../database/schema';
import type { DbClient } from '../database';
import { getAppSetting, setAppSetting } from './app-settings';
import { decryptSecret, getEncryptionKey } from './crypto';
import {
  AI_KEY_ENV_VARS,
  CredentialRefusedError,
  freeName,
  sealCredentialSecret,
  withCredential,
  type CredentialActor,
} from './credentials';
import {
  AI_ROLES,
  overlayStoredRoles,
  rolesFromLegacy,
  storedRoles,
  type RawStoredAi,
  type RawStoredRole,
} from './ai-settings';
import { insertCredential, loadCredentialRecord, updateCredential } from '#shared/handlers/credentials';
import { isUnderBaseUrl } from '#shared/ci-server';
import { aiEndpoint } from '#shared/credentials';

export { aiEndpoint };
import type { AiConfig, AiModelRole, ResolvedAiRole } from '~~/types/api';

const ROLE_LABELS: Record<AiModelRole, string> = {
  diagnosis: 'Diagnosis',
  research: 'Research',
  embedding: 'Embedding',
  assistant: 'Assistant',
};

/** How a role names its credential in a sentence or a reference: `AI · Diagnosis`. */
export function aiRoleName(role: AiModelRole): string {
  return `AI · ${ROLE_LABELS[role]}`;
}

/**
 * Save a key typed for a role: it rotates the credential the role names, bound
 * again to the role's endpoint, or creates one shared with all projects,
 * named after the role. Returns the credential's id.
 */
export async function saveAiRoleKey(
  db: DbClient,
  input: { role: AiModelRole; endpoint: string; key: string; credentialId: number | null; createdBy: number | null },
): Promise<number> {
  const sealed = sealCredentialSecret(input.endpoint, input.key);
  const named = input.credentialId ? await loadCredentialRecord(db, input.credentialId) : null;
  if (named && named.service === 'ai' && named.managedBy === 'db') {
    await updateCredential(db, named.id, { destination: input.endpoint }, sealed);
    return named.id;
  }
  const host = new URL(input.endpoint).host;
  return insertCredential(
    db,
    {
      name: await freeName(db, `${aiRoleName(input.role)} · ${host}`),
      description: null,
      service: 'ai',
      user: null,
      destination: input.endpoint,
      scope: { allProjects: true },
      allowedInputs: null,
      customRequests: false,
      disabled: false,
    },
    sealed,
    input.createdBy,
  );
}

/**
 * Why a role cannot name this credential, or null: it must exist, hold a key
 * for an AI provider, be shared with all projects (the roles serve every
 * project), and be sent under the role's endpoint.
 */
export async function aiRoleCredentialProblem(
  db: DbClient,
  role: AiModelRole,
  credentialId: number,
  endpoint: string,
): Promise<string | null> {
  const record = await loadCredentialRecord(db, credentialId);
  if (!record || record.service !== 'ai') return `Role "${role}": no AI credential ${credentialId} exists.`;
  if (!record.allProjects) return `Role "${role}": the credential "${record.name}" is not shared with all projects.`;
  if (!isUnderBaseUrl(record.destination, endpoint)) {
    return `Role "${role}": the credential "${record.name}" is sent only under ${record.destination}, not to ${endpoint}.`;
  }
  return null;
}

/** The variable each role's key is read from when the environment manages AI: its own, else `PIWI_AI_API_KEY`. */
function envKeyVariable(role: AiModelRole): (typeof AI_KEY_ENV_VARS)[number] {
  const own = {
    diagnosis: 'PIWI_AI_API_KEY',
    research: 'PIWI_AI_RESEARCH_API_KEY',
    embedding: 'PIWI_AI_EMBEDDING_API_KEY',
    assistant: 'PIWI_AI_ASSISTANT_API_KEY',
  } as const;
  return process.env[own[role]]?.trim() ? own[role] : 'PIWI_AI_API_KEY';
}

/** The variable and endpoint of each role whose key the environment sets, following `reuse` links. */
export function envAiKeySources(
  roles: Partial<Record<AiModelRole, RawStoredRole>>,
): Map<AiModelRole, { variable: string; endpoint: string }> {
  const sources = new Map<AiModelRole, { variable: string; endpoint: string }>();
  for (const role of AI_ROLES) {
    const cfg = roles[role];
    if (!cfg) continue;
    if (cfg.reuse) {
      const base = sources.get(cfg.reuse);
      if (base) sources.set(role, base);
      continue;
    }
    const endpoint = aiEndpoint(cfg.provider, cfg.baseUrl);
    const variable = envKeyVariable(role);
    if (endpoint && process.env[variable]?.trim()) sources.set(role, { variable, endpoint });
  }
  return sources;
}

/**
 * Bring the AI credentials the environment sets in line with its variables:
 * one read-only credential per variable and endpoint its roles send a key to,
 * shared with all projects, the variable's name in its row (never the key);
 * one no role uses any more is removed. Returns their ids by `variable endpoint`.
 */
export async function ensureEnvAiCredentials(
  db: DbClient,
  sources: Map<AiModelRole, { variable: string; endpoint: string }>,
): Promise<Map<string, number>> {
  const wanted = new Map<string, { variable: string; endpoint: string }>();
  for (const source of sources.values()) wanted.set(`${source.variable} ${source.endpoint}`, source);
  const rows = await db
    .select({ id: credentials.id, variable: credentials.secretEnv, destination: credentials.destination })
    .from(credentials)
    .where(and(eq(credentials.service, 'ai'), eq(credentials.managedBy, 'env')));
  const ids = new Map<string, number>();
  const stale: number[] = [];
  for (const row of rows) {
    const key = `${row.variable} ${row.destination}`;
    if (wanted.has(key) && !ids.has(key)) ids.set(key, row.id);
    else stale.push(row.id);
  }
  if (stale.length > 0) await db.delete(credentials).where(inArray(credentials.id, stale));
  for (const [key, source] of wanted) {
    if (ids.has(key)) continue;
    try {
      const [row] = await db
        .insert(credentials)
        .values({
          name: await freeName(db, `AI key (environment) · ${source.variable} · ${new URL(source.endpoint).host}`),
          service: 'ai',
          userName: null,
          destination: source.endpoint,
          secret: null,
          secretEnv: source.variable,
          allProjects: true,
          allowedInputs: null,
          customRequests: false,
          disabled: false,
          managedBy: 'env',
        })
        .returning({ id: credentials.id });
      ids.set(key, row!.id);
    } catch (err) {
      // Two requests syncing at once: the other one's row stands.
      console.warn('[credentials] An AI credential of the environment could not be added:', err);
    }
  }
  return ids;
}

/** The credential each role's key comes from while the environment manages AI. */
export async function envAiCredentialIds(
  db: DbClient,
  roles: Partial<Record<AiModelRole, RawStoredRole>>,
): Promise<Map<AiModelRole, number>> {
  const sources = envAiKeySources(roles);
  const ids = await ensureEnvAiCredentials(db, sources);
  const byRole = new Map<AiModelRole, number>();
  for (const [role, source] of sources) {
    const id = ids.get(`${source.variable} ${source.endpoint}`);
    if (id !== undefined) byRole.set(role, id);
  }
  return byRole;
}

/**
 * A configuration with the keys of its roles opened, for a call to the model:
 * each credential once, through `withCredential`, as one counted read
 * (`ai-call`). A role whose credential is refused keeps no key and carries the
 * refusal, which a call with it throws; the configuration is still returned,
 * so a role the call does not use cannot stop it.
 */
export async function openAiKeys(db: DbClient, config: AiConfig, actor: CredentialActor): Promise<AiConfig> {
  const opened = new Map<string, { key: string } | { refusal: string }>();
  const open = async (role: ResolvedAiRole | null): Promise<ResolvedAiRole | null> => {
    if (!role || role.credentialId == null) return role;
    const endpoint = aiEndpoint(role.provider, role.baseUrl);
    if (!endpoint) return role;
    const cacheKey = `${role.credentialId} ${endpoint}`;
    let result = opened.get(cacheKey);
    if (!result) {
      try {
        const key = await withCredential(
          db,
          { credentialId: role.credentialId, feature: 'ai-call', projectId: null, url: endpoint, custom: false, actor },
          async (credential) => credential.secret,
        );
        result = { key };
      } catch (e) {
        if (!(e instanceof CredentialRefusedError)) throw e;
        result = { refusal: e.message };
      }
      opened.set(cacheKey, result);
    }
    return 'key' in result ? { ...role, apiKey: result.key } : { ...role, apiKey: '', refusal: result.refusal };
  };
  const roles = {
    diagnosis: (await open(config.roles.diagnosis))!,
    research: await open(config.roles.research),
    embedding: await open(config.roles.embedding),
    assistant: await open(config.roles.assistant),
  };
  return { ...config, apiKey: roles.diagnosis.apiKey, refusal: roles.diagnosis.refusal, roles };
}

/** A call with a role whose credential was refused fails with the credential's reason. */
export function assertAiKey(role: ResolvedAiRole): void {
  if (role.refusal) throw new CredentialRefusedError(role.refusal);
}

/**
 * Move the AI keys stored in Settings → AI (the `ai` app setting, roles or the
 * older flat fields) into credentials of the `ai` service, once, at startup:
 * each key to one bound to its role's endpoint, shared with all projects and
 * named by the role; equal keys for the same endpoint share one. The setting
 * is written back in the roles shape, each role naming its credential and
 * holding no key. A key that cannot be opened, or a configuration
 * `PIWI_SECRET_KEY` cannot seal, is left as it is and logged. Returns how many
 * keys were moved.
 */
export async function importAiKeys(db: DbClient): Promise<number> {
  const stored = await getAppSetting<RawStoredAi>(db, 'ai');
  const roles = storedRoles(stored);
  if (!AI_ROLES.some((role) => roles[role]?.apiKey && roles[role]?.credentialId == null)) return 0;
  const next: Partial<Record<AiModelRole, RawStoredRole>> = { ...roles };
  const made = new Map<string, number>();
  let moved = 0;
  try {
    for (const role of AI_ROLES) {
      const cfg = roles[role];
      if (!cfg?.apiKey || cfg.credentialId != null) continue;
      const endpoint = aiEndpoint(cfg.provider, cfg.baseUrl);
      let key: string;
      try {
        key = decryptSecret(cfg.apiKey, getEncryptionKey()).trim();
      } catch {
        console.warn(`[credentials] The AI key of the ${role} role cannot be opened; it is left as it is`);
        continue;
      }
      if (!endpoint || !key) continue;
      const dedupe = JSON.stringify([endpoint, key]);
      let id = made.get(dedupe);
      if (id === undefined) {
        id = await saveAiRoleKey(db, { role, endpoint, key, credentialId: null, createdBy: null });
        made.set(dedupe, id);
      }
      const { apiKey: _key, ...rest } = cfg;
      next[role] = { ...rest, credentialId: id };
      moved++;
    }
  } catch (err) {
    console.warn('[credentials] The AI keys could not be moved; they are left as they are', err);
    return 0;
  }
  if (moved > 0) {
    await setAppSetting(db, 'ai', { autoDiagnose: stored?.autoDiagnose ?? false, roles: next });
  }
  return moved;
}

/** The roles the environment sets, with the stored settings laid over them, as `resolveAiConfig` reads them. */
export function envRoles(
  envAi: Parameters<typeof rolesFromLegacy>[0],
  stored: RawStoredAi | null | undefined,
): Partial<Record<AiModelRole, RawStoredRole>> {
  return overlayStoredRoles(rolesFromLegacy(envAi), stored);
}
