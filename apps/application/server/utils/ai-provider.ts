import type Anthropic from '@anthropic-ai/sdk';
import { getAppSetting } from './app-settings';
import { callClaudeCli, streamClaudeCli } from './ai-claude-cli';
import { callCodexCli, streamCodexCli } from './ai-codex-cli';
import { callDeepseekCli, streamDeepseekCli } from './ai-deepseek-cli';
import { decryptSecret, getEncryptionKey } from './crypto';
import { rolesFromLegacy, storedRoles, type RawStoredAi, type RawStoredRole } from './ai-settings';
import {
  aiEndpoint,
  aiRoleCredentialProblem,
  assertAiKey,
  envAiCredentialIds,
  envRoles,
  openAiKeys,
  type AiKeyScope,
} from './ai-credentials';
import { CredentialRefusedError, withCredential, type CredentialActor } from './credentials';
import type { AiProvider, AiConfig, AiModelRole, ResolvedAiRole } from '~~/types/api';
import type { DbClient } from '../database';

export type { AiConfig };

/** Default Anthropic model when none is configured. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

/** What a role is used for: embeddings need an OpenAI-compatible endpoint (Anthropic has no embeddings API). */
type RoleKind = 'chat' | 'embedding';

function isValidRole(role: ResolvedAiRole, kind: RoleKind): boolean {
  // Embeddings require an OpenAI-compatible endpoint; the CLI has no embeddings API.
  if (kind === 'embedding') return role.provider === 'openai' && Boolean(role.baseUrl && role.model);
  if (role.provider === 'anthropic') return Boolean(role.apiKey || role.credentialId != null);
  if (role.provider === 'openai') return Boolean(role.baseUrl && role.model);
  // claude-cli needs no key, base URL or model (the CLI supplies its own default model).
  if (role.provider === 'claude-cli' || role.provider === 'codex-cli' || role.provider === 'deepseek-cli') return true;
  return false;
}

/** Build a resolved role from its values and the credential its key is in, or null if incomplete/invalid. */
function makeRole(
  provider?: string | null,
  apiKey?: string | null,
  model?: string | null,
  baseUrl?: string | null,
  kind: RoleKind = 'chat',
  temperature?: number | null,
  credentialId: number | null = null,
): ResolvedAiRole | null {
  const p = (provider || '') as AiProvider;
  if (p !== 'anthropic' && p !== 'openai' && p !== 'claude-cli' && p !== 'codex-cli' && p !== 'deepseek-cli')
    return null;
  const role: ResolvedAiRole = {
    provider: p,
    apiKey: apiKey || '',
    ...(credentialId != null ? { credentialId } : {}),
    model: model || '',
    baseUrl: baseUrl || null,
    temperature: temperature ?? null,
  };
  return isValidRole(role, kind) ? role : null;
}

const ROLE_ORDER: AiModelRole[] = ['diagnosis', 'research', 'embedding', 'assistant'];

/**
 * Resolve a role map, following `reuse` links. `keyOf` gives each role the
 * credential its key is in, and a key not moved to the store yet, decrypted.
 */
function resolveRoles(
  roles: Partial<Record<AiModelRole, RawStoredRole>>,
  keyOf: (role: AiModelRole, cfg: RawStoredRole) => { credentialId: number | null; apiKey: string },
): AiConfig['roles'] {
  const out: Record<AiModelRole, ResolvedAiRole | null> = {
    diagnosis: null,
    research: null,
    embedding: null,
    assistant: null,
  };

  for (const role of ROLE_ORDER) {
    const kind: RoleKind = role === 'embedding' ? 'embedding' : 'chat';
    const cfg = roles[role];
    if (!cfg) continue;
    if (cfg.reuse && out[cfg.reuse]) {
      const base = out[cfg.reuse]!;
      out[role] = makeRole(
        base.provider,
        base.apiKey,
        cfg.model || base.model,
        base.baseUrl,
        kind,
        cfg.temperature,
        base.credentialId ?? null,
      );
    } else {
      const key = keyOf(role, cfg);
      out[role] = makeRole(cfg.provider, key.apiKey, cfg.model, cfg.baseUrl, kind, cfg.temperature, key.credentialId);
    }
  }

  return { diagnosis: out.diagnosis!, research: out.research, embedding: out.embedding, assistant: out.assistant };
}

