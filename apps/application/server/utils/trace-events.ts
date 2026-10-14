/**
 * Node-free trace event parsing: turn the JSONL event streams inside a
 * Playwright trace ZIP into structured actions / console / network / DOM
 * snapshot data. Lives in its own module (like `dom-snapshot-aria.ts`) so the
 * browser demo can parse the committed demo trace with the exact same code the
 * server uses — only ZIP inflation differs per runtime (node zlib in
 * `trace-zip.ts`, DecompressionStream in the demo).
 *
 * We only parse what is useful for the diagnosis context and DOM snapshots.
 */
import { stripAnsi } from '#shared/error-parse';
import { sameCodeLocation } from '#shared/step-tree';
import { safeStorageSegment } from './sanitize-filename';

/** A source position, as a trace records a call site or an error's stack frame. */
export interface TraceSourceFrame {
  file: string;
  line: number;
  column: number;
}

export interface TraceAction {
  callId: string;
  apiName: string;
  class?: string;
  method?: string;
  params?: Record<string, unknown>;
  startTime: number;
  endTime?: number;
  error?: { message?: string; stack?: string };
  pageId?: string;
  /** The runner step this action ran inside (`Test.*` actions nest: a `test.step` holds its calls). */
  parentId?: string;
  /** The call site: the first frame of the stack the trace recorded for the action. */
  location?: TraceSourceFrame;
  wallTime?: number;
  log?: string[];
  snapshotName?: string;
  beforeSnapshot?: string;
  afterSnapshot?: string;
  /**
   * Trace-relative path of the aria-tree JSON captured before / after this
   * action (`aria/<callId>-<phase>.json`), present when the trace was recorded
   * with `snapshots.aria` (Playwright 1.63+).
   */
  ariaSnapshotBefore?: string;
  ariaSnapshotAfter?: string;
  /**
   * Trace-relative path of the PNG captured before / after this action
   * (`screenshots/<callId>-<phase>.png`), present when the trace was recorded
   * with `snapshots.screen`.
   */
  screenshotBefore?: string;
  screenshotAfter?: string;
  /**
   * Where the action put the mouse, in viewport pixels: the `point` of its
   * `input` event, recorded for a pointer action (click, hover, `mouse.move`…).
   */
  point?: { x: number; y: number };
}

export interface TraceConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
  /** Legacy traces carry a preformatted string; modern ones a structured location. */
  location?: string | { url?: string; lineNumber?: number; columnNumber?: number };
}

export interface TraceNetworkRequest {
  url: string;
  method: string;
  statusCode?: number;
  headers?: Record<string, string>;
  startTime: number;
  endTime?: number;
}

/**
 * One `frame-snapshot` event from the trace: the serialized DOM Playwright
 * captured before/after an action. `html` is the internal node-array format
 * (`[TAG, {attrs}, ...children]`, back-references as `[[snapshotsAgo, nodeIndex]]`)
 * rendered by `renderSnapshotHtml` (dom-snapshot-render.ts).
 */
export interface TraceFrameSnapshot {
  callId?: string;
  snapshotName?: string;
  /** v9 traces key a snapshot by `callId` + `phase` (`before`/`action`/`after`) instead of `snapshotName`. */
  phase?: string;
  pageId?: string;
  frameId?: string;
  frameUrl?: string;
  doctype?: string;
  html: unknown;
  isMainFrame?: boolean;
  /** The page's viewport size when the snapshot was taken (for scaled rendering). */
  viewport?: { width: number; height: number };
}

/**
 * A `context-options` header. Every trace opens with one per recorded context:
 * `origin: 'testRunner'` carries the test-level facts (timeout, start), while
 * `origin: 'library'` carries the browser context (name, viewport, locale) and
 * the display title `file:line › suite › … › test`.
 */
export interface TraceContextOptions {
  origin?: string;
  browserName?: string;
  title?: string;
  /** Epoch ms when the context opened — the anchor for the monotonic clock. */
  wallTime?: number;
  /** Monotonic ms at the same instant as `wallTime`. */
  monotonicTime?: number;
  playwrightVersion?: string;
  platform?: string;
  testTimeout?: number;
  options?: Record<string, unknown>;
}

