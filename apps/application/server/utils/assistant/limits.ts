/**
 * The assistant's limits: per question (tool calls, output tokens per model
 * call, wall-clock time) and per 24 hours (tokens per user and for the
 * instance). Each has a `PIWI_AI_ASSISTANT_*` variable, parsed and clamped
 * like the AI-step limits; `0` turns a daily cap off.
 */

export const DEFAULT_ASSISTANT_MAX_TOOL_CALLS = 8;
export const DEFAULT_ASSISTANT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_ASSISTANT_TURN_TIMEOUT_SECONDS = 180;
export const DEFAULT_ASSISTANT_DAILY_TOKENS_PER_USER = 1_000_000;
export const DEFAULT_ASSISTANT_DAILY_TOKENS = 5_000_000;

const TOOL_CALLS_RANGE = { min: 1, max: 30 };
const OUTPUT_TOKENS_RANGE = { min: 256, max: 16_384 };
const TIMEOUT_SECONDS_RANGE = { min: 15, max: 900 };
const DAILY_TOKENS_RANGE = { min: 0, max: 1_000_000_000 };

export interface AssistantLimits {
  maxToolCalls: number;
  maxOutputTokens: number;
  turnTimeoutMs: number;
  /** Tokens one user may spend in 24 hours; null when uncapped. */
  dailyTokensPerUser: number | null;
  /** Tokens the instance may spend in 24 hours; null when uncapped. */
  dailyTokens: number | null;
}

function clampEnvInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.floor(n)));
}

/** The effective limits: the defaults, overridden by the env vars (clamped). */
export function resolveAssistantLimits(env: NodeJS.ProcessEnv = process.env): AssistantLimits {
  const cap = (n: number) => (n > 0 ? n : null);
  return {
    maxToolCalls: clampEnvInt(
      env,
      'PIWI_AI_ASSISTANT_MAX_TOOL_CALLS',
      DEFAULT_ASSISTANT_MAX_TOOL_CALLS,
      TOOL_CALLS_RANGE,
    ),
    maxOutputTokens: clampEnvInt(
      env,
      'PIWI_AI_ASSISTANT_MAX_OUTPUT_TOKENS',
      DEFAULT_ASSISTANT_MAX_OUTPUT_TOKENS,
      OUTPUT_TOKENS_RANGE,
    ),
    turnTimeoutMs:
      clampEnvInt(
        env,
        'PIWI_AI_ASSISTANT_TURN_TIMEOUT_SECONDS',
        DEFAULT_ASSISTANT_TURN_TIMEOUT_SECONDS,
        TIMEOUT_SECONDS_RANGE,
      ) * 1000,
    dailyTokensPerUser: cap(
      clampEnvInt(
        env,
        'PIWI_AI_ASSISTANT_DAILY_TOKENS_PER_USER',
        DEFAULT_ASSISTANT_DAILY_TOKENS_PER_USER,
        DAILY_TOKENS_RANGE,
      ),
    ),
    dailyTokens: cap(
      clampEnvInt(env, 'PIWI_AI_ASSISTANT_DAILY_TOKENS', DEFAULT_ASSISTANT_DAILY_TOKENS, DAILY_TOKENS_RANGE),
    ),
  };
}
