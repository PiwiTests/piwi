/** What an execution holds of the data the capture fixtures record. */
export interface CapturedEvidence {
  consoleLogs?: readonly unknown[] | null;
  networkRequests?: readonly unknown[] | null;
  ariaSnapshot?: string | null;
  pageState?: unknown;
  webVitals?: unknown;
  aiUsage?: unknown;
  evidenceSources?: unknown;
}

/**
 * Whether an execution ran with the capture fixtures: it holds data only they record (console messages, requests or
 * the failure-time ARIA snapshot not read back from the trace, the page's state, Web Vitals, AI usage).
 */
export function fixturesActiveIn(tc: CapturedEvidence | null | undefined): boolean {
  if (!tc) return false;
  const src = (tc.evidenceSources as { console?: 'trace'; network?: 'trace'; aria?: 'trace' } | null) ?? {};
  return (
    ((tc.consoleLogs?.length ?? 0) > 0 && src.console !== 'trace') ||
    ((tc.networkRequests?.length ?? 0) > 0 && src.network !== 'trace') ||
    (Boolean(tc.ariaSnapshot) && src.aria !== 'trace') ||
    Boolean(tc.pageState) ||
    Boolean(tc.webVitals) ||
    Boolean(tc.aiUsage)
  );
}
