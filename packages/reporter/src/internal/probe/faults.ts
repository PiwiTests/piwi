/**
 * Client-probe fault application (Piwi Test Map). A probe run replays a passing
 * test and mutates one response at the Playwright route boundary; these pure
 * functions compute the mutated response from the real one, so the interception
 * layer stays a thin wrapper and the transformations are unit-tested.
 */

/** The faults a client probe applies at `page.route`. */
export const PROBE_FAULTS = ['status-500', 'empty-body', 'drop-field', 'stale-value', 'slow'] as const;
export type ProbeFault = (typeof PROBE_FAULTS)[number];

/**
 * The server-side fault classes a signed probe can name (mirrors the dashboard's
 * `SERVER_PROBE_FAULTS`). The reporter never applies these itself — the
 * instrumentation does — but it checks a plan item against this list before
 * signing, so a plan naming a fault outside the vocabulary is refused reporter-
 * side too, not only in the planner.
 */
export const SERVER_PROBE_FAULTS = [
  'throw',
  'status',
  'delay',
  'dependency',
  'data',
  'extreme',
  'replay',
  'auth',
  'slow-first',
] as const;

/**
 * Whether a plan item's fault is one this reporter will act on at its level: a
 * client fault must be in {@link PROBE_FAULTS}, a server fault in
 * {@link SERVER_PROBE_FAULTS}. A plan item failing this check is refused before
 * anything is applied or signed.
 */
export function isFaultAllowed(level: 'client' | 'server', fault: string): boolean {
  const list: readonly string[] = level === 'server' ? SERVER_PROBE_FAULTS : PROBE_FAULTS;
  return list.includes(fault);
}

/** How long a `slow` fault delays a response, in milliseconds. */
export const SLOW_FAULT_DELAY_MS = 5000;

/**
 * What the interception does to one targeted request, shared by probe faults
 * and flake conditions:
 *  - `delay` fetches the real response and holds it until `ms` after the
 *    request started;
 *  - `status` answers with that status and an empty body;
 *  - `abort` resets the connection.
 */
export type RouteAction = { kind: 'delay'; ms: number } | { kind: 'status'; status: number } | { kind: 'abort' };

/**
 * The route action a client fault maps to, or null for a fault that rewrites
 * the real response ({@link computeFault}). `slow` is a 5-second delay.
 */
export function faultRouteAction(fault: ProbeFault | string): RouteAction | null {
  return fault === 'slow' ? { kind: 'delay', ms: SLOW_FAULT_DELAY_MS } : null;
}

export interface FaultInput {
  /** The real response status. */
  status: number;
  /** The real response body as text. */
  body: string;
  contentType?: string | null;
  /** A previous response body for `stale-value` (replay); falls back to the current body. */
  priorBody?: string | null;
}

export interface FaultOutput {
  status: number;
  body: string;
  contentType?: string | null;
  /** Milliseconds to delay before responding; 0 for an immediate mutation. */
  delayMs: number;
  /**
   * Whether the fault actually changes what the page sees — a mutated status or
   * body, or a real delay. A no-op (a `stale-value` with no prior body, a
   * `drop-field` on a non-JSON body, an already-empty `empty-body`) is `false`,
   * so the interception records it as not applied (inconclusive) rather than a
   * false scenario gap.
   */
  changed: boolean;
}

/** Drop the first own key of a JSON object, or of each element of a JSON array. */
function dropOneField(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body; // not JSON — nothing to drop
  }
  if (Array.isArray(parsed)) {
    let key: string | undefined;
    for (const el of parsed) {
      if (el && typeof el === 'object' && !Array.isArray(el)) {
        key ??= Object.keys(el as Record<string, unknown>)[0];
        if (key) delete (el as Record<string, unknown>)[key];
      }
    }
    return JSON.stringify(parsed);
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const key = Object.keys(obj)[0];
    if (key) delete obj[key];
    return JSON.stringify(obj);
  }
  return body;
}

/**
 * Compute the mutated response for a fault. `status-500` forces a 500;
 * `empty-body` blanks the body; `drop-field` removes one JSON key; `stale-value`
 * replays a previous body; `slow` delays the real response unchanged.
 */
export function computeFault(fault: ProbeFault, input: FaultInput): FaultOutput {
  const base: FaultOutput = {
    status: input.status,
    body: input.body,
    contentType: input.contentType ?? null,
    delayMs: 0,
    changed: false,
  };
  switch (fault) {
    case 'status-500':
      return { ...base, status: 500, changed: input.status !== 500 };
    case 'empty-body':
      return { ...base, body: '', changed: input.body.length > 0 };
    case 'drop-field': {
      const body = dropOneField(input.body);
      return { ...base, body, changed: body !== input.body };
    }
    case 'stale-value': {
      const body = input.priorBody ?? input.body;
      return { ...base, body, changed: body !== input.body };
    }
    case 'slow':
      return { ...base, delayMs: SLOW_FAULT_DELAY_MS, changed: true };
    default:
      return base;
  }
}
