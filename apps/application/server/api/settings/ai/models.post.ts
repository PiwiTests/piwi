import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { resolveAiConfig, storedKeyFor } from '../../../utils/ai-provider';
import { CLAUDE_CLI_MODELS } from '../../../utils/claude-cli-models';
import { AI_ROLES } from '../../../utils/ai-settings';
import type { AiModelRole, ModelInfo } from '~~/types/api';

/** Convert per-token pricing string to per-million-tokens, keeping larger values as-is. */
function normalizePricing(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) return v;
  // Per-token values (OpenRouter, most providers) are tiny decimals like 0.000003.
  // Per-M values are like 2.50. Threshold at 0.01 to distinguish.
  if (n < 0.01) {
    const perM = n * 1_000_000;
    return perM % 1 === 0 ? String(Math.round(perM)) : perM.toFixed(2);
  }
  return String(n);
}

function modalityList(arch: {
  input_modalities?: string[];
  output_modalities?: string[];
  modality?: string | null;
}): string[] {
  const ins = arch.input_modalities?.filter(Boolean) ?? [];
  const outs = arch.output_modalities?.filter(Boolean) ?? [];
  if (ins.length && outs.length) {
    return [`${ins.join('+')}→${outs.join('+')}`];
  }
  if (arch.modality) return [arch.modality];
  return [];
}

defineRouteMeta({
  openAPI: {
    tags: ['Settings'],
    summary: 'List available models from an AI provider',
    description:
      "Calls the provider's models endpoint to return available models with metadata. Accepts provider, baseUrl, apiKey, and role in the request body; when apiKey is omitted, the saved key for that role (then the diagnosis role) is used, only if provider and baseUrl match the ones it was saved for. Requires `settings:manage` (administrators only).",
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);

  const body = await readBody<{
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    role?: string;
  }>(event).catch(() => null);

  const { provider, baseUrl } = body || {};

  // The local CLI has no models endpoint. Offer the family aliases (always the
  // latest of each) followed by every pinned version, so the picker can list
  // them all; the CLI resolves whichever the user's subscription grants (and any
  // free-typed string still works). Pricing mirrors the per-1M rates the CLI
  // reports as cost, whether or not the account is billed per token.
  if (provider === 'codex-cli') return { models: [] };
  if (provider === 'claude-cli') {
    return { models: CLAUDE_CLI_MODELS };
  }

  // The form clears key fields after save, so listing models for a saved
  // config must fall back to the stored (decrypted) or env-managed key, but only
  // for the provider and base URL that key was saved for.
  let apiKey = body?.apiKey;
  if (!apiKey) {
    const role: AiModelRole = AI_ROLES.includes(body?.role as AiModelRole) ? (body!.role as AiModelRole) : 'diagnosis';
    const resolved = await resolveAiConfig(await getDatabase());
    apiKey =
      storedKeyFor(resolved?.roles[role], provider, baseUrl) ||
      storedKeyFor(resolved?.roles.diagnosis, provider, baseUrl) ||
      undefined;
  }

  if (provider === 'openai') {
    if (!baseUrl) return { models: [] };
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { models: [] };

      // OpenAI-compatible: { data: [{ id, owned_by, context_length?, ... }] }
      // OpenRouter:        { data: [{ id, name, description, context_length, pricing, architecture, ... }] }
      type RawArch = {
        input_modalities?: string[];
        output_modalities?: string[];
        modality?: string | null;
      };
      type RawModel = {
        id: string;
        name?: string;
        owned_by?: string;
        context_length?: number;
        description?: string;
        pricing?: { prompt?: string; completion?: string };
        architecture?: RawArch;
        top_provider?: { context_length?: number; max_completion_tokens?: number };
        per_request_limits?: { completion_tokens?: number; prompt_tokens?: number };
      };

      const data = (await res.json()) as { data?: RawModel[] };
      const models: ModelInfo[] = (data.data ?? [])
        .map((m) => ({
          id: m.id,
          label: m.name || m.owned_by,
          ownedBy: m.owned_by,
          contextLength: m.context_length ?? m.top_provider?.context_length ?? undefined,
          maxTokens: m.top_provider?.max_completion_tokens ?? m.per_request_limits?.completion_tokens ?? undefined,
          description: m.description,
          pricing: m.pricing
            ? { prompt: normalizePricing(m.pricing.prompt), completion: normalizePricing(m.pricing.completion) }
            : undefined,
          modalities: m.architecture ? modalityList(m.architecture) : undefined,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models };
    } catch {
      return { models: [] };
    }
  }

  if (provider === 'anthropic') {
    if (!apiKey) return { models: [] };
    // Honour a configured baseUrl (proxy override) like the diagnosis calls do.
    const root = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    try {
      const res = await fetch(`${root}/v1/models`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { models: [] };
      type AnthropicCapability = { supported: boolean };
      type RawAnthropicModel = {
        type: string;
        id: string;
        display_name?: string;
        created_at?: string;
        max_input_tokens?: number;
        max_tokens?: number;
        capabilities?: {
          image_input?: AnthropicCapability;
          pdf_input?: AnthropicCapability;
          code_execution?: AnthropicCapability;
          thinking?: AnthropicCapability;
          structured_outputs?: AnthropicCapability;
        };
      };

      const data = (await res.json()) as { data?: RawAnthropicModel[] };
      const models: ModelInfo[] = (data.data ?? [])
        .map((m) => {
          const caps: string[] = [];
          if (m.capabilities?.image_input?.supported) caps.push('image');
          if (m.capabilities?.pdf_input?.supported) caps.push('pdf');
          if (m.capabilities?.code_execution?.supported) caps.push('code');
          if (m.capabilities?.thinking?.supported) caps.push('thinking');
          if (m.capabilities?.structured_outputs?.supported) caps.push('json');

          return {
            id: m.id,
            label: m.display_name,
            contextLength: m.max_input_tokens || undefined,
            maxTokens: m.max_tokens || undefined,
            modalities: caps.length ? caps : undefined,
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models };
    } catch {
      return { models: [] };
    }
  }

  return { models: [] };
});
