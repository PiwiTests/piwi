import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { getAppSetting, setAppSetting, deleteAppSetting } from '../../utils/app-settings';
import { INSTANCE_SCM_CREDENTIALS_SETTING, instanceScmCredentialsProblem } from '#shared/handlers/credentials';
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
import { aiEndpoint, aiRoleCredentialProblem, saveAiRoleKey } from '../../utils/ai-credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Settings'],
    summary: 'Save AI settings',
    description:
      'Updates the per-role AI configuration (diagnosis, research, embedding, assistant), auto-diagnose toggle, custom instructions, and the SCM credentials of the instance (`scmCredentialIds`: credentials of the source control service shared with all projects; an empty list clears them). Each role has its own provider/model/baseUrl and key, or `reuse` to inherit another role. A typed `apiKey` is saved as a credential of the `ai` service bound to the endpoint of the role (it rotates the credential the role names while nothing else names it, else makes one shared with all projects), so saving one answers HTTP 409 while `PIWI_SECRET_KEY` is unset; `credentialId` names a saved credential instead, which must be shared with all projects and sent under the endpoint of the role; `null` for either removes the key of the role. A role that keeps its credential while its provider or base URL moves outside the destination of the credential answers 400. Requires `settings:manage` (administrators only). Env-managed conflict: when AI is configured via environment variables the environment is authoritative for provider, key, and base URL — those fields are ignored. Only per-role model and temperature overrides, and a role the environment leaves out that reuses one it sets, are applied (`roles: null` clears them). The response always reflects the effective configuration.',
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
  const user = await requireAuth(event);

  const runtimeConfig = useRuntimeConfig();
  const envAi = runtimeConfig.ai as { provider?: string } | undefined;

  const body = (await readBody(event)) as SaveAiSettingsBody;

  const db = await getDatabase();

  // The SCM fields are checked before anything is written.
  if ((body as { scmToken?: unknown }).scmToken !== undefined) {
    throw apiError({
      statusCode: 400,
      message:
        'An SCM token is saved as a credential (Settings → Credentials), then listed here with scmCredentialIds.',
    });
  }
  let scmCredentialIds: number[] | undefined;
  if (body.scmCredentialIds !== undefined) {
    const raw = body.scmCredentialIds ?? [];
    if (!Array.isArray(raw) || raw.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw apiError({ statusCode: 400, message: 'scmCredentialIds is a list of credential ids.' });
    }
    scmCredentialIds = [...new Set(raw)];
    const problem = await instanceScmCredentialsProblem(db, scmCredentialIds);
    if (problem) throw apiError({ statusCode: 400, message: problem });
  }

  // Custom instructions and the SCM credentials are stored independently of the provider config.
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

  if (scmCredentialIds !== undefined) {
    if (scmCredentialIds.length > 0)
      await setAppSetting(db, INSTANCE_SCM_CREDENTIALS_SETTING, { ids: scmCredentialIds });
    else await deleteAppSetting(db, INSTANCE_SCM_CREDENTIALS_SETTING);
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

    /** The keys typed for roles, saved as credentials once the whole body passed its checks. */
    const typedKeys: Array<{ role: AiModelRole; endpoint: string; key: string; credentialId: number | null }> = [];

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
      const existing = existingRoles[role];
      // A local CLI carries no key or base URL: the CLI owns auth and endpoint.
      let credentialId: number | undefined;
      let legacyKey: string | undefined;
      const endpoint = localCli ? null : aiEndpoint(provider, baseUrl);
      if (endpoint) {
        const typed = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
        if (typed) {
          if (typeof cfg.credentialId === 'number') {
            const problem = await aiRoleCredentialProblem(db, role, cfg.credentialId, endpoint);
            if (problem) throw apiError({ statusCode: 400, message: problem });
          }
          // Saved below, once the whole body passed its checks: it rotates the role's own credential, else makes one.
          typedKeys.push({
            role,
            endpoint,
            key: typed,
            credentialId: cfg.credentialId ?? existing?.credentialId ?? null,
          });
        } else if (cfg.apiKey === null || cfg.apiKey === '' || cfg.credentialId === null) {
          credentialId = undefined;
        } else if (typeof cfg.credentialId === 'number') {
          const problem = await aiRoleCredentialProblem(db, role, cfg.credentialId, endpoint);
          if (problem) throw apiError({ statusCode: 400, message: problem });
          credentialId = cfg.credentialId;
        } else if (existing?.credentialId != null) {
          // The credential the role names is sent only under its destination: another endpoint needs another key.
          if (await aiRoleCredentialProblem(db, role, existing.credentialId, endpoint)) {
            throw apiError({
              statusCode: 400,
              message: `Role "${role}": enter the API key again, or pick another credential. A saved key is only sent to the provider and base URL it was saved for.`,
            });
          }
          credentialId = existing.credentialId;
        } else if (existing?.apiKey) {
          if (!storedKeyFor({ ...existing, apiKey: 'stored' }, provider, baseUrl)) {
            throw apiError({
              statusCode: 400,
              message: `Role "${role}": enter the API key again. A saved key is only sent to the provider and base URL it was saved for.`,
            });
          }
          legacyKey = existing.apiKey;
        }
      }
      out[role] = {
        provider,
        model,
        baseUrl: localCli ? '' : baseUrl,
        ...(credentialId != null ? { credentialId } : {}),
        ...(legacyKey ? { apiKey: legacyKey } : {}),
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

    for (const typed of typedKeys) {
      const id = await saveAiRoleKey(db, { ...typed, createdBy: user.id || null });
      out[typed.role] = { ...out[typed.role], credentialId: id };
    }

    const autoDiagnose = 'autoDiagnose' in body ? Boolean(body.autoDiagnose) : Boolean(existing.autoDiagnose);
    await setAppSetting(db, 'ai', { autoDiagnose, roles: out });
  }

  return readAiSettings(db);
});
