import type { H3Event } from 'h3';
import { getRequestHeader, setResponseHeader } from 'h3';
import { apiError } from './api-error';
import { checkRateLimit, clientNetwork, rateLimitClientIp, rateLimitedError } from './rate-limit';
import { timingSafeEqualStr } from './timing-safe';

/** The shortest operator token taken: a shorter one leaves the routes closed. */
export const OPERATOR_TOKEN_MIN_LENGTH = 32;
/** Wrong tokens a client network may send per window before it is refused. */
const FAILED_LIMIT = 10;
const FAILED_WINDOW_MS = 15 * 60 * 1000;

let warnedUnusable = false;

/**
 * The operator token of `PIWI_OPERATOR_TOKEN`, or `null` while it is unset or unusable: shorter than 32 characters,
 * or holding a space, which a Bearer header cannot carry. An unusable one is said once in the log.
 */
export function operatorToken(): string | null {
  const token = process.env.PIWI_OPERATOR_TOKEN?.trim();
  if (!token) return null;
  const problem =
    token.length < OPERATOR_TOKEN_MIN_LENGTH
      ? `is shorter than ${OPERATOR_TOKEN_MIN_LENGTH} characters`
      : /\s/.test(token)
        ? 'holds a space, which a Bearer header cannot carry'
        : null;
  if (!problem) return token;
  if (!warnedUnusable) {
    warnedUnusable = true;
    console.warn(`[operator] PIWI_OPERATOR_TOKEN ${problem}: the operator routes stay closed.`);
  }
  return null;
}

/**
 * Admits a request that carries the operator token as a Bearer token, and nothing else: no session, no API key, no
 * user. While no token is set the operator routes answer 404, as if they did not exist. The right token always
 * passes; a client network that sends ten wrong ones in 15 minutes is refused until the window ends, and a request
 * that sends none is refused without counting.
 */
export function requireOperator(event: H3Event): void {
  const expected = operatorToken();
  if (!expected) throw apiError({ statusCode: 404, message: 'Not found' });
  const sent = /^Bearer (\S+)$/i.exec(getRequestHeader(event, 'authorization') ?? '')?.[1];
  if (sent && timingSafeEqualStr(sent, expected)) return;
  if (sent) {
    const key = `operator:${clientNetwork(rateLimitClientIp(event))}`;
    if (!checkRateLimit(key, FAILED_LIMIT, FAILED_WINDOW_MS)) {
      throw rateLimitedError(event, [key], 'Too many wrong operator tokens: try again later');
    }
  }
  setResponseHeader(event, 'WWW-Authenticate', 'Bearer');
  throw apiError({ statusCode: 401, message: 'The operator token is required (Authorization: Bearer …)' });
}
