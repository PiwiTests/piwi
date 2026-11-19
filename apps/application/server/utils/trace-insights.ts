/**
 * Node-free parsing of the trace streams the DOM-snapshot path ignores: the
 * `trace.stacks` call-stack index, the embedded `resources/src@{sha1}.txt`
 * source files, and the HAR-like `resource-snapshot` events in `*.network`.
 * Powers the "go deeper" evidence views (full call stack with source, full
 * network trace) and their AI-diagnosis sections. Like `trace-events.ts`, this
 * module must stay free of node imports so the browser demo can run the exact
 * same code over the committed demo trace — only ZIP inflation and resource
 * reads differ per runtime (see `TraceResourceReader`).
 */
import { pageActionOf, type ParsedTraceData, type TraceAction, type TraceScreencastFrame } from './trace-events';
import { maskSensitiveText } from './dom-snapshot-render';
import { diffAriaSnapshots } from '#shared/page-diff';
import { wallClockOf } from '#shared/video-actions';
import type {
  TraceBodyResponse,
  TraceCallStackResponse,
  TraceFramePage,
  TraceFramesResponse,
  TraceNetworkEntry,
  TraceNetworkResponse,
  TraceSnapshotsResponse,
  TraceSnapshotStep,
  TraceStackFrame,
} from '../../types/api';
import { safeStorageSegment } from './sanitize-filename';

/** Reads one `resources/{name}` file of the trace — from the shared pool on the server, from the ZIP itself in the demo. */
export type TraceResourceReader = (name: string) => Promise<Uint8Array | null>;

/** A stack frame as stored in `trace.stacks`: [fileIndex, line, column, functionName?]. */
export type RawStackFrame = [number, number, number, string?];

export interface TraceStacksIndex {
  /** Absolute file paths exactly as recorded on the machine that ran the tests. */
  files: string[];
  /** Normalized callId (`call@6`) → frames, innermost first. */
  byCallId: Map<string, RawStackFrame[]>;
}

/**
 * Parse one or more `*.stacks` JSON documents (`{ files, stacks: [[callId,
 * frames]] }`). Stack keys are numeric in modern traces (`6` for `call@6`) and
 * strings in older ones — both normalize to the event stream's `call@N` form.
 * Returns null when nothing parseable was found.
 */
export function parseStacksTexts(texts: string[]): TraceStacksIndex | null {
  const files: string[] = [];
  const byCallId = new Map<string, RawStackFrame[]>();

  for (const text of texts) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    const docFiles = (doc as { files?: unknown }).files;
    const docStacks = (doc as { stacks?: unknown }).stacks;
    if (!Array.isArray(docFiles) || !Array.isArray(docStacks)) continue;

    // File indexes are per-document; offset them when merging several docs.
    const offset = files.length;
    files.push(...docFiles.map((f) => String(f)));

    for (const entry of docStacks) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [rawId, rawFrames] = entry as [unknown, unknown];
      if (!Array.isArray(rawFrames)) continue;
      const callId = typeof rawId === 'number' ? `call@${rawId}` : String(rawId);
      const frames: RawStackFrame[] = [];
      for (const frame of rawFrames) {
        if (!Array.isArray(frame) || frame.length < 3) continue;
        const [fileIdx, line, column, fn] = frame as [unknown, unknown, unknown, unknown];
        if (typeof fileIdx !== 'number' || typeof line !== 'number' || typeof column !== 'number') continue;
        frames.push([fileIdx + offset, line, column, typeof fn === 'string' ? fn : undefined]);
      }
      if (frames.length > 0 && !byCallId.has(callId)) byCallId.set(callId, frames);
    }
  }

  return byCallId.size > 0 || files.length > 0 ? { files, byCallId } : null;
}

/** Hex SHA-1 of a string — how Playwright names embedded sources (`src@{sha1(absPath)}.txt`). */
export async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const DEFAULT_MAX_FRAMES = 50;
const DEFAULT_CONTEXT_LINES = 12;

export interface BuildCallStackOptions {
  /** The case's project-relative spec path (from the DB) — anchors abs-path → display-path derivation. */
  knownTestFilePath?: string | null;
  maxFrames?: number;
  contextLines?: number;
}

/**
 * Build the full-call-stack view for the failing action. The stack itself
 * comes from `trace.stacks`; each distinct file's source is resolved by
 * probing `src@{sha1(absPath)}.txt` through the reader — a miss (trace
 * recorded with `sources: false`, or the resource was pruned) degrades that
 * frame to `source: null`, never an error. When the failing action has no
 * stack entry, the nearest preceding action that has one is used (its
 * `apiName` is reported so the UI stays honest about whose stack it shows).
 */