/** A stored role's credential, or its key not moved to the store yet (the startup import left it), decrypted. */
function storedKeyOf(_role: AiModelRole, cfg: RawStoredRole): { credentialId: number | null; apiKey: string } {
  if (cfg.credentialId != null) return { credentialId: cfg.credentialId, apiKey: '' };
  return { credentialId: null, apiKey: cfg.apiKey ? decryptSecret(cfg.apiKey, getEncryptionKey()) : '' };
}

/**
 * Assemble the full AiConfig from the resolved roles. Returns null when the
 * diagnosis role is unusable.
 */
function assembleConfig(
  roles: Record<AiModelRole, ResolvedAiRole | null>,
  autoDiagnose: boolean,
  source: 'env' | 'settings',
): AiConfig | null {
  const { diagnosis, research, embedding, assistant } = roles;
  if (!diagnosis) return null;
  return {
    provider: diagnosis.provider,
    apiKey: diagnosis.apiKey,
    ...(diagnosis.credentialId != null ? { credentialId: diagnosis.credentialId } : {}),
    model: diagnosis.model,
    baseUrl: diagnosis.baseUrl,
    temperature: diagnosis.temperature,
    autoDiagnose,
    source,
    roles: { diagnosis, research, embedding, assistant },
  };
}

/**
 * The AI configuration every call uses: the roles the `PIWI_AI_*` variables
 * define, with the per-role settings saved in Settings → AI laid over them, when
 * the environment manages AI; otherwise the roles saved in Settings. Both read
 * their role map through `rolesFromLegacy` / `storedRoles`, as Settings shows it.
 *
 * Each role names the credential its key is in, and holds no key: `open` opens
 * them for a call to the model (`openAiKeys`, one counted use per credential,
 * on behalf of `actor`, for the `roles` the caller calls and the `projectId`
 * the calls serve), and only a caller that calls a model passes it.
 */
export async function resolveAiConfig(
  db: DbClient,
  options: { open?: boolean; actor?: CredentialActor } & AiKeyScope = {},
): Promise<AiConfig | null> {
  const envAi = useRuntimeConfig().ai as
    | (Parameters<typeof rolesFromLegacy>[0] & { autoDiagnose?: boolean | string })
    | undefined;
  const stored = await getAppSetting<RawStoredAi>(db, 'ai');

  let config: AiConfig | null;
  if (envAi?.provider) {
    const roles = envRoles(envAi, stored);
    const ids = await envAiCredentialIds(db, roles);
    config = assembleConfig(
      resolveRoles(roles, (role) => ({ credentialId: ids.get(role) ?? null, apiKey: '' })),
      String(envAi.autoDiagnose) === 'true',
      'env',
    );
  } else {
    config = stored
      ? assembleConfig(resolveRoles(storedRoles(stored), storedKeyOf), Boolean(stored.autoDiagnose), 'settings')
      : null;
  }
  if (!config || !options.open) return config;
  return openAiKeys(db, config, options.actor ?? { userId: null, apiKeyId: null }, options);
}