/** A top-level `error` event: one of the errors the test ended with. */
export interface TraceErrorEvent {
  message?: string;
  stack?: Array<{ file?: string; line?: number; column?: number }>;
}

export interface ParsedTraceData {
  actions: TraceAction[];
  consoleEntries: TraceConsoleEntry[];
  networkRequests: TraceNetworkRequest[];
  /** DOM snapshots in trace order (back-references resolve against earlier ones). */
  frameSnapshots: TraceFrameSnapshot[];
  /**
   * The action that raised the test's own error (see `fatalActionIndex`), else
   * the action a test timeout interrupted.
   */
  failingAction: TraceAction | null;
  /** Failing action index in `actions` array for nearby context. */
  failingActionIndex: number;
  /** `context-options` headers in trace order (runner context first). */
  contexts: TraceContextOptions[];
  /** Top-level `error` events — present when the trace recorded a failure. */
  errors: TraceErrorEvent[];
  /** All parsed events (raw), for building the summary. */
  eventCount: number;
  /** True when the failing action was identified by timeout fallback (no action had an error). */
  timeoutFallback: boolean;
  /**
   * Largest timestamp observed anywhere in the trace, in the same timebase as
   * action startTime/endTime. 0 when no timestamp was found.
   */
  traceEndTime: number;
}

/**
 * Order the trace event files: the runner-level `test.trace` first, then the
 * per-context files (`0-trace.trace`, `1-trace.trace`, …) in numeric order, then
 * anything else. Keeps the action timeline coherent when several files are
 * concatenated; snapshot back-references resolve per-frame so cross-file order
 * never affects DOM rendering.
 */
