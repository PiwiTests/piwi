import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { getAppSetting, setAppSetting, deleteAppSetting } from '../../utils/app-settings';
import { encryptSecret, getEncryptionKey } from '../../utils/crypto';
import {
  AI_ROLES,
  storedRoles,
  readAiSettings,
  envAiLanguage,
  type RawStoredAi,
  type RawStoredRole,
} from '../../utils/ai-settings';
import { claudeCliEnabled } from '../../utils/ai-claude-cli';
import { codexCliEnabled } from '../../utils/ai-codex-cli';
import { deepseekCliEnabled } from '../../utils/ai-deepseek-cli';
import { storedKeyFor } from '../../utils/ai-provider';
import type { AiModelRole, AiProvider, SaveAiSettingsBody } from '~~/types/api';

defineRouteMeta({
  openAPI: {
    tags: ['Settings'],
    summary: 'Save AI settings',
    description:
      'Updates the per-role AI configuration (diagnosis, research, embedding, assistant), auto-diagnose toggle, custom instructions, and SCM token. Each role has its own provider/model/baseUrl/apiKey, or `reuse` to inherit another role. An `apiKey` or `scmToken` is encrypted at rest, so saving one answers HTTP 409 while `PIWI_SECRET_KEY` is unset. Requires `settings:manage` (administrators only). Env-managed conflict: when AI is configured via environment variables the environment is authoritative for provider, key, and base URL — those fields are ignored. Only per-role model and temperature overrides, and a role the environment leaves out that reuses one it sets, are applied (`roles: null` clears them). The response always reflects the effective configuration.',
    'x-required-permission': 'settings:manage',
  },
});

const VALID_PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'claude-cli', 'codex-cli', 'deepseek-cli'];

/** Parse and range-check a role's temperature override (OpenAI's documented 0-2 range). */
function parseTemperature(role: AiModelRole, value: number | null | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw apiError({ statusCode: 400, message: `Role "${role}": temperature must be a number between 0 and 2` });
  }
  return value;
}