export async function buildTraceCallStack(
  parsed: ParsedTraceData,
  stacks: TraceStacksIndex | null,
  readResource: TraceResourceReader,
  options: BuildCallStackOptions = {},
): Promise<TraceCallStackResponse> {
  if (!stacks || stacks.byCallId.size === 0) return { status: 'no-stacks' };

  const { action, frames: rawFrames } = pickStackAction(parsed, stacks);
  if (!action || !rawFrames) return { status: 'no-stacks' };

  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const kept = rawFrames.slice(0, maxFrames);

  // Derive the runner-side project root by locating the stack file that ends
  // with the spec path the reporter stored (project-relative). Every file
  // under that root gets a repo-relative display path and counts as
  // in-project (dependency dirs excepted).
  const known = normalizeSlashes(options.knownTestFilePath ?? '').replace(/^\.\//, '');
  const root = deriveProjectRoot(stacks.files, known);

  // Read each distinct file's embedded source once.
  const sourceByFile = new Map<string, string[] | null>();
  for (const [fileIdx] of kept) {
    const absPath = stacks.files[fileIdx];
    if (absPath === undefined || sourceByFile.has(absPath)) continue;
    const resource = await readResource(`src@${await sha1Hex(absPath)}.txt`);
    sourceByFile.set(absPath, resource ? decodeText(resource).split('\n') : null);
  }

  const frames: TraceStackFrame[] = [];
  for (const [fileIdx, line, column, functionName] of kept) {
    const absPath = stacks.files[fileIdx];
    if (absPath === undefined) continue;
    const { file: display, inProject, absFile } = displayPathOf(absPath, root, known);

    const allLines = sourceByFile.get(absPath) ?? null;
    let source: TraceStackFrame['source'] = null;
    if (allLines && line >= 1 && line <= allLines.length) {
      const startLine = Math.max(1, line - contextLines);
      const endLine = Math.min(allLines.length, line + contextLines);
      source = { startLine, lines: allLines.slice(startLine - 1, endLine), totalLines: allLines.length };
    }

    frames.push({
      file: display,
      absFile,
      line,
      column,
      functionName,
      inProject,
      source,
    });
  }

  if (frames.length === 0) return { status: 'no-stacks' };
  return {
    status: 'ok',
    frames,
    hasSources: frames.some((f) => f.source),
    apiName: action.apiName,
    errorMessage: action.error?.message?.slice(0, 500),
  };
}

/**
 * The runner-side project root: the prefix of a stack file path that, stripped,
 * leaves the reporter's project-relative spec path. Null when the paths are
 * already relative or the spec file is not among them.
 */
function deriveProjectRoot(files: string[], known: string): string | null {
  if (!known) return null;
  for (const file of files) {
    const norm = normalizeSlashes(file);
    if (norm === known) return null; // already relative — nothing to strip
    if (norm.endsWith(`/${known}`)) return norm.slice(0, norm.length - known.length);
  }
  return null;
}

/** A stack file's repo-relative display path and whether it counts as in-project. */
function displayPathOf(
  absPath: string,
  root: string | null,
  known: string,
): { file: string; inProject: boolean; absFile: string | undefined } {
  const norm = normalizeSlashes(absPath);
  let display: string;
  let inProject: boolean;
  if (root && norm.startsWith(root)) {
    display = norm.slice(root.length);
    inProject = !display.includes('node_modules/');
  } else if (norm === known && known) {
    display = norm;
    inProject = true;
  } else {
    display = shortenPath(norm);
    inProject = !norm.includes('node_modules/') && !root;
  }
  return { file: display, inProject, absFile: norm === display ? undefined : norm };
}

/** One trace action's call site: the innermost in-project frame plus every frame. */
export interface ActionCallsite {
  /** `file:line` of the innermost in-project frame — matches the reporter's step location. */
  location: string;
  frames: Array<{ file: string; line: number; function: string | null; inProject: boolean }>;
}

/**
 * The call stack of every action that has one, as lightweight display frames
 * (no source windows), for correlating steps with the code that called them on
 * the failure timeline. Reads only the stacks index already parsed from the
 * trace — no extra ZIP access. The `location` is the innermost in-project
 * frame's `file:line`, which is what the reporter records as a step's call site.
 */
export function buildActionCallsites(
  parsed: ParsedTraceData | null,
  stacks: TraceStacksIndex | null,
  options: { knownTestFilePath?: string | null } = {},
): ActionCallsite[] {
  if (!parsed || !stacks || stacks.byCallId.size === 0) return [];
  const known = normalizeSlashes(options.knownTestFilePath ?? '').replace(/^\.\//, '');
  const root = deriveProjectRoot(stacks.files, known);

  const result: ActionCallsite[] = [];
  for (const action of parsed.actions) {
    const raw = stacks.byCallId.get(action.callId);
    if (!raw?.length) continue;
    const frames: ActionCallsite['frames'] = [];
    for (const [fileIdx, line, , functionName] of raw) {
      const absPath = stacks.files[fileIdx];
      if (absPath === undefined) continue;
      const { file, inProject } = displayPathOf(absPath, root, known);
      frames.push({ file, line, function: functionName ?? null, inProject });
    }
    if (frames.length === 0) continue;
    const anchor = frames.find((f) => f.inProject) ?? frames[0]!;
    result.push({ location: `${anchor.file}:${anchor.line}`, frames });
  }
  return result;
}

/**
 * The failing action's stack, else the stack of the page-side action it drove
 * (a runner action records none), else the nearest preceding action that has one.
 */
function pickStackAction(
  parsed: ParsedTraceData,
  stacks: TraceStacksIndex,
): { action: TraceAction | null; frames: RawStackFrame[] | null } {
  const failing = parsed.failingAction;
  const ownFrames = failing ? stacks.byCallId.get(failing.callId) : undefined;
  if (failing && ownFrames?.length) return { action: failing, frames: ownFrames };
  const pageAction = pageActionOf(parsed, failing);
  const pageFrames = pageAction ? stacks.byCallId.get(pageAction.callId) : undefined;
  if (pageAction && pageFrames?.length) return { action: pageAction, frames: pageFrames };
  const fromIndex = parsed.failingActionIndex >= 0 ? parsed.failingActionIndex : parsed.actions.length - 1;
  for (let i = fromIndex; i >= 0; i--) {
    const action = parsed.actions[i];
    if (!action) continue;
    const frames = stacks.byCallId.get(action.callId);
    if (frames?.length) return { action, frames };
  }
  return { action: null, frames: null };
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Keep the tail of an out-of-project path readable without leaking the whole machine layout. */
function shortenPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 4) return path;
  return `…/${parts.slice(-4).join('/')}`;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

// ---------------------------------------------------------------------------
// Network (`*.network` resource-snapshot events)
// ---------------------------------------------------------------------------

interface HarHeader {
  name?: unknown;
  value?: unknown;
}

/** The `snapshot` payload of one `resource-snapshot` line — HAR entry shaped. */
export interface TraceResourceSnapshot {
  startedDateTime?: string;
  time?: number;
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
    bodySize?: number;
    postData?: { mimeType?: string; text?: string; _sha1?: string; _file?: string };
  };
  response?: {
    status?: number;
    statusText?: string;
    headers?: HarHeader[];
    bodySize?: number;
    content?: { size?: number; mimeType?: string; _sha1?: string; _file?: string };
    _transferSize?: number;
    _failureText?: string;
  };
  timings?: { dns?: number; connect?: number; ssl?: number; send?: number; wait?: number; receive?: number };
  serverIPAddress?: string;
  _monotonicTime?: number;
  _resourceType?: string;
  _failureText?: string;
}

/** Parse `*.network` JSONL texts into their raw HAR-like snapshots (order preserved). */
export function parseNetworkTexts(texts: string[]): TraceResourceSnapshot[] {
  const snapshots: TraceResourceSnapshot[] = [];
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      let evt: unknown;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (!evt || typeof evt !== 'object') continue;
      const { type, snapshot } = evt as { type?: unknown; snapshot?: unknown };
      if (type === 'resource-snapshot' && snapshot && typeof snapshot === 'object') {
        snapshots.push(snapshot as TraceResourceSnapshot);
      }
    }
  }
  return snapshots;
}

