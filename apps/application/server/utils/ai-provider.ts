import Anthropic from '@anthropic-ai/sdk';
import { getAppSetting } from './app-settings';
import { callClaudeCli, streamClaudeCli } from './ai-claude-cli';
import { decryptSecret, getEncryptionKey } from './crypto';
import { overlayStoredRoles, rolesFromLegacy, storedRoles, type RawStoredAi, type RawStoredRole } from './ai-settings';
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
  if (role.provider === 'anthropic') return Boolean(role.apiKey);
  if (role.provider === 'openai') return Boolean(role.baseUrl && role.model);
  // claude-cli needs no key, base URL or model (the CLI supplies its own default model).
  if (role.provider === 'claude-cli') return true;
  return false;
}

/** Build a resolved role from raw (already-decrypted) values, or null if incomplete/invalid. */
function makeRole(
  provider?: string | null,
  apiKey?: string | null,
  model?: string | null,
  baseUrl?: string | null,
  kind: RoleKind = 'chat',
  temperature?: number | null,
): ResolvedAiRole | null {
  const p = (provider || '') as AiProvider;
  if (p !== 'anthropic' && p !== 'openai' && p !== 'claude-cli') return null;
  const role: ResolvedAiRole = {
    provider: p,
    apiKey: apiKey || '',
    model: model || '',
    baseUrl: baseUrl || null,
    temperature: temperature ?? null,
  };
  return isValidRole(role, kind) ? role : null;
}

const ROLE_ORDER: AiModelRole[] = ['diagnosis', 'research', 'embedding'];

/**
 * Resolve a role map, following `reuse` links. `readKey` turns each role's
 * `apiKey` into the key to send: stored keys are decrypted, env keys are plain.
 */
function resolveRoles(
  roles: Partial<Record<AiModelRole, RawStoredRole>>,
  readKey: (key?: string) => string = (enc) => (enc ? decryptSecret(enc, getEncryptionKey()) : ''),
): AiConfig['roles'] {
  const out: Record<AiModelRole, ResolvedAiRole | null> = { diagnosis: null, research: null, embedding: null };

  for (const role of ROLE_ORDER) {
    const kind: RoleKind = role === 'embedding' ? 'embedding' : 'chat';
    const cfg = roles[role];
    if (!cfg) continue;
    if (cfg.reuse && out[cfg.reuse]) {
      const base = out[cfg.reuse]!;
      out[role] = makeRole(base.provider, base.apiKey, cfg.model || base.model, base.baseUrl, kind, cfg.temperature);
    } else {
      out[role] = makeRole(cfg.provider, readKey(cfg.apiKey), cfg.model, cfg.baseUrl, kind, cfg.temperature);
    }
  }

  return { diagnosis: out.diagnosis!, research: out.research, embedding: out.embedding };
}

/**
 * Assemble the full AiConfig from a resolved diagnosis role plus optional
 * research/embedding roles. Returns null when the diagnosis role is unusable.
 */
function assembleConfig(
  diagnosis: ResolvedAiRole | null,
  research: ResolvedAiRole | null,
  embedding: ResolvedAiRole | null,
  autoDiagnose: boolean,
  source: 'env' | 'settings',
): AiConfig | null {
  if (!diagnosis) return null;
  return {
    provider: diagnosis.provider,
    apiKey: diagnosis.apiKey,
    model: diagnosis.model,
    baseUrl: diagnosis.baseUrl,
    temperature: diagnosis.temperature,
    autoDiagnose,
    source,
    roles: { diagnosis, research, embedding },
  };
}

/**
 * The AI configuration every call uses: the roles the `PIWI_AI_*` variables
 * define, with the per-role settings saved in Settings → AI laid over them, when
 * the environment manages AI; otherwise the roles saved in Settings. Both read
 * their role map through `rolesFromLegacy` / `storedRoles`, as Settings shows it.
 */
export async function resolveAiConfig(db: DbClient): Promise<AiConfig | null> {
  const envAi = useRuntimeConfig().ai as
    | (Parameters<typeof rolesFromLegacy>[0] & { autoDiagnose?: boolean | string })
    | undefined;
  const stored = await getAppSetting<RawStoredAi>(db, 'ai');

  if (envAi?.provider) {
    // Environment keys are plain text; stored ones are decrypted.
    const roles = resolveRoles(overlayStoredRoles(rolesFromLegacy(envAi), stored), (key) => key ?? '');
    return assembleConfig(
      roles.diagnosis,
      roles.research,
      roles.embedding,
      String(envAi.autoDiagnose) === 'true',
      'env',
    );
  }

  if (!stored) return null;
  const roles = resolveRoles(storedRoles(stored));
  return assembleConfig(roles.diagnosis, roles.research, roles.embedding, Boolean(stored.autoDiagnose), 'settings');
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

/** Resolved config for a given role, or null when that role is unconfigured. */
export function resolveAiRole(config: AiConfig, role: AiModelRole): ResolvedAiRole | null {
  return config.roles[role];
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
  try {
    if (config.provider === 'anthropic') {
      return await callAnthropic(config, opts);
    }
    if (config.provider === 'claude-cli') {
      return await callClaudeCli(config, opts);
    }
    return await callOpenAiCompat(config, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[${config.provider}] ${msg.slice(0, 500)}`, { cause: err });
  }
}

function anthropicClient(config: ResolvedAiRole): Anthropic {
  return new Anthropic({
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
  return err instanceof Anthropic.BadRequestError && /thinking|effort/i.test(err.message);
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
  const client = anthropicClient(config);

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
        ...opts.images.map(
          (img): OAIPart => ({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          }),
        ),
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
async function postOpenAiWithFallbacks(
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
  try {
    if (config.provider === 'anthropic') {
      yield* streamAnthropic(config, opts);
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
  const client = anthropicClient(config);

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
