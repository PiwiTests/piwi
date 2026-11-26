import {
  CONTEXT_LIMIT_FIELDS,
  clampLimit,
  resolveStoredContextLimits,
  CONTEXT_LIMITS_SETTING_KEY,
} from '#shared/ai-context-limits';
import type { ContextLimits } from '#shared/ai-context-limits';
import type { DbClient } from '../database';

function parseEnvInt(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Keys whose value is pinned by an env var (shown read-only in the settings UI). */
export function envManagedLimitKeys(): (keyof ContextLimits)[] {
  return CONTEXT_LIMIT_FIELDS.filter((f) => parseEnvInt(f.envVar) != null).map((f) => f.key);
}

/**
 * Resolve the effective context limits: defaults ← stored settings ← env vars
 * (env wins). Stored/env values are clamped to each field's allowed range.
 */
export async function resolveContextLimits(db: DbClient): Promise<ContextLimits> {
  const stored = await getAppSetting<Partial<ContextLimits>>(db, CONTEXT_LIMITS_SETTING_KEY);
  const limits = resolveStoredContextLimits(stored);

  for (const field of CONTEXT_LIMIT_FIELDS) {
    const envVal = parseEnvInt(field.envVar);
    if (envVal != null) limits[field.key] = clampLimit(field, envVal) ?? limits[field.key];
  }

  return limits;
}