const endpointOf = (baseUrl: string | null | undefined) => (baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase();

/**
 * `stored`'s API key when `provider` and `baseUrl` name the endpoint it was saved
 * for, else ''. A stored or env-managed key is only ever sent to its own endpoint,
 * so a form that points elsewhere must carry its own key.
 */
export function storedKeyFor(
  stored: { provider?: string | null; baseUrl?: string | null; apiKey?: string | null } | null | undefined,
  provider: string | null | undefined,
  baseUrl: string | null | undefined,
): string {
  if (!stored?.apiKey || !provider || stored.provider !== provider) return '';
  return endpointOf(stored.baseUrl) === endpointOf(baseUrl) ? stored.apiKey : '';
}

/**
 * The key a request of the Settings → AI form (Test, the model list) sends for a role: the one typed; else the saved
 * credential the form picked, checked for the role's endpoint and opened as one counted read; else the stored key of
 * the role, then of the diagnosis role, each only for the provider and base URL it was saved for. `refusal` is why a
 * credential that applies was refused.
 */
export async function formAiKey(
  db: DbClient,
  input: {
    role: AiModelRole;
    provider: string;
    baseUrl: string | null | undefined;
    apiKey?: string;
    credentialId?: number;
    actor: CredentialActor;
  },
): Promise<{ key: string; refusal?: string }> {
  if (input.apiKey) return { key: input.apiKey };
  if (typeof input.credentialId === 'number') {
    const endpoint = aiEndpoint(input.provider, input.baseUrl);
    if (!endpoint) return { key: '', refusal: 'This provider takes no key.' };
    const problem = await aiRoleCredentialProblem(db, input.role, input.credentialId, endpoint);
    if (problem) return { key: '', refusal: problem };
    try {
      const key = await withCredential(
        db,
        {
          credentialId: input.credentialId,
          feature: 'ai-call',
          projectId: null,
          url: endpoint,
          custom: false,
          actor: input.actor,
        },
        async (credential) => credential.secret,
      );
      return { key };
    } catch (e) {
      if (e instanceof CredentialRefusedError) return { key: '', refusal: e.message };
      throw e;
    }
  }
  const resolved = await resolveAiConfig(db, { open: true, roles: [input.role, 'diagnosis'], actor: input.actor });
  for (const role of [resolved?.roles[input.role], resolved?.roles.diagnosis]) {
    if (!role || role.provider !== input.provider || endpointOf(role.baseUrl) !== endpointOf(input.baseUrl)) continue;
    if (role.refusal) return { key: '', refusal: role.refusal };
    if (role.apiKey) return { key: role.apiKey };
  }
  return { key: '' };
}

/** Resolved config for a given role, or null when that role is unconfigured. */
export function resolveAiRole(config: AiConfig, role: AiModelRole): ResolvedAiRole | null {
  return config.roles[role];
}

/** The model the assistant answers with: its own role when set, else the diagnosis role's provider, key and model. */
export function assistantRole(config: AiConfig): ResolvedAiRole {
  return config.roles.assistant ?? config.roles.diagnosis;
}

export interface AiAttachedImage {
  name: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string; // base64
}

export interface AiCallOptions {
  system: string;
  user: string;
  jsonSchema?: object;
  maxTokens?: number;
  images?: AiAttachedImage[];
  /**
   * Anthropic only: enable adaptive thinking (better diagnosis quality on
   * current Claude models). Ignored for OpenAI-compat providers; if the
   * configured model rejects it, the call is retried once without it.
   */
  adaptiveThinking?: boolean;
  /**
   * Anthropic only: output effort hint — 'low' keeps utility calls (research,
   * naming, adjudication) cheap. Same reject-then-retry behavior as
   * adaptiveThinking on models that don't support it.
   */
  effort?: 'low' | 'medium' | 'high';
  /** When true, mark the system prompt and stable context prefix for Anthropic cache_control. Re-runs become ~90 % cached input. */
  cacheControl?: boolean;
  /**
   * With `cacheControl`: how many characters at the start of `user` are stable
   * across re-runs (the built diagnosis context). The cache breakpoint sits at
   * the end of that prefix; the remainder (user-provided additional context,
   * research block) is sent as a separate uncached block so its variation
   * cannot invalidate the cached prefix. Defaults to the whole user text,
   * which only hits the cache on byte-identical re-runs.
   */
  stablePrefixChars?: number;
}

type AnthropicImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: AiAttachedImage['mediaType']; data: string };
};
type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/** System prompt param — one cache breakpoint when caching is on (it is identical across re-runs). */
function anthropicSystem(opts: AiCallOptions): Anthropic.Messages.MessageCreateParams['system'] {
  return opts.cacheControl ? [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }] : opts.system;
}