/**
 * The stored resource name a network body carrier (`response.content` or
 * `request.postData`) points at, or null when it holds none. Older v8 traces
 * carry the bare content hash as `_sha1`; v9 traces (Playwright 1.63+) renamed
 * it to `_file` and prefix it with `resources/`. Stripping that prefix yields
 * the same bare name both readers key on (`project-<id>/trace-resources/<name>`
 * in the server pool, `resources/<name>` in the demo ZIP), so this normalizes
 * both spellings, exactly like `trace-events.ts` does for DOM-snapshot assets.
 */
function resourceBodyName(carrier: { _sha1?: string; _file?: string } | undefined): string | null {
  if (carrier?._sha1) return safeStorageSegment(carrier._sha1);
  if (carrier?._file) return safeStorageSegment(carrier._file.replace(/^resources\//, ''));
  return null;
}

/**
 * Header names whose values are always replaced with `[masked]`. A broader
 * name heuristic below catches custom variants (`x-anything-token`, …);
 * over-masking is deliberate — surviving values still pass
 * {@link maskSensitiveText}.
 */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-refresh-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-id',
  'x-amz-security-token',
  'x-goog-api-key',
]);

const SENSITIVE_HEADER_NAME_RE = /token|secret|session|auth|cookie|api-?key/i;
const MAX_HEADERS = 50;
const MAX_HEADER_VALUE_CHARS = 2000;
const MAX_URL_CHARS = 2048;
const MAX_POST_DATA_CHARS = 2000;

