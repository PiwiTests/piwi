/**
 * Pure helpers for the Settings → AI provider form (`app/pages/settings/ai.vue`).
 *
 * The form edits four model roles (diagnosis, research, embedding, assistant). Turning
 * those role forms into the PUT body is fiddly enough — and was buggy enough —
 * to be worth isolating from the Vue component so it can be unit-tested.
 *
 * The subtlety that bit us: `diagnosis` is REQUIRED and has no enable toggle in
 * the UI, so its `enabled` flag is *not* a reliable signal — nothing in the UI
 * ever flips it true for a first-time config, so a freshly-picked provider used
 * to be treated as "not enabled" and silently discarded on save (or rejected by
 * the server with "a diagnosis role with its own provider is required"). A role
 * counts as configured when:
 *   - diagnosis: a provider is selected — its presence *is* "AI is on"; or
 *   - an optional role (research / embedding / assistant): its enable switch is on.
 *
 * Saving with no diagnosis provider means "turn AI off" → `{ roles: null }`.
 */
import type { AiModelRole, AiRoleConfigInput, SaveAiSettingsBody } from '~~/types/api';

export interface RoleForm {
  enabled: boolean;
  reuse: AiModelRole | null;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** OpenAI-compat only: sampling temperature override, kept as a string like the other inputs. Empty means "provider default". */
  temperature: string;
}

export type RoleForms = Record<AiModelRole, RoleForm>;

/**
 * Whether a role should be written on save. The diagnosis role is the required
 * root, so it's "configured" the moment a provider is chosen (it has no enable
 * toggle); every other role is opt-in via its enable switch.
 */
export function isRoleConfigured(roles: RoleForms, role: AiModelRole): boolean {
  const r = roles[role];
  if (role === 'diagnosis') return Boolean(r.provider);
  return r.enabled;
}

/**
 * Parse the free-text temperature field; blank means "provider default". Range
 * (0-2) is enforced server-side too — this only guards obviously bad input.
 */
export function parseRoleTemperature(role: AiModelRole, raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    throw new Error(`Role "${role}": temperature must be a number between 0 and 2`);
  }
  return n;
}

/** The PUT body fragment for one role, or `null` when the role is not configured. */
export function roleSaveBody(roles: RoleForms, role: AiModelRole): AiRoleConfigInput | null {
  if (!isRoleConfigured(roles, role)) return null;
  const r = roles[role];
  const temperature = parseRoleTemperature(role, r.temperature);
  if (r.reuse) return { reuse: r.reuse, model: r.model || undefined, temperature };
  const body: AiRoleConfigInput = {
    provider: r.provider,
    model: r.model || undefined,
    baseUrl: r.baseUrl || undefined,
    temperature,
  };
  if (r.apiKey !== '') body.apiKey = r.apiKey;
  return body;
}

/**
 * Build the PUT body for saving the provider config. Throws (via
 * {@link parseRoleTemperature}) on invalid temperature input so the caller can
 * surface it as a save failure.
 */
export function buildAiSaveBody(
  roles: RoleForms,
  opts: { envManaged: boolean; autoDiagnose: boolean },
): SaveAiSettingsBody {
  // Non-env-managed with no diagnosis provider → the user is turning AI off, so
  // clear the whole config. When env-managed we keep sending roles so per-role
  // model overrides still apply (the server ignores provider/key/baseUrl then).
  if (!opts.envManaged && !isRoleConfigured(roles, 'diagnosis')) {
    return { roles: null, autoDiagnose: opts.autoDiagnose };
  }
  return {
    roles: {
      diagnosis: roleSaveBody(roles, 'diagnosis'),
      research: roleSaveBody(roles, 'research'),
      embedding: roleSaveBody(roles, 'embedding'),
      assistant: roleSaveBody(roles, 'assistant'),
    },
    autoDiagnose: opts.autoDiagnose,
  };
}