/**
 * User-message content. Without caching: optional image blocks followed by one
 * text block (or a bare string). With caching: images (stable across re-runs —
 * same screenshots for the same execution) precede the stable text block that
 * carries the cache breakpoint, so both are covered by the cached prefix; the
 * volatile tail of `user` (see `stablePrefixChars`) follows as its own
 * uncached block.
 */
function anthropicUserContent(opts: AiCallOptions): string | Array<AnthropicImageBlock | AnthropicTextBlock> {
  const imageBlocks: AnthropicImageBlock[] = (opts.images ?? []).map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));

  if (!opts.cacheControl) {
    return imageBlocks.length > 0 ? [...imageBlocks, { type: 'text', text: opts.user }] : opts.user;
  }

  const split = Math.max(0, Math.min(opts.stablePrefixChars ?? opts.user.length, opts.user.length));
  const stable = opts.user.slice(0, split);
  const volatileTail = opts.user.slice(split);

  const blocks: Array<AnthropicImageBlock | AnthropicTextBlock> = [...imageBlocks];
  if (stable) blocks.push({ type: 'text', text: stable, cache_control: { type: 'ephemeral' } });
  if (volatileTail) blocks.push({ type: 'text', text: volatileTail });
  if (blocks.length === 0) blocks.push({ type: 'text', text: opts.user });
  return blocks;
}

export interface AiCallResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Tokens written to the provider prompt cache (Anthropic), null when unknown. */
  cacheCreationInputTokens: number | null;
  /** Tokens served from the provider prompt cache (Anthropic `cache_read_input_tokens`, OpenAI `cached_tokens`). */
  cacheReadInputTokens: number | null;
  /** Dollar cost the provider reported for the call (the `claude-cli` provider only), else null. */
  costUsd?: number | null;
}

export interface StreamChunk {
  type: 'text' | 'done' | 'error';
  data: unknown;
}

export interface StreamResult {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  /** Dollar cost the provider reported for the call (the `claude-cli` provider only), else null. */
  costUsd?: number | null;
}

