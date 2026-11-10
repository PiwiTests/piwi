/**
 * One in-process request limiter per test management connection. It spaces the starts of a connection's requests
 * `60 000 / n` ms apart (n = `PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE`, 20 unless set), so the catalog read, the
 * pickers and a refresh button pressed meanwhile share one budget. The first request after a quiet spell goes at once.
 *
 * The check a person waits on before saving a connection has no connection yet and is not limited.
 */
import { IntegrationHttpError } from '../http-error';
import {
  DEFAULT_TEST_MANAGEMENT_REQUESTS_PER_MINUTE,
  resolveRequestsPerMinute,
} from '#shared/integrations/test-management-limits';

/** The longest a request a person waits on queues behind the connection's other requests. */
export const INTERACTIVE_MAX_WAIT_MS = 15_000;

/** A request refused because the connection's queue is longer than its caller will wait; nothing was reserved. */
export class RequestLimiterBusyError extends IntegrationHttpError {
  constructor(retryAfterMs: number) {
    super(429, 'Too many requests to this connection are waiting; try again shortly', retryAfterMs);
    this.name = 'RequestLimiterBusyError';
  }
}

export interface RequestLimiter {
  /**
   * Resolves when the caller may send its request; calls are served in order, spaced by the limiter's interval. With
   * `maxWaitMs`, a request whose turn is further away is refused with {@link RequestLimiterBusyError} and takes no turn.
   */
  wait(options?: { maxWaitMs?: number }): Promise<void>;
}

/** A limiter that lets a request start every `intervalMs`. */
export function createRequestLimiter(intervalMs: number): RequestLimiter {
  let nextAt = 0;
  return {
    async wait(options) {
      const now = Date.now();
      const at = Math.max(now, nextAt);
      const maxWaitMs = options?.maxWaitMs;
      if (maxWaitMs !== undefined && at - now > maxWaitMs) throw new RequestLimiterBusyError(at - now - maxWaitMs);
      nextAt = at + intervalMs;
      if (at > now) await new Promise<void>((resolve) => setTimeout(resolve, at - now));
    },
  };
}

const limiters = new Map<number, { perMinute: number; limiter: RequestLimiter }>();
const reportedInvalid = new Set<string>();

/** The requests a minute the environment asks for; an unusable value is logged once and the default is used. */
export function configuredRequestsPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE;
  const { value, invalid } = resolveRequestsPerMinute(raw);
  if (invalid && raw !== undefined && !reportedInvalid.has(raw)) {
    reportedInvalid.add(raw);
    console.warn(
      `[integrations] PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE "${raw}" is not a whole number from 1 to 600; using ${DEFAULT_TEST_MANAGEMENT_REQUESTS_PER_MINUTE}`,
    );
  }
  return value;
}

/** The limiter of a connection. It follows the setting: a changed value starts a fresh limiter at the new rate. */
export function limiterForConnection(connectionId: number): RequestLimiter {
  const perMinute = configuredRequestsPerMinute();
  const existing = limiters.get(connectionId);
  if (existing && existing.perMinute === perMinute) return existing.limiter;
  const limiter = createRequestLimiter(60_000 / perMinute);
  limiters.set(connectionId, { perMinute, limiter });
  return limiter;
}

/** Forget every limiter and the invalid values already reported (for tests). */
export function resetLimitersForTests(): void {
  limiters.clear();
  reportedInvalid.clear();
}