/** Mask sensitive header values and cap list/value sizes. */
export function maskHeaders(headers: HarHeader[] | undefined): Array<{ name: string; value: string }> {
  if (!Array.isArray(headers)) return [];
  return headers.slice(0, MAX_HEADERS).map((h) => {
    const name = String(h?.name ?? '');
    const rawValue = String(h?.value ?? '');
    const masked =
      SENSITIVE_HEADERS.has(name.toLowerCase()) || SENSITIVE_HEADER_NAME_RE.test(name)
        ? '[masked]'
        : maskSensitiveText(rawValue);
    return { name, value: capChars(masked, MAX_HEADER_VALUE_CHARS) };
  });
}

/** Mask token-shaped strings in a body preview and cap its length. */
export function maskBodyText(text: string, capCharsAt: number): { content: string; truncated: boolean } {
  const masked = maskSensitiveText(text);
  if (capCharsAt > 0 && masked.length > capCharsAt) {
    return { content: masked.slice(0, capCharsAt), truncated: true };
  }
  return { content: masked, truncated: false };
}

function capChars(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

const TRACE_NETWORK_MAX_ENTRIES = 500;
/** Requests starting up to this long before the failing action still count as "during failure". */
const FAILURE_WINDOW_LEAD_MS = 1000;

export interface BuildNetworkOptions {
  maxEntries?: number;
}

/**
 * Turn raw resource-snapshots into the chronological network-trace response:
 * relative waterfall timeline, timing phases, masked headers, failure-window
 * correlation and body-preview pointers. `_monotonicTime` shares the clock
 * with action start/end times; when any entry lacks it the timeline falls
 * back to `startedDateTime` deltas and failure correlation is skipped (wall
 * clock and monotonic time cannot be mixed).
 */
export function buildTraceNetwork(
  parsed: ParsedTraceData | null,
  snapshots: TraceResourceSnapshot[],
  options: BuildNetworkOptions = {},
): TraceNetworkResponse {
  if (snapshots.length === 0) return { status: 'empty' };

  const monotonic = snapshots.every((s) => typeof s._monotonicTime === 'number');
  const startOf = (s: TraceResourceSnapshot): number => {
    if (monotonic) return s._monotonicTime!;
    const parsedDate = s.startedDateTime ? Date.parse(s.startedDateTime) : Number.NaN;
    return Number.isFinite(parsedDate) ? parsedDate : 0;
  };

  const ordered = snapshots.map((s) => ({ snapshot: s, absStart: startOf(s) })).sort((a, b) => a.absStart - b.absStart);
  const timelineStart = ordered[0]!.absStart;

  const failingAction = parsed?.failingAction ?? null;
  const windowStartAbs = monotonic && failingAction ? failingAction.startTime - FAILURE_WINDOW_LEAD_MS : null;
  const windowEndAbs =
    monotonic && failingAction
      ? (failingAction.endTime ?? (parsed!.traceEndTime > failingAction.startTime ? parsed!.traceEndTime : null))
      : null;

  const maxEntries = options.maxEntries ?? TRACE_NETWORK_MAX_ENTRIES;
  const truncated = ordered.length > maxEntries;
  const kept = ordered.slice(0, maxEntries);

  const requests: TraceNetworkEntry[] = kept.map(({ snapshot, absStart }, index) => {
    const request = snapshot.request ?? {};
    const response = snapshot.response ?? {};
    const content = response.content ?? {};
    const start = Math.max(0, absStart - timelineStart);
    const duration = Math.max(0, snapshot.time ?? 0);
    const status = typeof response.status === 'number' ? response.status : 0;
    const failureText = snapshot._failureText ?? response._failureText;
    const inWindow =
      windowStartAbs != null &&
      absStart <= (windowEndAbs ?? Number.POSITIVE_INFINITY) &&
      absStart + duration >= windowStartAbs;

    const bodySha1 = resourceBodyName(content);
    const postDataText = request.postData?.text;

    return {
      index,
      method: request.method ?? 'GET',
      url: capChars(maskSensitiveText(request.url ?? ''), MAX_URL_CHARS),
      status,
      statusText: response.statusText || undefined,
      failureText: failureText || undefined,
      resourceType: snapshot._resourceType ?? inferResourceType(content.mimeType),
      mimeType: content.mimeType,
      requestHeaders: maskHeaders(request.headers),
      responseHeaders: maskHeaders(response.headers),
      requestBodySize: nonNegative(request.bodySize),
      responseBodySize: nonNegative(content.size) ?? nonNegative(response.bodySize),
      transferSize: nonNegative(response._transferSize),
      start,
      duration,
      timings: snapshot.timings,
      duringFailure: inWindow,
      failed: status >= 400 || status <= 0,
      bodySha1,
      bodyPreviewable: !!bodySha1,
      requestPostData: postDataText ? maskBodyText(postDataText, MAX_POST_DATA_CHARS).content : null,
    };
  });

  const timelineDuration = requests.reduce((max, r) => Math.max(max, r.start + r.duration), 0);
  const failingWindow =
    windowStartAbs != null
      ? {
          start: Math.max(0, windowStartAbs - timelineStart),
          end: Math.max(0, (windowEndAbs ?? timelineStart + timelineDuration) - timelineStart),
        }
      : null;

  return {
    status: 'ok',
    requests,
    timelineDuration,
    failingWindow,
    truncated,
    totalBeforeCap: ordered.length,
  };
}

function nonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && value >= 0 ? value : undefined;
}