export async function callAiProvider(config: ResolvedAiRole, opts: AiCallOptions): Promise<AiCallResult> {
  assertAiKey(config);
  try {
    if (config.provider === 'anthropic') {
      return await callAnthropic(config, opts);
    }
    if (config.provider === 'deepseek-cli') return await callDeepseekCli(config, opts);
    if (config.provider === 'codex-cli') return await callCodexCli(config, opts);
    if (config.provider === 'claude-cli') {
      return await callClaudeCli(config, opts);
    }
    return await callOpenAiCompat(config, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[${config.provider}] ${msg.slice(0, 500)}`, { cause: err });
  }
}

/** The Anthropic SDK, loaded by the first Anthropic call. */
let anthropicSdk: typeof import('@anthropic-ai/sdk') | null = null;

export async function anthropicClient(config: ResolvedAiRole): Promise<Anthropic> {
  anthropicSdk ??= await import('@anthropic-ai/sdk');
  return new anthropicSdk.default({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
    timeout: 120_000,
    maxRetries: 1,
  });
}

/**
 * Request params for an Anthropic call. Prompt caching (when opts.cacheControl):
 * two breakpoints — the system prompt and the stable user prefix (images +
 * built context); the volatile tail (user additional context, research block)
 * is a separate uncached block. No sampling params: `temperature` & co. are
 * rejected by current Claude models (Opus 4.7+).
 *
 * `tuned` adds adaptive thinking / effort when requested; callers retry once
 * untuned when the configured model rejects those fields (older models).
 */
function buildAnthropicParams(
  config: ResolvedAiRole,
  opts: AiCallOptions,
  tuned: boolean,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const outputConfig: Record<string, unknown> = {};
  if (opts.jsonSchema) {
    outputConfig.format = { type: 'json_schema' as const, schema: opts.jsonSchema as { [key: string]: unknown } };
  }
  if (tuned && opts.effort) outputConfig.effort = opts.effort;

  return {
    model: config.model || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: opts.maxTokens ?? 8192,
    system: anthropicSystem(opts),
    messages: [{ role: 'user', content: anthropicUserContent(opts) as Anthropic.MessageParam['content'] }],
    ...(tuned && opts.adaptiveThinking ? { thinking: { type: 'adaptive' } } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  } as Anthropic.Messages.MessageCreateParamsNonStreaming;
}

function wantsTuning(opts: AiCallOptions): boolean {
  return Boolean(opts.adaptiveThinking || opts.effort);
}

/** 400 from a model that doesn't support the thinking/effort params — retry untuned. */
function isTuningRejection(err: unknown): boolean {
  return !!anthropicSdk && err instanceof anthropicSdk.default.BadRequestError && /thinking|effort/i.test(err.message);
}

/** Throw a clear error for terminal stop reasons shared by the sync and streaming paths. */
function checkAnthropicStopReason(msg: Anthropic.Message, opts: AiCallOptions): void {
  if (msg.stop_reason === 'refusal') {
    throw new Error('The model declined to analyze this failure');
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new Error(`Model output was truncated at ${opts.maxTokens ?? 8192} tokens — raise the max token limit`);
  }
}

async function callAnthropic(config: ResolvedAiRole, opts: AiCallOptions): Promise<AiCallResult> {
  const client = await anthropicClient(config);

  let res: Anthropic.Message;
  try {
    res = await client.messages.create(buildAnthropicParams(config, opts, true));
  } catch (err) {
    if (!wantsTuning(opts) || !isTuningRejection(err)) throw err;
    res = await client.messages.create(buildAnthropicParams(config, opts, false));
  }

  checkAnthropicStopReason(res, opts);

  const text = res.content.find((b) => b.type === 'text')?.text ?? '';
  return {
    text,
    model: res.model,
    inputTokens: res.usage.input_tokens ?? null,
    outputTokens: res.usage.output_tokens ?? null,
    cacheCreationInputTokens: res.usage.cache_creation_input_tokens ?? null,
    cacheReadInputTokens: res.usage.cache_read_input_tokens ?? null,
  };
}

type OAIPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

function openAiUserContent(opts: AiCallOptions, attempt: OpenAiAttempt): string | OAIPart[] {
  return attempt.withImages && opts.images?.length
    ? [
        ...opts.images.map((img): OAIPart => ({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.data}` },
        })),
        { type: 'text', text: opts.user },
      ]
    : opts.user;
}

/** Which rungs of the OpenAI-compatibility ladder this request body still uses. */
export interface OpenAiAttempt {
  /** Enforce the JSON schema with `response_format: json_schema` rather than `json_object`. */
  strictFormat: boolean;
  /** Send `opts.images` as `image_url` parts. */
  withImages: boolean;
  /** Parameter name accepted by the OpenAI-compatible provider for the output limit. */
  completionTokenParameter: 'max_tokens' | 'max_completion_tokens';
}

/**
 * Base chat-completions body. The JSON schema is enforced with
 * `response_format: json_schema` where the server supports it; callers step down
 * to the older `json_object` mode on HTTP 400. The schema also stays inlined in
 * the system prompt so servers that ignore response_format still see it.
 *
 * `temperature` is omitted entirely unless explicitly configured — reasoning
 * models (o1/o3/GPT-5-class) reject any explicit value other than their
 * default (1), so leaving it unset is the only value that works everywhere.
 */
export function buildOpenAiBody(
  config: ResolvedAiRole,
  opts: AiCallOptions,
  attempt: OpenAiAttempt,
): Record<string, unknown> {
  const systemContent = opts.jsonSchema
    ? `${opts.system}\n\nRespond ONLY with a JSON object matching this schema:\n${JSON.stringify(opts.jsonSchema)}`
    : opts.system;

  const responseFormat = opts.jsonSchema
    ? attempt.strictFormat
      ? { type: 'json_schema', json_schema: { name: 'response', schema: opts.jsonSchema } }
      : { type: 'json_object' }
    : undefined;

  return {
    model: config.model,
    [attempt.completionTokenParameter]: opts.maxTokens ?? 8192,
    ...(config.temperature != null ? { temperature: config.temperature } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: openAiUserContent(opts, attempt) },
    ],
  };
}

