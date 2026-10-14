/**
 * DOM snapshots for demo mode, parsed from the real committed demo trace.
 *
 * The server extracts DOM snapshots from trace ZIPs with node-only inflation
 * (zlib); the demo does the same in the browser with a DataView central
 * directory walk + DecompressionStream (`../trace-zip.client.ts`) and then
 * runs the exact same node-free parsing/rendering the server uses
 * (`trace-events.ts` + `dom-snapshot-render.ts`), so the locator picker and
 * the DOM snapshot card show the genuine failure-time DOM — viewport and all —
 * of `public/demo/traces/checkout-pay-timeout.zip`.
 */
import { and, eq } from 'drizzle-orm';
import { files, testCases, testRunsCases } from '~~/server/database/schema.sqlite';
import { storyForCase } from '#shared/demo/failure-stories.mjs';
import { renderAriaSnapshotHtml } from '~~/server/utils/dom-snapshot-aria';
import { parseTraceTexts, traceFileRank } from '~~/server/utils/trace-events';
import {
  DOM_SNAPSHOT_CAP_CHARS,
  extractDomSnapshot,
  snapshotMomentFromQuery,
  withPageInteraction,
  type DomSnapshotResult,
  type DomSnapshotSource,
  type SnapshotMoment,
} from '~~/server/utils/dom-snapshot-render';
import { readZipEntries } from '../trace-zip.client';
import { getDemoDb, getDemoDbBaseUrl } from '../db.client';

/** Only committed demo assets may be fetched (mirrors files.ts). */
const ALLOWED_TRACE_PREFIX = 'demo/traces/';

// The committed trace is immutable for the lifetime of a build — parse it once
// and share the result between the picker, the DOM snapshot card and the AI
// context builder. Failed loads are not cached so a transient fetch error can
// recover on the next request.
const traceSnapshotCache = new Map<string, Promise<DomSnapshotResult | null>>();

function getTraceDomSnapshot(path: string, at?: SnapshotMoment): Promise<DomSnapshotResult | null> {
  const key = at ? `${path}#${at.phase}@${at.callId}` : path;
  const cached = traceSnapshotCache.get(key);
  if (cached) return cached;
  const promise = loadTraceDomSnapshot(path, at)
    .catch(() => null)
    .then((result) => {
      if (!result) traceSnapshotCache.delete(key);
      return result;
    });
  traceSnapshotCache.set(key, promise);
  return promise;
}

/**
 * Fetch a committed trace ZIP from the demo's static assets and extract the
 * failure-time DOM snapshot, mirroring the server's `getTraceDomSnapshot`
 * (`parseZip` → `parseTraceTexts` → `extractDomSnapshot`). Returns null when
 * the trace is missing, unparsable, or holds no renderable snapshot.
 */
async function loadTraceDomSnapshot(path: string, at?: SnapshotMoment): Promise<DomSnapshotResult | null> {
  if (!path.startsWith(ALLOWED_TRACE_PREFIX)) return null;

  const base = getDemoDbBaseUrl().replace(/\/$/, '');
  const response = await fetch(`${base}/${path}`);
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());

  const traceEntries = (await readZipEntries(bytes, (name) => name.endsWith('.trace'))).sort(
    (a, b) => traceFileRank(a.name) - traceFileRank(b.name),
  );
  if (traceEntries.length === 0) return null;

  const decoder = new TextDecoder();
  const data = parseTraceTexts(traceEntries.map((entry) => decoder.decode(entry.data)));
  const result = extractDomSnapshot(data, DOM_SNAPSHOT_CAP_CHARS, {}, at);
  return result.status === 'ok' && result.html ? result : null;
}

/**
 * GET /api/test-run-cases/:id/dom-snapshot — mirrors the server's
 * `resolveCaseDomSnapshot`: DOM by default, the ARIA tree as a fallback or on
 * demand (`?source=aria`), and `availableSources` so the picker can offer the
 * view toggle. The DOM ladder is demo-specific: a story's **authored**
 * failure-time page wins (served as if extracted from the case's trace — the
 * committed trace ZIPs are recordings of deliberately tiny fixture pages, too
 * bare for the locator picker), then the real trace-derived DOM parsed in the
 * browser, then the seeded `ariaSnapshot` rendered with the same browser-safe
 * renderer the real app uses.
 */
export async function apiGetDemoDomSnapshot(testRunsCaseId: number, query?: URLSearchParams): Promise<unknown> {
  const db = await getDemoDb();
  const [traceRows, caseRows] = await Promise.all([
    db
      .select({ path: files.path })
      .from(files)
      .where(and(eq(files.testRunsCaseId, testRunsCaseId), eq(files.type, 'trace')))
      .limit(1),
    db
      .select({
        aria: testRunsCases.ariaSnapshot,
        pageState: testRunsCases.pageState,
        projectId: testCases.projectId,
        filePath: testCases.filePath,
        title: testCases.title,
      })
      .from(testRunsCases)
      .leftJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(eq(testRunsCases.id, testRunsCaseId))
      .limit(1),
  ]);

  const tracePath = traceRows[0]?.path;
  const caseRow = caseRows[0];
  const ariaHtml = caseRow?.aria ? renderAriaSnapshotHtml(caseRow.aria) : null;
  const story =
    caseRow?.projectId != null && caseRow.filePath && caseRow.title
      ? storyForCase(caseRow.projectId, caseRow.filePath, caseRow.title)
      : null;
  const authored = story?.domSnapshot ?? null;
  let domAvailable = !!authored || !!tracePath;

  const sources = (): DomSnapshotSource[] => [
    ...(domAvailable ? (['dom'] as const) : []),
    ...(ariaHtml ? (['aria'] as const) : []),
  ];
  const asAria = (): DomSnapshotResult => ({
    status: 'ok',
    html: ariaHtml!,
    truncated: false,
    snapshotName: 'aria-fallback',
    source: 'aria',
    availableSources: sources(),
  });

  // Explicit ARIA request — skip the DOM ladder entirely.
  if (query?.get('source') === 'aria' && ariaHtml) return asAria();

  if (authored) {
    return {
      status: 'ok',
      html: authored.html,
      truncated: false,
      snapshotName: 'before@failure',
      source: 'dom',
      viewport: authored.viewport,
      availableSources: sources(),
    } satisfies DomSnapshotResult;
  }

  if (tracePath) {
    const result = await getTraceDomSnapshot(tracePath, snapshotMomentFromQuery(Object.fromEntries(query ?? [])));
    if (result)
      return withPageInteraction({ ...result, source: 'dom', availableSources: sources() }, caseRow?.pageState);
    // The trace produced no usable DOM — drop it as an option and fall back.
    domAvailable = false;
  }
  if (ariaHtml) return asAria();
  return { status: 'no-trace', availableSources: sources() };
}