export function inferResourceType(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  if (mimeType.includes('html')) return 'document';
  if (mimeType.includes('json')) return 'fetch';
  if (mimeType.includes('css')) return 'stylesheet';
  if (mimeType.includes('javascript')) return 'script';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('font/') || mimeType.includes('font')) return 'font';
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return 'media';
  return 'other';
}

/**
 * Match a client-requested body id against the resource names the trace's own
 * network stream references (`_sha1` in v8 traces, `_file` in v9) — request
 * bodies can only address resources this trace carries, with or without the
 * stored extension. Returns the stored resource name plus its mimeType, or null.
 */
export function matchNetworkBodySha1(
  snapshots: TraceResourceSnapshot[],
  requested: string,
): { name: string; mimeType?: string } | null {
  for (const snapshot of snapshots) {
    for (const carrier of [snapshot.response?.content, snapshot.request?.postData] as Array<
      { _sha1?: string; _file?: string; mimeType?: string } | undefined
    >) {
      const name = resourceBodyName(carrier);
      if (!name) continue;
      if (name === requested || name.split('.')[0] === requested.split('.')[0]) {
        return { name, mimeType: carrier?.mimeType };
      }
    }
  }
  return null;
}

/** The most frames {@link buildTraceFrames} lists for one trace; past it, an even sample of them. */
export const MAX_TRACE_FRAMES = 1000;

/** The most pages {@link buildTraceFrames} lists: the first ones the trace painted. */
export const MAX_TRACE_FRAME_PAGES = 10;

/**
 * The trace's screencast, page by page, each frame on the wall clock the
 * timeline reads (epoch ms). It lists the first {@link MAX_TRACE_FRAME_PAGES}
 * pages; past {@link MAX_TRACE_FRAMES} frames, each page lists an even sample
 * of its frames, its first and last included, sized by its share of them.
 * Node-free, so the server and the demo produce the same answer.
 */
export function buildTraceFrames(parsed: ParsedTraceData | null): TraceFramesResponse {
  if (!parsed) return { status: 'no-trace', pages: [], total: 0, capped: false, startEpochMs: null };
  const total = parsed.screencastFrames.length;
  const startEpochMs = traceStartEpochMs(parsed);
  const toWall = wallClockOf(parsed.contexts);
  if (!toWall || total === 0) return { status: 'no-frames', pages: [], total, capped: false, startEpochMs };

  const byPage = new Map<string, TraceScreencastFrame[]>();
  for (const frame of parsed.screencastFrames) {
    const frames = byPage.get(frame.pageId);
    if (frames) frames.push(frame);
    else byPage.set(frame.pageId, [frame]);
  }
  const ordered = [...byPage.values()]
    .map((frames) => [...frames].sort((a, b) => a.timestamp - b.timestamp))
    .sort((a, b) => a[0]!.timestamp - b[0]!.timestamp)
    .slice(0, MAX_TRACE_FRAME_PAGES);
  const listed = ordered.reduce((sum, frames) => sum + frames.length, 0);
  const pages: TraceFramePage[] = ordered.map((frames) => {
    const quota = Math.max(2, Math.floor((MAX_TRACE_FRAMES * frames.length) / listed));
    return {
      pageId: frames[0]!.pageId,
      frames: evenSample(frames, quota).map((f) => ({
        epochMs: toWall(f.timestamp),
        name: f.file,
        width: f.width,
        height: f.height,
      })),
    };
  });
  const kept = pages.reduce((sum, page) => sum + page.frames.length, 0);
  return { status: 'ok', pages, total, capped: kept < listed, startEpochMs };
}