export function traceFileRank(name: string): number {
  if (name === 'test.trace' || name === 'trace.trace') return -1;
  const m = name.match(/^(\d+)-trace\.trace$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Parse the decoded text of one or more `*.trace` JSONL files (already ordered
 * by `traceFileRank`) into structured trace data. Unparseable lines are
 * skipped, never thrown on.
 */
export function parseTraceTexts(texts: string[]): ParsedTraceData {
  const events = texts
    .flatMap((text) => text.split('\n'))
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Record<string, unknown>[];

  return extractFromEvents(events);
}

/** A captured response body: the filename naming its stored body, plus its recorded MIME type. */
export interface TraceResource {
  /** The resource filename in the project's shared `trace-resources` pool (the ZIP's `resources/` entry name, prefix stripped). */
  sha1: string;
  /** The recorded `Content-Type` (`response.content.mimeType`), when known — names the data: URI. */
  mimeType?: string;
}

/** The bare `resources/` filename a response body is stored under, from either trace format. */
function resourceBodyName(content: { _sha1?: unknown; _file?: unknown } | undefined): string | null {
  // Trace format v8 names the stored body `_sha1` (a bare filename such as
  // `<hash>.css`); v9 — Playwright's current format — renamed it to `_file` and
  // prefixes it with `resources/`. Both name the same on-disk file: reduce either
  // to the bare filename the pool (`trace-resources/<name>`) and the demo ZIP
  // (`resources/<name>`) are keyed by.
  const ref =
    typeof content?._sha1 === 'string' ? content._sha1 : typeof content?._file === 'string' ? content._file : '';
  // The name addresses the storage pool, so it must be a single path segment.
  return safeStorageSegment(ref.replace(/^resources\//, ''));
}

/**
 * Map every resource URL captured in a trace's `.network` stream to the stored
 * body naming it and its MIME type. Used to inline a DOM snapshot's external
 * assets: a `<link href>` (or a CSS `url(...)`) resolves to a URL here, whose
 * filename names the body in the project's shared `trace-resources` pool.
 * Later snapshots win on duplicate URLs. Node-free (shared with the browser
 * demo, which reads `resources/<name>` straight from the ZIP). Unparseable lines
 * are skipped.
 */
export function parseResourceSnapshots(texts: string[]): Map<string, TraceResource> {
  const map = new Map<string, TraceResource>();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (!evt || evt.type !== 'resource-snapshot') continue;
      const snapshot = evt.snapshot as Record<string, unknown> | undefined;
      const request = snapshot?.request as { url?: unknown } | undefined;
      const content = (
        snapshot?.response as { content?: { _sha1?: unknown; _file?: unknown; mimeType?: unknown } } | undefined
      )?.content;
      const url = request?.url;
      const sha1 = resourceBodyName(content);
      if (typeof url === 'string' && url && sha1) {
        map.set(url, { sha1, mimeType: typeof content?.mimeType === 'string' ? content.mimeType : undefined });
      }
    }
  }
  return map;
}

function extractFromEvents(events: Record<string, unknown>[]): ParsedTraceData {
  const actions: TraceAction[] = [];
  const consoleEntries: TraceConsoleEntry[] = [];
  const networkRequests: TraceNetworkRequest[] = [];
  const frameSnapshots: TraceFrameSnapshot[] = [];
  const contexts: TraceContextOptions[] = [];
  const errors: TraceErrorEvent[] = [];

  // Map callId → beforeSnapshot/afterSnapshot from before/after events
  const beforeSnapshots = new Map<string, string>();
  const afterSnapshots = new Map<string, string>();

  // Modern traces split each call into a `before` event (opens the action) and
  // an `after` event (closes it with endTime/error), with standalone `log`
  // events in between; legacy traces carry one self-contained `action` event.
  // Open modern actions are keyed here until their `after` arrives — an action
  // left unclosed (test killed mid-call) keeps `endTime` undefined, which is
  // exactly what the timeout fallback below looks for.
  const openActions = new Map<string, TraceAction>();

  // Largest timestamp seen across all events, in the trace's own timebase.
  let traceEndTime = 0;

  for (const evt of events) {
    const type = evt.type as string;

    // Fold in any timestamp this event carries so traceEndTime tracks the last
    // moment the trace recorded (used as an upper bound for timed-out actions).
    for (const key of ['time', 'startTime', 'endTime'] as const) {
      const ts = evt[key];
      if (typeof ts === 'number' && Number.isFinite(ts) && ts > traceEndTime) {
        traceEndTime = ts;
      }
    }

    if (type === 'before') {
      const callId = evt.callId as string;
      if (!callId) continue;
      const pointers = (evt.pointers ?? {}) as Record<string, string>;
      // v8 `before` events carry the snapshot name; v9 omits it and instead emits a
      // standalone `frame-snapshot` with `phase: 'before'`, named `before@${callId}`
      // above. Fall back to that name so the failing action still points at its
      // before-snapshot; a name with no matching snapshot is simply skipped by
      // extractDomSnapshot, so this is safe when an action captured none.
      const beforeSnapshot = (evt.beforeSnapshot as string) || pointers.beforeSnapshot || `before@${callId}`;
      if (beforeSnapshot) beforeSnapshots.set(callId, beforeSnapshot);
      const cls = evt.class as string | undefined;
      const method = evt.method as string | undefined;
      const action: TraceAction = {
        callId,
        apiName: (evt.apiName as string) || (cls && method ? `${cls}.${method}` : method || 'unknown'),
        class: cls,
        method,
        params: evt.params as Record<string, unknown> | undefined,
        startTime: (evt.startTime as number) ?? 0,
        pageId: evt.pageId as string | undefined,
        beforeSnapshot,
      };
      if (typeof evt.parentId === 'string') action.parentId = evt.parentId;
      const location = topFrame(evt.stack);
      if (location) action.location = location;
      openActions.set(callId, action);
      actions.push(action);
    }

    if (type === 'after') {
      const callId = evt.callId as string;
      const action = callId ? openActions.get(callId) : undefined;
      if (action) {
        if (typeof evt.endTime === 'number') action.endTime = evt.endTime;
        const error = unwrapAfterError(evt.error);
        if (error) action.error = error;
        // Same v8/v9 split as the `before` event: v9 omits the pointer and emits a
        // `frame-snapshot` with `phase: 'after'`, named `after@${callId}` above.
        const afterSnapshot =
          (evt.afterSnapshot as string) ||
          ((evt.pointers as Record<string, string> | undefined)?.afterSnapshot ?? '') ||
          `after@${callId}`;
        if (afterSnapshot) {
          action.afterSnapshot = afterSnapshot;
          afterSnapshots.set(callId, afterSnapshot);
        }
      }
    }

    if (type === 'input') {
      const callId = evt.callId as string;
      const action = callId ? openActions.get(callId) : undefined;
      const point = evt.point as { x?: unknown; y?: unknown } | undefined;
      if (action && typeof point?.x === 'number' && typeof point.y === 'number') {
        action.point = { x: point.x, y: point.y };
      }
    }

    if (type === 'log') {
      const callId = evt.callId as string;
      const message = evt.message as string | undefined;
      const action = callId ? openActions.get(callId) : undefined;
      if (action && message) (action.log ??= []).push(message);
    }

    if (type === 'context-options') {
      contexts.push(evt as TraceContextOptions);
    }

    if (type === 'error' && (typeof evt.message === 'string' || Array.isArray(evt.stack))) {
      errors.push(evt as TraceErrorEvent);
    }

    if (type === 'frame-snapshot' && evt.snapshot && typeof evt.snapshot === 'object') {
      const snapshot = evt.snapshot as TraceFrameSnapshot;
      // Trace format v9 (Playwright's current format) dropped `snapshotName` and
      // identifies a frame snapshot by `callId` + `phase` instead. Rebuild the v8
      // `${phase}@${callId}` name so the existing name-based matching keeps working
      // (renderSnapshotHtml, extractDomSnapshot, and the action pointers below).
      if (!snapshot.snapshotName && snapshot.callId && snapshot.phase) {
        snapshot.snapshotName = `${snapshot.phase}@${snapshot.callId}`;
      }
      frameSnapshots.push(snapshot);
    }

    // 1.63 aria / screen snapshots: one file per action per phase, keyed to the
    // action's callId (the `before` event opened the action just before). The
    // recorder emits `before`, an optional input-time `action`, and `after`; the
    // `action` and `after` phases both stand for "after the action" — `after`
    // wins because it arrives last in the stream.
    if (type === 'aria-snapshot' || type === 'screenshot') {
      const callId = evt.callId as string;
      const file = evt.file as string | undefined;
      const phase = evt.phase as string | undefined;
      const action = callId ? openActions.get(callId) : undefined;
      if (action && file) {
        if (phase === 'before') {
          if (type === 'aria-snapshot') action.ariaSnapshotBefore = file;
          else action.screenshotBefore = file;
        } else if (phase === 'action' || phase === 'after') {
          if (type === 'aria-snapshot') action.ariaSnapshotAfter = file;
          else action.screenshotAfter = file;
        }
      }
    }

    // Modern traces emit console messages as their own top-level event; older
    // ones wrap them in a generic `event` with `method: 'console'` (below).
    if (type === 'console') {
      const text =
        (evt.text as string) ??
        (Array.isArray(evt.args)
          ? (evt.args as Array<Record<string, unknown>>).map((a) => String(a?.value ?? a?.preview ?? '')).join(' ')
          : '');
      if (text) {
        consoleEntries.push({
          type: (evt.messageType as string) || 'log',
          text,
          timestamp: (evt.time as number) ?? 0,
          location: evt.location as TraceConsoleEntry['location'],
        });
      }
    }

    if (type === 'action') {
      const callId = evt.callId as string;
      if (!callId) continue;
      const pointers = (evt.pointers ?? {}) as Record<string, string>;
      const action: TraceAction = {
        callId,
        apiName: (evt.apiName as string) || (evt.method as string) || 'unknown',
        class: evt.class as string,
        method: evt.method as string,
        params: evt.params as Record<string, unknown> | undefined,
        startTime: (evt.startTime as number) ?? 0,
        endTime: evt.endTime as number | undefined,
        error: evt.error as { message?: string; stack?: string } | undefined,
        pageId: evt.pageId as string,
        parentId: typeof evt.parentId === 'string' ? evt.parentId : undefined,
        location: topFrame(evt.stack),
        log: evt.log as string[] | undefined,
        snapshotName: (pointers.snapshot as string) || pointers.afterSnapshot,
        beforeSnapshot: beforeSnapshots.get(callId) || (pointers.beforeSnapshot as string),
        afterSnapshot: pointers.afterSnapshot as string,
      };
      // A trace that carries both a `before` and an `action` for the same call
      // gets the self-contained event's defined fields folded into the open
      // action rather than a duplicate row.
      const open = openActions.get(callId);
      if (open) {
        for (const [key, value] of Object.entries(action)) {
          if (value !== undefined) (open as unknown as Record<string, unknown>)[key] = value;
        }
      } else {
        actions.push(action);
      }

      // Track after-snapshot for nearby context
      if (pointers.afterSnapshot) afterSnapshots.set(callId, pointers.afterSnapshot);
    }

    if (type === 'event') {
      const method = evt.method as string;
      const eventData = evt.event as Record<string, unknown> | undefined;
      if (!eventData) continue;
      const timestamp = (evt.time as number) ?? (evt.startTime as number) ?? 0;

      if (method === 'console') {
        const text =
          (eventData.text as string) ??
          (Array.isArray(eventData.args) ? eventData.args.map((a: unknown) => String(a ?? '')).join(' ') : '');
        if (text) {
          consoleEntries.push({
            type: (eventData.type as string) || 'log',
            text,
            timestamp,
            location: eventData.location as string | undefined,
          });
        }
      }

      if (method === '__create__' || method === '__update__') {
        const url = eventData.url as string;
        if (url) {
          const existing = networkRequests.find((nr) => nr.url === url && nr.method === (eventData.method as string));
          if (existing) {
            if (eventData.response) {
              const resp = eventData.response as Record<string, unknown>;
              existing.statusCode = (resp.status as number) ?? (resp.statusCode as number);
              existing.endTime = timestamp;
            }
          } else {
            networkRequests.push({
              url,
              method: (eventData.method as string) || 'GET',
              statusCode:
                (eventData.statusCode as number) ??
                ((eventData.response as Record<string, unknown> | undefined)?.status as number | undefined),
              headers: eventData.headers as Record<string, string> | undefined,
              startTime: timestamp,
              endTime: timestamp,
            });
          }
        }
      }
    }
  }

  // Find the failing action: the one that raised the test's own error, then the
  // timeout fallback.
  let failingIndex = fatalActionIndex(actions, errors);
  let failingAction: TraceAction | null = failingIndex >= 0 ? actions[failingIndex]! : null;
  let timeoutFallback = false;

  // Timeout fallback: when no action has an error, the test was killed
  // mid-action. The interrupted action has no endTime and no error entry —
  // its log tail (e.g. "waiting for locator(…)") is the most diagnostic fact.
  if (!failingAction && actions.length > 0) {
    failingIndex = actions.length - 1;
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i]!.endTime == null && !actions[i]!.error) {
        failingIndex = i;
        break;
      }
    }
    failingAction = actions[failingIndex]!;
    timeoutFallback = true;
  }

  return {
    actions,
    consoleEntries,
    networkRequests,
    frameSnapshots,
    contexts,
    errors,
    failingAction,
    failingActionIndex: failingAction ? failingIndex : -1,
    eventCount: events.length,
    timeoutFallback,
    traceEndTime,
  };
}

