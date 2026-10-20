/**
 * Helpers for the role-based AI settings surface (GET/PUT /api/settings/ai).
 *
 * Storage: the `ai` app-setting holds `{ autoDiagnose, roles }` where each role
 * (`diagnosis` | `research` | `embedding`) has its own provider config, or a
 * `reuse` pointer to inherit another role's provider/key/baseUrl. A stored
 * setting may instead hold flat fields (`provider`, `model`, `researchModel`,
 * …); `storedRoles()` maps those onto roles on read.
 */

import { eq } from 'drizzle-orm';
import { getAppSetting } from './app-settings';
import { canEncryptSecrets } from './crypto';
import { projects } from '../database/schema';
import type { AiModelRole, AiProvider, AiRoleSettings, AiSettings } from '~~/types/api';
import type { DbClient } from '../database';

export const AI_ROLES: AiModelRole[] = ['diagnosis', 'research', 'embedding'];

/** The environment-managed AI response language, or null. */
export function envAiLanguage(): string | null {
  return process.env.PIWI_AI_LANGUAGE?.trim() || null;
}

/**
 * The instance-wide AI response language: the env var when set (env-managed),
 * else the stored `ai_language` app-setting, else null (today's behavior).
 */
export async function readAiLanguage(db: DbClient): Promise<string | null> {
  const env = envAiLanguage();
  if (env) return env;
  const stored = await getAppSetting<{ value?: string }>(db, 'ai_language');
  return stored?.value?.trim() || null;
}

/** The effective AI language for a project: its override, else the instance-wide one. */
export async function resolveProjectAiLanguage(db: DbClient, projectId: number): Promise<string | null> {
  const [row] = await db
    .select({ aiLanguage: projects.aiLanguage })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (row?.aiLanguage?.trim()) return row.aiLanguage.trim();
  return readAiLanguage(db);
}

/** Stored shape of a single role (apiKey encrypted at rest). */
export interface RawStoredRole {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  reuse?: AiModelRole | null;
  /** OpenAI-compat only: sampling temperature override. */
  temperature?: number;
}

/** Stored shape of the `ai` app-setting (new `roles` shape or legacy flat fields). */
export interface RawStoredAi {
  autoDiagnose?: boolean;
  roles?: Partial<Record<AiModelRole, RawStoredRole>>;
  // Legacy flat fields (pre-roles installs)
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  researchModel?: string;
  researchProvider?: string;
  researchBaseUrl?: string;
  researchApiKey?: string;
}

/**
 * Parse a `PIWI_AI_*_TEMPERATURE` value into a finite number, or undefined when unset or invalid.
 * The runtime config hands over a number when the value was overridden through `NUXT_AI_*_TEMPERATURE`.
 */
export function parseEnvTemperature(raw?: string | number | null): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Map legacy flat storage (or env vars in the same shape) onto the role map. */
export function rolesFromLegacy(flat: {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  temperature?: string | number;
  researchModel?: string;
  researchProvider?: string;
  researchBaseUrl?: string;
  researchApiKey?: string;
  researchTemperature?: string | number;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
}): Partial<Record<AiModelRole, RawStoredRole>> {
  const roles: Partial<Record<AiModelRole, RawStoredRole>> = {};
  if (flat.provider) {
    roles.diagnosis = {
      provider: flat.provider,
      model: flat.model,
      baseUrl: flat.baseUrl,
      apiKey: flat.apiKey,
      temperature: parseEnvTemperature(flat.temperature),
    };
  }
  if (flat.researchModel) {
    // Provider, base URL and key each default to the main role's: with none of its own, research reuses it.
    const temperature = parseEnvTemperature(flat.researchTemperature);
    roles.research =
      flat.researchProvider || flat.researchBaseUrl || flat.researchApiKey
        ? {
            provider: flat.researchProvider || flat.provider,
            model: flat.researchModel,
            baseUrl: flat.researchBaseUrl || flat.baseUrl,
            apiKey: flat.researchApiKey || flat.apiKey,
            temperature,
          }
        : { reuse: 'diagnosis', model: flat.researchModel, temperature };
  }
  if (flat.embeddingModel) {
    // Provider, base URL and key each default to the main role's.
    roles.embedding = {
      provider: flat.embeddingProvider || flat.provider,
      model: flat.embeddingModel,
      baseUrl: flat.embeddingBaseUrl || flat.baseUrl,
      apiKey: flat.embeddingApiKey || flat.apiKey,
    };
  }
  return roles;
}