/** `count` items (two or more) spread evenly over `items`, its first and last included. */
function evenSample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]!);
}

/** When the test started on the trace's clock: its test runner's header, else its first browser context's. */
function traceStartEpochMs(parsed: ParsedTraceData): number | null {
  const timed = parsed.contexts.filter((c) => typeof c.wallTime === 'number' && Number.isFinite(c.wallTime));
  const header = timed.find((c) => c.origin === 'testRunner') ?? timed[0];
  return header ? Math.round(header.wallTime!) : null;
}

/**
 * Where a screencast frame the trace recorded is stored: a `resources/` body
 * (before Playwright 1.63), or its own `screencast/` entry. Null for a name the
 * trace's events do not list, so no other entry of the archive is reachable.
 */
export function traceFrameSource(
  parsed: ParsedTraceData | null,
  name: string,
): { kind: 'resource'; name: string } | { kind: 'entry'; name: string } | null {
  if (!parsed?.screencastFrames.some((f) => f.file === name)) return null;
  if (name.startsWith('resources/')) return { kind: 'resource', name: name.slice('resources/'.length) };
  if (name.startsWith('screencast/')) return { kind: 'entry', name };
  return null;
}

/** The content type of a JPEG, PNG or WebP image by its first bytes; null for anything else. */
export function traceImageContentType(bytes: Uint8Array): string | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** Whether an action carries any aria or screen snapshot (either phase). */
function actionHasSnapshot(a: TraceAction): boolean {
  return !!(a.ariaSnapshotBefore || a.ariaSnapshotAfter || a.screenshotBefore || a.screenshotAfter);
}

/** The trace-relative file recorded for one action's snapshot phase, or null. */
export function resolveSnapshotFile(
  parsed: ParsedTraceData | null,
  callId: string,
  kind: 'aria' | 'screen',
  phase: 'before' | 'after',
): string | null {
  const action = parsed?.actions.find((a) => a.callId === callId);
  if (!action) return null;
  if (kind === 'aria') return (phase === 'before' ? action.ariaSnapshotBefore : action.ariaSnapshotAfter) ?? null;
  return (phase === 'before' ? action.screenshotBefore : action.screenshotAfter) ?? null;
}

/**
 * The snapshotted action the failure belongs to: the failing action itself when
 * it carries a snapshot, else the page-side action it drove (an assertion
 * failure keys the error to a runner step that carries none, while the page
 * call inside it does), otherwise the last snapshotted action. Its callId
 * marks the failing step.
 */
function failureSnapshotCallId(parsed: ParsedTraceData): string | null {
  const snapshotted = parsed.actions.filter(actionHasSnapshot);
  if (snapshotted.length === 0) return null;
  const failing = parsed.failingAction;
  if (failing && snapshotted.some((a) => a.callId === failing.callId)) return failing.callId;
  const pageAction = pageActionOf(parsed, failing);
  if (pageAction && actionHasSnapshot(pageAction)) return pageAction.callId;
  return snapshotted[snapshotted.length - 1]!.callId;
}

/**
 * Build the per-action aria / screen snapshot inventory and the in-execution
 * page diff from a parsed trace. `readAriaText` returns the text form of an
 * `aria/*.json` file (via `ariaJsonToText`). Node-free, so the server and the
 * demo produce the same answer.
 */
export function buildTraceSnapshots(
  parsed: ParsedTraceData | null,
  readAriaText: (file: string) => string | null,
): TraceSnapshotsResponse {
  if (!parsed) return { status: 'no-trace', steps: [], failingCallId: null, hasAria: false, hasScreen: false };

  const failingCallId = failureSnapshotCallId(parsed);
  const steps: TraceSnapshotStep[] = parsed.actions.filter(actionHasSnapshot).map((a, i) => ({
    callId: a.callId,
    index: i,
    title: a.apiName || a.method || 'step',
    failed: a.callId === failingCallId,
    startTime: a.startTime,
    aria: { before: !!a.ariaSnapshotBefore, after: !!a.ariaSnapshotAfter },
    screen: { before: !!a.screenshotBefore, after: !!a.screenshotAfter },
  }));

  if (steps.length === 0) return { status: 'no-snapshots', steps: [], failingCallId, hasAria: false, hasScreen: false };

  const hasAria = steps.some((s) => s.aria.before || s.aria.after);
  const hasScreen = steps.some((s) => s.screen.before || s.screen.after);
  return {
    status: 'ok',
    steps,
    failingCallId,
    hasAria,
    hasScreen,
    pageDiff: pageDiffToFailure(parsed, failingCallId, readAriaText),
    failingAriaText: failingActionAriaText(parsed, failingCallId, readAriaText),
  };
}

