/**
 * Pure helpers for the Settings → AI form (`app/pages/settings/ai.vue`).
 *
 * The form edits four model roles (diagnosis, research, embedding, assistant)
 * and turns them into the PUT body. A role counts as configured when:
 *   - diagnosis: a provider is selected, since its presence is what turns AI on;
 *   - an optional role (research / embedding / assistant): its feature is on.
 *
 * Saving with no diagnosis provider turns AI off: `{ roles: null }`.
 */
import type { AiModelRole, AiRoleConfigInput, AiRoleSettings, SaveAiSettingsBody } from '~~/types/api';
import {
  type ModelPurpose,
  type ProviderTile,
  type ProviderTileId,
  providerTile,
  suggestedModel,
  tileFor,
} from '~/utils/ai-provider-catalog';

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

/** A role form with the tile the user picked, which the stored config alone cannot always tell. */
export interface RoleDraft extends RoleForm {
  tile: ProviderTileId | null;
}

export type RoleDrafts = Record<AiModelRole, RoleDraft>;

export function blankRoleDraft(): RoleDraft {
  return { enabled: false, reuse: null, provider: '', model: '', baseUrl: '', apiKey: '', temperature: '', tile: null };
}

/** The form of a stored role; the key is never returned, so it starts empty. */
export function roleDraftFromSettings(stored: AiRoleSettings | null | undefined): RoleDraft {
  return {
    enabled: Boolean(stored),
    reuse: stored?.reuse ?? null,
    provider: stored?.provider ?? '',
    model: stored?.model ?? '',
    baseUrl: stored?.baseUrl ?? '',
    apiKey: '',
    temperature: stored?.temperature != null ? String(stored.temperature) : '',
    tile: stored?.reuse ? null : tileFor(stored?.provider, stored?.baseUrl),
  };
}

/**
 * Point a role at a tile. Back on the stored config's own tile, the stored
 * address, model and temperature return; on another, the tile's address and
 * suggested model. A typed key never carries over.
 */
export function applyTile(
  form: RoleDraft,
  tile: ProviderTile,
  purpose: ModelPurpose,
  stored: AiRoleSettings | null | undefined,
): void {
  const backToStored = !stored?.reuse && tileFor(stored?.provider, stored?.baseUrl) === tile.id;
  form.tile = tile.id;
  form.provider = tile.provider;
  form.reuse = null;
  form.apiKey = '';
  form.baseUrl = backToStored ? (stored?.baseUrl ?? '') : (tile.baseUrl ?? '');
  form.model = backToStored ? (stored?.model ?? '') : suggestedModel(tile.id, purpose);
  form.temperature = backToStored && stored?.temperature != null ? String(stored.temperature) : '';
}

const sameUrl = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().replace(/\/+$/, '') === (b ?? '').trim().replace(/\/+$/, '');

/**
 * Whether the stored key still applies to the form: the server sends a saved
 * key only to the provider and base URL it was saved for.
 */
export function storedKeyApplies(form: RoleForm, stored: AiRoleSettings | null | undefined): boolean {
  if (!stored?.hasApiKey || stored.reuse || form.reuse) return false;
  return stored.provider === form.provider && sameUrl(stored.baseUrl, form.baseUrl);
}

/** What a role's own connection still lacks before it can be saved or tested, or null. */
export function connectionProblem(form: RoleDraft, keyStored: boolean): string | null {
  const tile = providerTile(form.tile);
  if (!form.provider) return 'Choose a provider.';
  if (tile?.key === 'required' && !keyStored && !form.apiKey.trim()) return `${tile.label} needs an API key.`;
  if (form.provider === 'openai' && !form.baseUrl.trim()) return 'Enter the server address.';
  if (form.provider === 'openai' && !form.model.trim()) return 'Enter a model.';
  return null;
}

/**
 * Whether a role should be written on save. The diagnosis role is the required
 * root, so it's "configured" the moment a provider is chosen (it has no enable
 * toggle); every other role is opt-in via its feature switch.
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