/** The first frame of a recorded stack, when it names a file and a line. */
function topFrame(stack: unknown): TraceSourceFrame | undefined {
  const frame = Array.isArray(stack) ? (stack[0] as Record<string, unknown> | undefined) : undefined;
  if (typeof frame?.file !== 'string' || typeof frame.line !== 'number') return undefined;
  return { file: frame.file, line: frame.line, column: typeof frame.column === 'number' ? frame.column : 0 };
}

/** The first line of an error message, without ANSI codes. */
function firstLine(message: string | undefined): string {
  return stripAnsi(message ?? '')
    .split('\n')[0]!
    .trim();
}

/**
 * The action that raised the test's own error. A run can hold several errored
 * actions: an error the test caught and went on from, a runner step around the
 * action that threw (it carries the same error), and the page-side twin of a
 * runner action (`Frame.expect`, which only says `Expect failed`). The trace's
 * test-level `error` events name the errors the test ended with, in order: the
 * action whose error reads the same first line and was called where the event's
 * stack points wins, then one that matches the first line alone — the innermost
 * of them, and the latest when several remain. Without a match, the latest
 * errored action, preferring the runner's `Test.*` actions. -1 when no action
 * errored.
 */
export function fatalActionIndex(actions: readonly TraceAction[], errors: readonly TraceErrorEvent[]): number {
  const errored = actions.flatMap((action, i) => (action.error ? [i] : []));
  if (errored.length === 0) return -1;
  const headOf = (i: number) => firstLine(actions[i]!.error!.message);
  for (const error of errors) {
    const head = firstLine(error.message);
    const frame = topFrame(error.stack);
    if (!head || !frame) continue;
    const thrownThere = errored.filter((i) => headOf(i) === head && sameCodeLocation(actions[i]!.location, frame));
    if (thrownThere.length > 0) return innermostAction(actions, thrownThere);
  }
  for (const error of errors) {
    const head = firstLine(error.message);
    const matching = errored.filter((i) => head && headOf(i) === head);
    if (matching.length > 0) return innermostAction(actions, matching);
  }
  const runner = errored.filter((i) => actions[i]!.class === 'Test');
  return latestAction(actions, runner.length > 0 ? runner : errored);
}