/** Longest failing-step aria tree kept in the response; a larger one is capped. */
const FAILING_ARIA_MAX_CHARS = 20_000;

/**
 * The accessibility tree of the page *at the failing step*, as ARIA text — the
 * failing action's after-phase snapshot when it recorded one, else its
 * before-phase. This is the page state the timeline surfaces on the step that
 * raised the error. Null when the failing step recorded no aria snapshot.
 */
function failingActionAriaText(
  parsed: ParsedTraceData,
  failingCallId: string | null,
  readAriaText: (file: string) => string | null,
): string | null {
  if (!failingCallId) return null;
  const action = parsed.actions.find((a) => a.callId === failingCallId);
  const file = action?.ariaSnapshotAfter ?? action?.ariaSnapshotBefore;
  if (!file) return null;
  const text = readAriaText(file);
  if (text == null) return null;
  return text.length > FAILING_ARIA_MAX_CHARS ? `${text.slice(0, FAILING_ARIA_MAX_CHARS)}\n# … (truncated)` : text;
}

/**
 * Diff the page *at the failure* against the last preceding page that differs
 * from it. The failure page is the failing step's latest aria tree; the baseline
 * walks back through the earlier snapshots so the diff isolates the change that
 * led to the failure (the button that got disabled, the row that vanished)
 * rather than every action in between. Null when nothing before it differed.
 */
function pageDiffToFailure(
  parsed: ParsedTraceData,
  failingCallId: string | null,
  readAriaText: (file: string) => string | null,
): TraceSnapshotsResponse['pageDiff'] {
  // Every aria snapshot in trace order — before then after per action.
  const timeline: string[] = [];
  for (const a of parsed.actions) {
    if (a.ariaSnapshotBefore) timeline.push(a.ariaSnapshotBefore);
    if (a.ariaSnapshotAfter) timeline.push(a.ariaSnapshotAfter);
  }
  if (timeline.length < 2) return null;

  const failing = failingCallId ? parsed.actions.find((a) => a.callId === failingCallId) : null;
  const failFile = failing?.ariaSnapshotAfter ?? failing?.ariaSnapshotBefore ?? timeline[timeline.length - 1]!;
  const failIndex = timeline.lastIndexOf(failFile);
  const afterText = readAriaText(failFile);
  if (afterText == null) return null;

  for (let i = failIndex - 1; i >= 0; i--) {
    const beforeText = readAriaText(timeline[i]!);
    if (beforeText != null && beforeText !== afterText) {
      const { summary, hunks } = diffAriaSnapshots(beforeText, afterText);
      return { summary, hunks };
    }
  }
  return null;
}

const TEXT_BODY_CAP_CHARS = 100_000;
const IMAGE_BODY_CAP_BYTES = 1_500_000;

const TEXTUAL_MIME_RE = /^text\/|json|xml|javascript|svg|x-www-form-urlencoded/;

/**
 * Classify and render one body resource for preview: JSON pretty-printed and
 * masked, text masked, images as a data URI — everything capped. Node-free so
 * the demo serves previews from ZIP entries with the same code.
 */
export function buildTraceBodyPreview(bytes: Uint8Array, mimeType: string | undefined): TraceBodyResponse {
  const size = bytes.length;
  const mime = mimeType ?? '';

  if (mime.startsWith('image/')) {
    if (size > IMAGE_BODY_CAP_BYTES) return { status: 'too-large', mimeType, size };
    return { status: 'ok', kind: 'image', dataUri: `data:${mime};base64,${bytesToBase64(bytes)}`, mimeType, size };
  }

  if (TEXTUAL_MIME_RE.test(mime)) {
    let text = decodeText(bytes);
    let kind: 'json' | 'text' = 'text';
    if (mime.includes('json')) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
        kind = 'json';
      } catch {
        // Not valid JSON after all — fall through as plain text.
      }
    }
    const { content, truncated } = maskBodyText(text, TEXT_BODY_CAP_CHARS);
    return { status: 'ok', kind, content, mimeType, size, truncated };
  }

  return { status: 'unsupported', mimeType, size };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// AI diagnosis section formatting (shared by the server context builder and
// the demo's diagnosis-context mirror — single source of the markdown)
// ---------------------------------------------------------------------------

/**
 * Render the trace call stack as a diagnosis-context markdown section:
 * in-project frames bold with a `>`-marked source window, dependency frames
 * one-line. Returns null when there is nothing to show.
 */
