import { sanitizeNetworkRequests, sanitizeUrl } from './sanitize';
import { normalizeRoute } from '#shared/utils/route';
import { int32 } from './storable-values';

/** Playwright's error texts are short; this bounds a hostile or garbled one. */
const MAX_FAILURE_LENGTH = 500;

/**
 * A captured request the table holds: an object with a method and a status. Any other is left out, so it fails
 * neither its case nor the batch.
 */
function isStorableRequest(request: unknown): request is Record<string, unknown> {
  if (!request || typeof request !== 'object') return false;
  const { method, status } = request as Record<string, unknown>;
  return typeof method === 'string' && typeof status === 'number';
}

/**
 * Build pre-insert rows for the normalized network_requests child table.
 *
 * Takes raw network requests from a test-case payload, sanitizes them, and
 * computes normalized routes from the original (unsanitized) URLs so query
 * param keys are preserved (values redacted) for endpoint grouping.
 */
export function buildNetworkRequestItems(requests: unknown[] | null | undefined): Array<{
  method: string;
  url: string | null;
  normalizedUrl: string;
  status: number;
  duration: number | null;
  /** Request start, Unix epoch milliseconds — null when the capture carried none. */
  startTime: number | null;
  resourceType: string | null;
  contentType: string | null;
  serverLogs: unknown;
  serverTraces: unknown;
  /** Why the request failed (Playwright's error text); null when it finished. */
  failure: string | null;
  /** True when no server sent the response (the test's route handler fulfilled it); null otherwise. */
  fulfilled: boolean | null;
}> {
  const rawReqs = Array.isArray(requests) ? requests.filter(isStorableRequest) : null;

  const rawUrlMap = new Map<string, string>();
  if (Array.isArray(rawReqs)) {
    for (const r of rawReqs) {
      if (typeof r.url === 'string' && !rawUrlMap.has(sanitizeUrl(r.url))) {
        rawUrlMap.set(sanitizeUrl(r.url), r.url);
      }
    }
  }

  const sanitized = sanitizeNetworkRequests(rawReqs);
  if (!sanitized || sanitized.length === 0) return [];

  return sanitized.map((req) => ({
    method: req.method as string,
    url: (req.url as string) ?? null,
    normalizedUrl: normalizeRoute(rawUrlMap.get(req.url as string) ?? (req.url as string)),
    status: int32(req.status) ?? 0,
    duration: int32(req.duration),
    startTime: typeof req.startTime === 'number' && Number.isFinite(req.startTime) ? Math.round(req.startTime) : null,
    resourceType: (req.resourceType as string) ?? null,
    contentType: (req.contentType as string) ?? null,
    serverLogs: (req.serverLogs as unknown) ?? null,
    serverTraces: (req.serverTraces as unknown) ?? null,
    failure: typeof req.failure === 'string' && req.failure ? req.failure.slice(0, MAX_FAILURE_LENGTH) : null,
    fulfilled: req.fulfilled === true ? true : null,
  }));
}

export type NetworkRequestItem = ReturnType<typeof buildNetworkRequestItems>[number];
export type NetworkRequestBuilder = { items: NetworkRequestItem[] };

/**
 * Flatten per-case network request builders into insert-ready values by filling
 * in `testRunsCaseId` and `testRunId`. Each inserted case names, by `rowIndex`,
 * the builder of the batch row it was inserted from.
 */
export function buildNetworkRequestInsertValues(
  networkRequestBuilders: NetworkRequestBuilder[],
  insertedCases: Array<{ id: number; rowIndex: number }>,
  testRunId: number,
): Array<NetworkRequestItem & { testRunsCaseId: number; testRunId: number }> {
  const values: ReturnType<typeof buildNetworkRequestInsertValues> = [];
  for (const { id, rowIndex } of insertedCases) {
    for (const item of networkRequestBuilders[rowIndex]?.items ?? []) {
      values.push({ testRunsCaseId: id, testRunId, ...item });
    }
  }
  return values;
}
