/** Build a clickable dashboard URL for a run, tolerating a trailing slash on `serverUrl`. */
export function runUrl(serverUrl: string, runId: number | string): string {
  return `${serverUrl.replace(/\/+$/, '')}/test-runs/${runId}`;
}

/**
 * The run's page an answer of the instance names (`runUrl`): an `http(s)` URL as it is, a path under `serverUrl`;
 * else, from an instance that names none or one that does not read, the page under `serverUrl` (`runUrl`).
 */
export function answeredRunUrl(answer: unknown, serverUrl: string, runId: number | string): string {
  const named = (answer as { runUrl?: unknown } | null | undefined)?.runUrl;
  if (typeof named === 'string' && named.length <= 2048 && !/[\s()<>"'`\\]/.test(named)) {
    if (/^\/[^/]/.test(named)) return `${serverUrl.replace(/\/+$/, '')}${named}`;
    try {
      const url = new URL(named);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
      // Not a URL: the page under the reporter's own address stands.
    }
  }
  return runUrl(serverUrl, runId);
}