export function formatTraceCallStackSection(
  result: TraceCallStackResponse,
  maxFrames: number,
): { markdown: string; coverage: { frames: number; framesWithSource: number } } | null {
  if (result.status !== 'ok' || !result.frames?.length || maxFrames <= 0) return null;

  const frames = result.frames.slice(0, maxFrames);
  const failedIndex = Math.max(
    0,
    frames.findIndex((f) => f.inProject),
  );
  const lines: string[] = ['## Full Call Stack (from trace)'];
  if (result.apiName) {
    lines.push(`Failing action: \`${result.apiName}\`${result.errorMessage ? ` — ${result.errorMessage}` : ''}`);
  }
  frames.forEach((frame, i) => {
    const fn = frame.functionName ? ` in \`${frame.functionName}\`` : '';
    if (!frame.inProject) {
      lines.push(`- ${frame.file}:${frame.line}${fn} (dependency)`);
      return;
    }
    lines.push(`- **${frame.file}:${frame.line}**${fn}${i === failedIndex ? ' ← failed here' : ''}`);
    if (frame.source) {
      const code = frame.source.lines.map((text, j) => {
        const n = frame.source!.startLine + j;
        return `${n === frame.line ? '>' : ' '} ${String(n).padStart(4)} | ${text}`;
      });
      lines.push('```', ...code, '```');
    }
  });
  if (result.frames.length > frames.length) {
    lines.push(`- … ${result.frames.length - frames.length} more frames (capped)`);
  }

  return {
    markdown: lines.join('\n'),
    coverage: { frames: frames.length, framesWithSource: frames.filter((f) => f.source).length },
  };
}

/**
 * Pick the requests worth showing the model: failed first, then during the
 * failing action, then slow — chronological within the cap.
 */
export function selectTraceNetworkRequests(
  result: TraceNetworkResponse,
  maxRequests: number,
  slowRequestMs: number,
): TraceNetworkEntry[] {
  if (result.status !== 'ok' || !result.requests?.length || maxRequests <= 0) return [];
  const score = (r: TraceNetworkEntry) =>
    (r.failed ? 4 : 0) + (r.duringFailure ? 2 : 0) + (r.duration >= slowRequestMs ? 1 : 0);
  return [...result.requests]
    .sort((a, b) => score(b) - score(a) || a.start - b.start)
    .slice(0, maxRequests)
    .sort((a, b) => a.start - b.start);
}

/** A masked body excerpt appended to the network section for a failed request. */
export interface TraceNetworkBodyExcerpt {
  label: string;
  content: string;
}

/**
 * Render the trace network activity as a diagnosis-context markdown section.
 * `picked` comes from {@link selectTraceNetworkRequests}; body excerpts are
 * fetched by the caller (server: storage pool, demo: ZIP entries).
 */
export function formatTraceNetworkSection(
  result: TraceNetworkResponse,
  picked: TraceNetworkEntry[],
  bodyExcerpts: TraceNetworkBodyExcerpt[] = [],
): { markdown: string; coverage: { requests: number; failed: number } } | null {
  if (result.status !== 'ok' || !result.requests?.length || picked.length === 0) return null;

  const all = result.requests;
  const failedCount = all.filter((r) => r.failed).length;
  const duringCount = all.filter((r) => r.duringFailure).length;
  const summaryBits = [
    `${all.length} requests recorded`,
    failedCount > 0 ? `${failedCount} failed` : null,
    duringCount > 0 ? `${duringCount} overlapping the failing action` : null,
  ].filter(Boolean);
  const lines: string[] = [
    '## Network Activity (from trace)',
    `${summaryBits.join(', ')}. Showing ${picked.length} (failed / during-failure / slow first, then chronological):`,
  ];
  for (const r of picked) {
    const status = r.status > 0 ? String(r.status) : `failed${r.failureText ? ` (${r.failureText})` : ''}`;
    const meta = [
      `${Math.round(r.duration)}ms`,
      r.responseBodySize != null ? formatByteSize(r.responseBodySize) : null,
      r.mimeType ?? null,
    ]
      .filter(Boolean)
      .join(', ');
    const marks = [r.duringFailure ? 'DURING FAILING ACTION' : null, r.failed ? 'FAILED' : null].filter(Boolean);
    lines.push(`- ${r.method} ${r.url} → ${status} (${meta})${marks.length ? ` [${marks.join(', ')}]` : ''}`);
  }
  for (const excerpt of bodyExcerpts) {
    lines.push('', `${excerpt.label}:`, '```', excerpt.content, '```');
  }

  return {
    markdown: lines.join('\n'),
    coverage: { requests: all.length, failed: failedCount },
  };
}

function formatByteSize(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}
