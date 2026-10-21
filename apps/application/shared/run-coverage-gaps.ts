/**
 * Why part of a run's server coverage is missing, as the reporter names it
 * with the run's coverage (`incomplete` on `PUT /api/test-runs/:id/coverage`)
 * and `test_runs.server_coverage_gaps` keeps it: per backend origin, the
 * backend restarted during the run (another process answered the run-level
 * coverage than the one that gave out the run's first request ids), or it was
 * unreachable at the end of the run. Pure, shared by the server, the demo and
 * the run page.
 */

/** One backend origin whose run-level coverage is incomplete. */
export interface RunCoverageGap {
  /** The backend's origin, `http(s)://host[:port]`. */
  origin: string;
  reason: 'restarted' | 'unreachable';
  /** About when the backend restarted (ISO 8601); `restarted` only, when the backend named it. */
  at?: string;
}

/** Gaps a run keeps at most. */
export const MAX_RUN_COVERAGE_GAPS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One gap from untrusted input, or null when it is not one. */
function gapOf(value: unknown): RunCoverageGap | null {
  if (!isRecord(value) || (value.reason !== 'restarted' && value.reason !== 'unreachable')) return null;
  if (typeof value.origin !== 'string' || value.origin.length > 300) return null;
  let origin: string;
  try {
    const url = new URL(value.origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    origin = url.origin;
  } catch {
    return null;
  }
  const at =
    value.reason === 'restarted' && typeof value.at === 'string' && !Number.isNaN(Date.parse(value.at))
      ? new Date(value.at).toISOString()
      : undefined;
  return { origin, reason: value.reason, ...(at ? { at } : {}) };
}

/**
 * The gaps of a list from untrusted input (a request body's `incomplete`, a
 * stored column): each valid entry once, sorted by origin, at most
 * {@link MAX_RUN_COVERAGE_GAPS}. Empty for anything that is not a list.
 */
export function readRunCoverageGaps(value: unknown): RunCoverageGap[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, RunCoverageGap>();
  for (const item of value) {
    const gap = gapOf(item);
    if (gap) byKey.set(`${gap.origin}\0${gap.reason}\0${gap.at ?? ''}`, gap);
  }
  return [...byKey.values()]
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.reason.localeCompare(b.reason))
    .slice(0, MAX_RUN_COVERAGE_GAPS);
}

/** A run's stored gaps with new ones added, as every shard of a run sends its own. */
export function mergeRunCoverageGaps(stored: unknown, added: RunCoverageGap[]): RunCoverageGap[] {
  return readRunCoverageGaps([...readRunCoverageGaps(stored), ...added]);
}
