/**
 * Trace-derived "go deeper" evidence for demo mode — the full call stack and
 * full network trace, parsed in the browser from the real committed demo
 * trace. The ZIP is inflated with `../trace-zip.client.ts` and every stream
 * runs through the exact node-free builders the server uses
 * (`~~/server/utils/trace-insights`), so the demo behaves like production —
 * including source resolution from `resources/src@{sha1}.txt` entries and
 * body previews from the ZIP's own resources.
 */
import { and, eq } from 'drizzle-orm';
import { files, testCases, testRunsCases } from '~~/server/database/schema.sqlite';
import { parseTraceTexts, traceFileRank, type ParsedTraceData } from '~~/server/utils/trace-events';
import {
  buildTraceBodyPreview,
  buildTraceCallStack,
  buildTraceFrames,
  buildTraceNetwork,
  buildTraceSnapshots,
  matchNetworkBodySha1,
  parseNetworkTexts,
  parseStacksTexts,
  resolveSnapshotFile,
  traceFrameSource,
  traceImageContentType,
  type TraceResourceReader,
  type TraceResourceSnapshot,
  type TraceStacksIndex,
} from '~~/server/utils/trace-insights';
import { ariaJsonToText } from '#shared/aria-json';
import { readZipEntries } from '../trace-zip.client';
import { getDemoDb, getDemoDbBaseUrl } from '../db.client';
import { binaryResponse } from './files';

/** Only committed demo assets may be fetched (mirrors files.ts). */
const ALLOWED_TRACE_PREFIX = 'demo/traces/';

const SHA1_NAME_RE = /^[a-f0-9]{40}(\.[a-z0-9]{1,10})?$/;

interface DemoTraceBundle {
  parsed: ParsedTraceData | null;
  stacks: TraceStacksIndex | null;
  network: TraceResourceSnapshot[];
  readResource: TraceResourceReader;
  /** Bytes of an `aria/*`, `screenshots/*` or `screencast/*` entry, or null when absent. */
  readSnapshot: (file: string) => Uint8Array | null;
}

// The committed trace is immutable for the lifetime of a build — inflate and
// parse it once, shared by the stacks/network/body endpoints. Failed loads are
// not cached so a transient fetch error can recover on the next request.
const bundleCache = new Map<string, Promise<DemoTraceBundle | null>>();

function getTraceBundle(path: string): Promise<DemoTraceBundle | null> {
  const cached = bundleCache.get(path);
  if (cached) return cached;
  const promise = loadTraceBundle(path)
    .catch(() => null)
    .then((result) => {
      if (!result) bundleCache.delete(path);
      return result;
    });
  bundleCache.set(path, promise);
  return promise;
}

async function loadTraceBundle(path: string): Promise<DemoTraceBundle | null> {
  if (!path.startsWith(ALLOWED_TRACE_PREFIX)) return null;

  const base = getDemoDbBaseUrl().replace(/\/$/, '');
  const response = await fetch(`${base}/${path}`);
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());

  const entries = await readZipEntries(bytes, () => true);
  const decoder = new TextDecoder();
  const textsOf = (suffix: string) =>
    entries
      .filter((e) => e.name.endsWith(suffix))
      .sort((a, b) => traceFileRank(a.name) - traceFileRank(b.name))
      .map((e) => decoder.decode(e.data));

  const traceTexts = textsOf('.trace');
  const resources = new Map(
    entries.filter((e) => e.name.startsWith('resources/')).map((e) => [e.name.slice('resources/'.length), e.data]),
  );
  const snapshotEntries = new Map(
    entries
      .filter(
        (e) => e.name.startsWith('aria/') || e.name.startsWith('screenshots/') || e.name.startsWith('screencast/'),
      )
      .map((e) => [e.name, e.data]),
  );

  return {
    parsed: traceTexts.length > 0 ? parseTraceTexts(traceTexts) : null,
    stacks: parseStacksTexts(textsOf('.stacks')),
    network: parseNetworkTexts(textsOf('.network')),
    readResource: async (name) => {
      const exact = resources.get(name);
      if (exact) return exact;
      // A body ref (v8 `_sha1` or v9 `_file`, already normalized to the bare
      // name by `matchNetworkBodySha1`) may carry the stored extension or not —
      // match on the bare hash.
      const bare = name.split('.')[0]!;
      for (const [known, data] of resources) {
        if (known.split('.')[0] === bare) return data;
      }
      return null;
    },
    readSnapshot: (file) => snapshotEntries.get(file) ?? null,
  };
}

/** The case's trace path + its spec file path, or nulls. */
async function resolveCaseTrace(testRunsCaseId: number): Promise<{ path: string | null; filePath: string | null }> {
  const db = await getDemoDb();
  const [traceRows, caseRows] = await Promise.all([
    db
      .select({ path: files.path })
      .from(files)
      .where(and(eq(files.testRunsCaseId, testRunsCaseId), eq(files.type, 'trace')))
      .limit(1),
    db
      .select({ filePath: testCases.filePath })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(eq(testRunsCases.id, testRunsCaseId))
      .limit(1),
  ]);
  return { path: traceRows[0]?.path ?? null, filePath: caseRows[0]?.filePath ?? null };
}