/** A rejection from a text-only model handed `image_url` parts. */
function rejectsImages(status: number, body: string): boolean {
  return status === 400 && /image|vision/i.test(body);
}

function rejectsMaxTokens(status: number, body: string, attempt: OpenAiAttempt): boolean {
  return (
    status === 400 &&
    attempt.completionTokenParameter === 'max_tokens' &&
    /max_tokens/i.test(body) &&
    /max_completion_tokens/i.test(body)
  );
}

/**
 * POST the chat-completions body, stepping down the compatibility ladder when
 * the server refuses a rung: `image_url` parts are dropped for a model with no
 * vision (its text context still carries the failure evidence), and
 * `response_format: json_schema` falls back to `json_object` for servers that
 * only know the older mode. Returns the last response, plus its body whenever
 * that response failed (an ok response is left unread for the caller).
 */
export async function postOpenAiWithFallbacks(
  send: (attempt: OpenAiAttempt) => Promise<Response>,
  opts: AiCallOptions,
  model: string,
): Promise<{ res: Response; errorBody: string }> {
  const attempt: OpenAiAttempt = {
    strictFormat: true,
    withImages: true,
    completionTokenParameter: 'max_tokens',
  };
  const sendAttempt = async (): Promise<{ res: Response; errorBody: string }> => {
    const res = await send(attempt);
    return { res, errorBody: res.ok ? '' : await res.text().catch(() => '') };
  };

  let { res, errorBody } = await sendAttempt();
  for (let retry = 0; retry < 3 && !res.ok; retry++) {
    let retryWithUpdatedAttempt = false;

    if (opts.images?.length && attempt.withImages && rejectsImages(res.status, errorBody)) {
      console.warn(`[ai-provider] ${model} rejected the attached image(s) — retrying text-only`);
      attempt.withImages = false;
      retryWithUpdatedAttempt = true;
    }

    if (!retryWithUpdatedAttempt && rejectsMaxTokens(res.status, errorBody, attempt)) {
      console.warn(`[ai-provider] ${model} requires max_completion_tokens — retrying with that parameter`);
      attempt.completionTokenParameter = 'max_completion_tokens';
      retryWithUpdatedAttempt = true;
    }

    if (!retryWithUpdatedAttempt && res.status === 400 && opts.jsonSchema && attempt.strictFormat) {
      attempt.strictFormat = false;
      retryWithUpdatedAttempt = true;
    }

    if (!retryWithUpdatedAttempt) break;
    ({ res, errorBody } = await sendAttempt());
  }

  return { res, errorBody };
}