export default eventHandler(async (event) => {
  await requireAuth(event);

  const runtimeConfig = useRuntimeConfig();
  const envAi = runtimeConfig.ai as { provider?: string } | undefined;

  const body = (await readBody(event)) as SaveAiSettingsBody;

  const db = await getDatabase();

  // Custom instructions and SCM token are stored independently of the provider config.
  if (body.customInstructions !== undefined) {
    const trimmed = body.customInstructions?.trim() || null;
    if (trimmed) await setAppSetting(db, 'ai_instructions', { value: trimmed });
    else await deleteAppSetting(db, 'ai_instructions');
  }

  // The response language is env-managed when PIWI_AI_LANGUAGE is set — ignore a
  // client attempt to override it then, the way the provider config is locked.
  if (body.language !== undefined && envAiLanguage() == null) {
    const trimmed = body.language?.trim() || null;
    if (trimmed) await setAppSetting(db, 'ai_language', { value: trimmed.slice(0, 60) });
    else await deleteAppSetting(db, 'ai_language');
  }

  if (body.scmToken !== undefined) {
    const trimmed = body.scmToken?.trim() || null;
    if (trimmed) await setAppSetting(db, 'scm_token', { value: encryptSecret(trimmed, getEncryptionKey()) });
    else await deleteAppSetting(db, 'scm_token');
  }

  // Only touch the provider config when the request actually carries it.
  const touchesAi = 'roles' in body || 'autoDiagnose' in body;
  if (touchesAi) {
    const existing = (await getAppSetting<RawStoredAi>(db, 'ai')) ?? {};
    const existingRoles = storedRoles(existing);
    const input = body.roles ?? {};

    // When env-managed, only model fields may be overridden.
    if (envAi?.provider) {
      if (body.roles === null) {
        // Allow clearing stored model overrides while keeping env config.
        await deleteAppSetting(db, 'ai');
        return readAiSettings(db);
      }

      const out: Partial<Record<AiModelRole, RawStoredRole>> = {};
      for (const role of AI_ROLES) {
        if (!(role in input)) {
          // Untouched role — preserve any existing override.
          const enc = existingRoles[role];
          if (enc && (enc.model || enc.reuse)) out[role] = { ...enc };
          continue;
        }
        const cfg = input[role];
        if (cfg == null) continue;
        const model = cfg.model?.trim() || undefined;
        const temperature = parseTemperature(role, cfg.temperature);
        const outRole: RawStoredRole = {};
        if (cfg.reuse) outRole.reuse = cfg.reuse;
        if (model) outRole.model = model;
        if (temperature !== undefined) outRole.temperature = temperature;
        if (outRole.reuse || outRole.model || outRole.temperature !== undefined) out[role] = outRole;
      }
      await setAppSetting(db, 'ai', { roles: out });
      return readAiSettings(db);
    }

    if (body.roles === null) {
      await deleteAppSetting(db, 'ai');
      return readAiSettings(db);
    }

    const resolveKey = (provided: string | null | undefined, existingEnc?: string): string | undefined => {
      if (provided === undefined) return existingEnc; // preserve
      if (provided === '' || provided === null) return undefined; // remove
      return encryptSecret(provided, getEncryptionKey());
    };

    const out: Partial<Record<AiModelRole, RawStoredRole>> = {};
    for (const role of AI_ROLES) {
      if (!(role in input)) {
        // Untouched role — keep whatever was stored.
        if (existingRoles[role]) out[role] = existingRoles[role];
        continue;
      }
      const cfg = input[role];
      if (cfg == null) continue; // explicit removal

      const temperature = parseTemperature(role, cfg.temperature);

      if (cfg.reuse) {
        if (cfg.reuse === role) throw apiError({ statusCode: 400, message: `Role "${role}" cannot reuse itself` });
        out[role] = {
          reuse: cfg.reuse,
          model: cfg.model?.trim() || '',
          ...(temperature !== undefined ? { temperature } : {}),
        };
        continue;
      }

      const provider = (cfg.provider || '') as AiProvider;
      if (!VALID_PROVIDERS.includes(provider)) {
        throw apiError({ statusCode: 400, message: `Role "${role}" has an invalid provider` });
      }
      // The local CLI provider only makes sense where a `claude` binary lives —
      // the desktop app (or a self-hoster who pinned PIWI_CLAUDE_CLI_PATH).
      if (provider === 'claude-cli' && !claudeCliEnabled()) {
        throw apiError({
          statusCode: 400,
          message: `Role "${role}": the local Claude CLI is only available in the Piwi desktop app, or on a server with PIWI_CLAUDE_CLI_PATH set`,
        });
      }
      if (provider === 'codex-cli' && !codexCliEnabled()) {
        throw apiError({
          statusCode: 400,
          message: `Role "${role}": enable Codex in the desktop app or set PIWI_CODEX_CLI_PATH on the server`,
        });
      }
      if (provider === 'deepseek-cli' && !deepseekCliEnabled())
        throw apiError({
          statusCode: 400,
          message: `Role "${role}": enable official DeepSeek Harness in the desktop app or set PIWI_DEEPSEEK_CLI_PATH`,
        });
      const localCli = provider === 'claude-cli' || provider === 'codex-cli' || provider === 'deepseek-cli';
      const model = cfg.model?.trim() || '';
      const baseUrl = cfg.baseUrl?.trim() || '';
      if (provider === 'openai' && (!baseUrl || !model)) {
        throw apiError({
          statusCode: 400,
          message: `Role "${role}": OpenAI-compatible provider requires baseUrl and model`,
        });
      }
      // A stored key is kept only for the provider and base URL it was saved for;
      // pointing the role elsewhere needs the key entered again.
      const existing = existingRoles[role];
      if (
        !localCli &&
        cfg.apiKey === undefined &&
        existing?.apiKey &&
        !storedKeyFor({ ...existing, apiKey: 'stored' }, provider, baseUrl)
      ) {
        throw apiError({
          statusCode: 400,
          message: `Role "${role}": enter the API key again. A saved key is only sent to the provider and base URL it was saved for.`,
        });
      }
      // claude-cli carries no key or base URL — the CLI owns auth and endpoint.
      const apiKey = localCli ? undefined : resolveKey(cfg.apiKey, existing?.apiKey);
      out[role] = {
        provider,
        model,
        baseUrl: localCli ? '' : baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      };
    }

    // The diagnosis role is the required root and cannot reuse another role.
    if (!out.diagnosis || out.diagnosis.reuse) {
      throw apiError({ statusCode: 400, message: 'A diagnosis role with its own provider is required' });
    }

    // Embeddings need an OpenAI-compatible endpoint — Anthropic has no
    // embeddings API, so reject configs that would only fail at run time.
    if (out.embedding) {
      let cfg: RawStoredRole | undefined = out.embedding;
      for (let hops = 0; cfg?.reuse && hops < AI_ROLES.length; hops++) cfg = out[cfg.reuse];
      if (cfg?.provider !== 'openai') {
        throw apiError({
          statusCode: 400,
          message: 'The embedding role requires an OpenAI-compatible provider (Anthropic has no embeddings API)',
        });
      }
    }

    const autoDiagnose = 'autoDiagnose' in body ? Boolean(body.autoDiagnose) : Boolean(existing.autoDiagnose);
    await setAppSetting(db, 'ai', { autoDiagnose, roles: out });
  }

  return readAiSettings(db);
});