const actionsById = new WeakMap<readonly TraceAction[], Map<string, TraceAction>>();

/**
 * Whether action `outer` holds action `inner`: `outer` is on `inner`'s runner
 * parent chain, or, when `inner` records no parent, `outer` is a runner action
 * whose time span contains it.
 */
export function actionHolds(actions: readonly TraceAction[], outer: TraceAction, inner: TraceAction): boolean {
  if (outer === inner) return false;
  if (inner.parentId) {
    let byId = actionsById.get(actions);
    if (!byId) actionsById.set(actions, (byId = new Map(actions.map((a) => [a.callId, a]))));
    for (let p = byId.get(inner.parentId); p; p = p.parentId ? byId.get(p.parentId) : undefined) {
      if (p === outer) return true;
    }
    return false;
  }
  return (
    outer.class === 'Test' &&
    outer.startTime <= inner.startTime &&
    (inner.endTime ?? Number.POSITIVE_INFINITY) <= (outer.endTime ?? Number.POSITIVE_INFINITY)
  );
}

/** The innermost of `indices` (one that holds none of the others), the latest when several are. */
function innermostAction(actions: readonly TraceAction[], indices: number[]): number {
  const leaves = indices.filter((i) => !indices.some((j) => actionHolds(actions, actions[i]!, actions[j]!)));
  return latestAction(actions, leaves.length > 0 ? leaves : indices);
}