/** GET /api/test-run-cases/:id/trace-stacks — mirrors trace-stacks.get.ts. */
export async function apiGetDemoTraceStacks(testRunsCaseId: number): Promise<unknown> {
  const { path, filePath } = await resolveCaseTrace(testRunsCaseId);
  if (!path) return { status: 'no-trace' };
  const bundle = await getTraceBundle(path);
  if (!bundle?.parsed) return { status: 'no-trace' };
  return buildTraceCallStack(bundle.parsed, bundle.stacks, bundle.readResource, { knownTestFilePath: filePath });
}

/** GET /api/test-run-cases/:id/trace-network — mirrors trace-network.get.ts. */
export async function apiGetDemoTraceNetwork(testRunsCaseId: number): Promise<unknown> {
  const { path } = await resolveCaseTrace(testRunsCaseId);
  if (!path) return { status: 'no-trace' };
  const bundle = await getTraceBundle(path);
  if (!bundle) return { status: 'no-trace' };
  return buildTraceNetwork(bundle.parsed, bundle.network);
}

/** GET /api/test-run-cases/:id/trace-network-body?sha1= — mirrors trace-network-body.get.ts. */
export async function apiGetDemoTraceNetworkBody(testRunsCaseId: number, query?: URLSearchParams): Promise<unknown> {
  const sha1 = (query?.get('sha1') ?? '').toLowerCase();
  if (!SHA1_NAME_RE.test(sha1)) return { status: 'not-found' };

  const { path } = await resolveCaseTrace(testRunsCaseId);
  if (!path) return { status: 'not-found' };
  const bundle = await getTraceBundle(path);
  if (!bundle) return { status: 'not-found' };

  const match = matchNetworkBodySha1(bundle.network, sha1);
  if (!match) return { status: 'not-found' };
  const bytes = await bundle.readResource(match.name);
  if (!bytes) return { status: 'not-found' };
  return buildTraceBodyPreview(bytes, match.mimeType);
}

/** Read an `aria/*.json` snapshot entry and convert it to the ARIA text form, or null. */
function readDemoAriaText(bundle: DemoTraceBundle, file: string): string | null {
  const bytes = bundle.readSnapshot(file);
  return bytes ? ariaJsonToText(new TextDecoder().decode(bytes)) : null;
}

/** GET /api/test-run-cases/:id/trace-snapshots — mirrors trace-snapshots.get.ts. */
export async function apiGetDemoTraceSnapshots(testRunsCaseId: number): Promise<unknown> {
  const { path } = await resolveCaseTrace(testRunsCaseId);
  if (!path) return { status: 'no-trace', steps: [], failingCallId: null, hasAria: false, hasScreen: false };
  const bundle = await getTraceBundle(path);
  if (!bundle) return { status: 'no-trace', steps: [], failingCallId: null, hasAria: false, hasScreen: false };
  return buildTraceSnapshots(bundle.parsed, (file) => readDemoAriaText(bundle, file));
}

/** GET /api/test-run-cases/:id/trace-snapshot?callId=&kind=&phase= — mirrors trace-snapshot.get.ts. */
export async function apiGetDemoTraceSnapshot(testRunsCaseId: number, query?: URLSearchParams): Promise<unknown> {
  const callId = query?.get('callId') ?? '';
  const kind = query?.get('kind');
  const phase = query?.get('phase');
  if (!callId || (kind !== 'aria' && kind !== 'screen') || (phase !== 'before' && phase !== 'after')) {
    return undefined;
  }

  const { path } = await resolveCaseTrace(testRunsCaseId);
  if (!path) return undefined;
  const bundle = await getTraceBundle(path);
  const file = resolveSnapshotFile(bundle?.parsed ?? null, callId, kind, phase);
  if (!bundle || !file) return undefined;
  const bytes = bundle.readSnapshot(file);
  if (!bytes) return undefined;
  return binaryResponse(bytes, file, kind === 'aria' ? 'application/json' : 'image/png');
}

/** GET /api/test-run-cases/:id/trace-frames — mirrors trace-frames.get.ts. */
export async function apiGetDemoTraceFrames(testRunsCaseId: number): Promise<unknown> {
  const { path } = await resolveCaseTrace(testRunsCaseId);
  const bundle = path ? await getTraceBundle(path) : null;
  if (!bundle) return { status: 'no-trace', pages: [], total: 0, capped: false };
  return buildTraceFrames(bundle.parsed);
}

/** GET /api/test-run-cases/:id/trace-frame?name= — mirrors trace-frame.get.ts. */
export async function apiGetDemoTraceFrame(testRunsCaseId: number, query?: URLSearchParams): Promise<unknown> {
  const name = query?.get('name') ?? '';
  if (!name) return undefined;
  const { path } = await resolveCaseTrace(testRunsCaseId);
  const bundle = path ? await getTraceBundle(path) : null;
  const source = traceFrameSource(bundle?.parsed ?? null, name);
  if (!bundle || !source) return undefined;
  const bytes = source.kind === 'resource' ? await bundle.readResource(source.name) : bundle.readSnapshot(source.name);
  const contentType = bytes ? traceImageContentType(bytes) : null;
  if (!bytes || !contentType) return undefined;
  return binaryResponse(bytes, name, contentType);
}