/** Read the stored role map, migrating legacy flat storage on the fly. */
export function storedRoles(stored: RawStoredAi | null | undefined): Partial<Record<AiModelRole, RawStoredRole>> {
  if (!stored) return {};
  if (stored.roles) return stored.roles;
  return rolesFromLegacy(stored);
}

/**
 * The roles in effect while the environment manages AI: the roles the env vars
 * define, with the stored per-role settings laid over them. The environment
 * owns each role's provider, key and base URL; a stored model or temperature
 * replaces the environment's, and a role the environment leaves out is added
 * when it reuses a role that is set. `readAiSettings` (what Settings shows) and
 * `resolveAiConfig` (what every AI call uses) both apply it.
 */
export function overlayStoredRoles(
  envRoles: Partial<Record<AiModelRole, RawStoredRole>>,
  stored: RawStoredAi | null | undefined,
): Partial<Record<AiModelRole, RawStoredRole>> {
  const roles = { ...envRoles };
  for (const role of AI_ROLES) {
    const override = stored?.roles?.[role];
    if (!override) continue;
    const env = envRoles[role];
    if (env) {
      roles[role] = {
        ...env,
        ...(override.model ? { model: override.model } : {}),
        ...(override.temperature != null ? { temperature: override.temperature } : {}),
      };
    } else if (override.reuse && roles[override.reuse]) {
      roles[role] = { reuse: override.reuse, model: override.model, temperature: override.temperature };
    }
  }
  return roles;
}

/** Client-facing settings for one role (omits the secret). */
export function toRoleSettings(raw?: RawStoredRole | null): AiRoleSettings | null {
  if (!raw || (!raw.provider && !raw.reuse)) return null;
  return {
    provider: (raw.provider as AiProvider) || null,
    model: raw.model || null,
    baseUrl: raw.baseUrl || null,
    reuse: raw.reuse ?? null,
    hasApiKey: Boolean(raw.apiKey),
    temperature: raw.temperature ?? null,
  };
}

/** Build the full client-facing Ai settings from env vars (if managed) or DB. */
export async function readAiSettings(db: DbClient): Promise<AiSettings> {
  const runtimeConfig = useRuntimeConfig();
  const envAi = runtimeConfig.ai as Record<string, string | boolean | undefined> | undefined;
  const envManaged = Boolean(envAi?.provider);

  const [instructions, scmTokenSetting, languageSetting] = await Promise.all([
    getAppSetting<{ value?: string }>(db, 'ai_instructions'),
    getAppSetting<{ value?: string }>(db, 'scm_token'),
    getAppSetting<{ value?: string }>(db, 'ai_language'),
  ]);
  const customInstructions = instructions?.value || null;
  const hasScmToken = Boolean(scmTokenSetting?.value);
  const languageEnvManaged = envAiLanguage() != null;
  const language = envAiLanguage() ?? languageSetting?.value?.trim() ?? null;

  let roleMap: Partial<Record<AiModelRole, RawStoredRole>>;
  let autoDiagnose: boolean;

  if (envManaged) {
    const stored = await getAppSetting<RawStoredAi>(db, 'ai');
    roleMap = overlayStoredRoles(rolesFromLegacy(envAi as Parameters<typeof rolesFromLegacy>[0]), stored);
    autoDiagnose = String(envAi!.autoDiagnose) === 'true';
  } else {
    const stored = await getAppSetting<RawStoredAi>(db, 'ai');
    roleMap = storedRoles(stored);
    autoDiagnose = Boolean(stored?.autoDiagnose);
  }

  return {
    roles: {
      diagnosis: toRoleSettings(roleMap.diagnosis),
      research: toRoleSettings(roleMap.research),
      embedding: toRoleSettings(roleMap.embedding),
    },
    autoDiagnose,
    hasScmToken,
    envManaged,
    customInstructions,
    language,
    languageEnvManaged,
    canStoreSecrets: canEncryptSecrets(),
  };
}