/** The action of `indices` that started last, the later one in the list on a tie. */
function latestAction(actions: readonly TraceAction[], indices: number[]): number {
  return indices.reduce((best, i) => (actions[i]!.startTime >= actions[best]!.startTime ? i : best));
}

/**
 * The page-side action a runner action (`Test.*`) drove: the snapshots and the
 * aria and screen captures live on the library call (`Frame.click`,
 * `Frame.expect`), which runs inside the runner action's span. The last one
 * inside the span, an errored one first. Null for a library action, or when
 * none ran inside it.
 */
export function pageActionOf(parsed: Pick<ParsedTraceData, 'actions'>, action: TraceAction | null): TraceAction | null {
  if (!action || action.class !== 'Test') return null;
  const end = action.endTime ?? Number.POSITIVE_INFINITY;
  const inside = parsed.actions.filter(
    (a) =>
      a.class !== 'Test' &&
      a.startTime >= action.startTime - SPAN_TOLERANCE_MS &&
      (a.endTime ?? a.startTime) <= end + SPAN_TOLERANCE_MS,
  );
  const errored = inside.filter((a) => a.error);
  const pool = errored.length > 0 ? errored : inside;
  return pool[pool.length - 1] ?? null;
}

/** Slack for the rounding between the runner's clock readings and the library's. */
const SPAN_TOLERANCE_MS = 1;

/**
 * `after` events carry the failure either flat (`{ message, stack }`) or, in
 * some Playwright versions, nested one level (`{ error: { message, stack } }`).
 */
function unwrapAfterError(raw: unknown): { message?: string; stack?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const outer = raw as Record<string, unknown>;
  if (typeof outer.message === 'string' || typeof outer.stack === 'string') {
    return outer as { message?: string; stack?: string };
  }
  const inner = outer.error;
  if (inner && typeof inner === 'object') {
    const e = inner as Record<string, unknown>;
    if (typeof e.message === 'string' || typeof e.stack === 'string') {
      return e as { message?: string; stack?: string };
    }
  }
  return undefined;
}