async function callOpenAiCompat(config: ResolvedAiRole, opts: AiCallOptions): Promise<AiCallResult> {
  const baseUrl = (config.baseUrl || '').replace(/\/$/, '');
  const url = `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`;

  const { res, errorBody } = await postOpenAiWithFallbacks(
    (attempt) =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildOpenAiBody(config, opts, attempt)),
        signal: AbortSignal.timeout(120_000),
      }),
    opts,
    config.model,
  );

  if (!res.ok) {
    throw new Error(`openai provider returned HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string }; finish_reason?: string }>;
    model?: string;
    usage?: OAIUsage;
  };

  if (data.choices?.[0]?.finish_reason === 'length') {
    throw new Error(`Model output was truncated at ${opts.maxTokens ?? 8192} tokens — raise the max token limit`);
  }

  const text = data.choices?.[0]?.message?.content ?? '';
  return {
    text,
    model: data.model || config.model,
    inputTokens: data.usage?.prompt_tokens ?? null,
    outputTokens: data.usage?.completion_tokens ?? null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? null,
  };
}

/**
 * Streaming variant of callAiProvider. Yields text tokens as they arrive from
 * the model, then a final `'done'` chunk with token counts.
 */
export async function* streamAiProvider(config: ResolvedAiRole, opts: AiCallOptions): AsyncGenerator<StreamChunk> {
  assertAiKey(config);
  try {
    if (config.provider === 'anthropic') {
      yield* streamAnthropic(config, opts);
    } else if (config.provider === 'deepseek-cli') {
      yield* streamDeepseekCli(config, opts);
    } else if (config.provider === 'codex-cli') {
      yield* streamCodexCli(config, opts);
    } else if (config.provider === 'claude-cli') {
      yield* streamClaudeCli(config, opts);
    } else {
      yield* streamOpenAiCompat(config, opts);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: 'error', data: msg };
  }
}

/** Yield the text deltas of one Anthropic message stream. */
async function* anthropicTextDeltas(stream: ReturnType<Anthropic['messages']['stream']>): AsyncGenerator<string> {
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

async function* streamAnthropic(config: ResolvedAiRole, opts: AiCallOptions): AsyncGenerator<StreamChunk> {
  const client = await anthropicClient(config);

  // Same params/caching layout as callAnthropic. A tuning rejection surfaces
  // on the first iteration, before any delta arrives, so the untuned retry
  // never duplicates already-yielded text.
  let stream = client.messages.stream(buildAnthropicParams(config, opts, true));
  try {
    for await (const text of anthropicTextDeltas(stream)) {
      yield { type: 'text', data: text };
    }
  } catch (err) {
    if (!wantsTuning(opts) || !isTuningRejection(err)) throw err;
    stream = client.messages.stream(buildAnthropicParams(config, opts, false));
    for await (const text of anthropicTextDeltas(stream)) {
      yield { type: 'text', data: text };
    }
  }

  const msg = await stream.finalMessage();

  if (msg.stop_reason === 'refusal') {
    yield { type: 'error', data: 'The model declined to analyze this failure' };
    return;
  }
  if (msg.stop_reason === 'max_tokens') {
    yield {
      type: 'error',
      data: `Model output was truncated at ${opts.maxTokens ?? 8192} tokens — raise the max token limit`,
    };
    return;
  }

  yield {
    type: 'done',
    data: {
      model: msg.model,
      inputTokens: msg.usage?.input_tokens ?? null,
      outputTokens: msg.usage?.output_tokens ?? null,
      cacheCreationInputTokens: msg.usage?.cache_creation_input_tokens ?? null,
      cacheReadInputTokens: msg.usage?.cache_read_input_tokens ?? null,
    } as StreamResult,
  };
}

async function* streamOpenAiCompat(config: ResolvedAiRole, opts: AiCallOptions): AsyncGenerator<StreamChunk> {
  const baseUrl = (config.baseUrl || '').replace(/\/$/, '');
  const url = `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

  const post = (attempt: OpenAiAttempt) =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...buildOpenAiBody(config, opts, attempt),
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });

  try {
    const { res, errorBody } = await postOpenAiWithFallbacks(post, opts, config.model);

    if (!res.ok) {
      throw new Error(`openai provider returned HTTP ${res.status}: ${errorBody.slice(0, 300)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('Response body is not readable');

    const decoder = new TextDecoder();
    let buffer = '';
    let modelName = config.model;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cachedTokens: number | null = null;
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
            model?: string;
            usage?: OAIUsage;
            x_groq?: { usage?: OAIUsage };
          };

          if (parsed.model) modelName = parsed.model;

          // Groq reports a stream's usage under `x_groq.usage`, not `usage`.
          const usage = parsed.usage ?? parsed.x_groq?.usage;
          if (usage) {
            if (usage.prompt_tokens != null) inputTokens = usage.prompt_tokens;
            if (usage.completion_tokens != null) outputTokens = usage.completion_tokens;
            const cached = (usage as OAIUsage).prompt_tokens_details?.cached_tokens;
            if (cached != null) cachedTokens = cached;
          }

          const choice = parsed.choices?.[0];
          if (choice?.finish_reason === 'length') truncated = true;
          if (choice?.delta?.content) {
            yield { type: 'text', data: choice.delta.content };
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    if (truncated) {
      yield {
        type: 'error',
        data: `Model output was truncated at ${opts.maxTokens ?? 8192} tokens — raise the max token limit`,
      };
      return;
    }

    yield {
      type: 'done',
      data: {
        model: modelName,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: cachedTokens,
      } as StreamResult,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
