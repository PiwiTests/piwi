import type { H3Event } from 'h3';
import { getRequestHeader, setResponseHeader } from 'h3';
import { apiError } from './api-error';
import { checkRateLimit, clientNetwork, rateLimitClientIp, releaseRateLimit } from './rate-limit';
import { timingSafeEqualStr } from './timing-safe';

/** The shortest operator token taken: a shorter one leaves the routes closed. */
export const OPERATOR_TOKEN_MIN_LENGTH = 32;
/** Wrong tokens a client network may send per window before it is refused. */
const FAILED_LIMIT = 10;
const FAILED_WINDOW_MS = 15 * 60 * 1000;

let warnedShortToken = false;

/** The operator token of `PIWI_OPERATOR_TOKEN`, or `null` while it is unset or too short. */
export function operatorToken(): string | null {
  const token = process.env.PIWI_OPERATOR_TOKEN?.trim();
  if (!token) return null;
  if (token.length < OPERATOR_TOKEN_MIN_LENGTH) {
    if (!warnedShortToken) {
      warnedShortToken = true;
      console.warn(
        `[operator] PIWI_OPERATOR_TOKEN is shorter than ${OPERATOR_TOKEN_MIN_LENGTH} characters: the operator routes stay closed.`,
      );
    }
    return null;
  }
  return token;
}

/**
 * Admits a request that carries the operator token as a Bearer token, and nothing else: no session, no API key, no
 * user. While no token is set the operator routes answer 404, as if they did not exist. A client network that sends
 * ten wrong tokens in 15 minutes is refused until the window ends; the right token takes back its slot.
 */
export function requireOperator(event: H3Event): void {
  const expected = operatorToken();
  if (!expected) throw apiError({ statusCode: 404, message: 'Not found' });
  const key = `operator:${clientNetwork(rateLimitClientIp(event))}`;
  if (!checkRateLimit(key, FAILED_LIMIT, FAILED_WINDOW_MS)) {
    throw apiError({ statusCode: 429, message: 'Too many wrong operator tokens: try again later' });
  }
  const sent = /^Bearer (\S+)$/i.exec(getRequestHeader(event, 'authorization') ?? '')?.[1];
  if (!sent || !timingSafeEqualStr(sent, expected)) {
    setResponseHeader(event, 'WWW-Authenticate', 'Bearer');
    throw apiError({ statusCode: 401, message: 'The operator token is required (Authorization: Bearer …)' });
  }
  releaseRateLimit(key);
}
