import * as path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { compressCallLog, MAX_LIVE_CALL_LOG_LINES, type LiveBox, type LiveCallLog } from '@piwitests/core/live-view';
import {
  hideSecretsInLog,
  hideSecretsInText,
  hideTypedText,
  isSecretLocator,
  namesSecretField,
} from '@piwitests/core/mask';
import { internalCall } from './quiet-capture.js';

/**
 * The call a test is in, as Playwright logs it while it runs, for a live view (`@piwitests/core/live-view`'s
 * `call-log`, and the `calls` layer of `@piwitests/core/live-layers`). Its calls come from one of two sources, each
 * checked before use (`CallSource`):
 *
 * - Playwright's call stream (`context.debugger`'s internal `_enable` and its `apicallsupdated` event): each running
 *   call's title, place, status, call log lines, the point an input action acts on, and its error, every half second.
 *   Turning it on tells the calls running then, with their log so far. Once on, it stays on in its context and moves
 *   where the debugger stops an action (before its input rather than before its wait), so `live-view.ts` turns it on
 *   only in a CI run nothing pauses; its calls are followed from then until the context goes, so a viewer who comes
 *   later sees the call shown at once.
 * - In a run Piwi may pause, Playwright's in-process instrumentation (`listener`): a listener on the context's server
 *   object (`context._connection.toImpl(context).instrumentation`, each member checked first), which hears each call of
 *   the context begin, log, act on its point and end, synchronously, as Playwright's own tracer does, pausing nothing
 *   and moving no stop. It is added as the first view of the context follows it and removed as the context closes. A
 *   browser the worker connected to has no in-process server: there, and on a Playwright of another shape, the call
 *   alone is followed, as the worker's instrumentation below hears it, without its log.
 * - The worker's Playwright instrumentation (`trackCalls`): when each call began and the selector of a locator call,
 *   which the call stream does not give, matched to the stream's calls by the id the runner gives each call.
 * - While a call has waited a second, the elements its selector matches, read once a second through `internalCall`:
 *   how many, the first one's box and whether it is enabled. They are read only while the watched page is its
 *   context's one page, so the call is on it, and left out when the call found an element the read finds none of (a
 *   call on a frame of the page); a read that fails leaves the last one.
 *
 * Each text has what may be a secret hidden (`hideTypedText`, `hideSecretsInLog`, `hideSecretsInText`) before it is
 * cut, as a view is told it, never before: a call nobody is shown costs no more than its record. The log's lines go
 * folded as Playwright folds a failed call's (`compressCallLog`). No hook throws into the call it hears.
 */

/** How long a call runs before the elements its locator matches are read, and how often they are read again. */
const TARGET_EVERY_MS = 1000;
/** The most lines of a call's log kept, folded before they are sent: a minute of an action's retries. */
const KEPT_LINES = 1000;
/** The longest line of a call's log kept, once what may be a secret in it is hidden. */
const MAX_LINE = 600;
/** The longest title kept, once the text it types is hidden. */
const MAX_TITLE = 500;
/** The most calls the instrumentation is heard running at once; past it, the ones heard first are forgotten. */
const MAX_HEARD = 200;

/** One update of Playwright's call stream, as Playwright 1.64 writes it. */
interface CallUpdate {
  id?: unknown;
  title?: unknown;
  location?: { file?: unknown; line?: unknown } | null;
  newLogEntries?: unknown;
  actionPoint?: { x?: unknown; y?: unknown } | null;
  status?: unknown;
  error?: unknown;
}

type CallListener = (calls: CallUpdate[]) => void;

/** The part of a context's debugger the call stream needs. */
interface CallStream {
  _enable(): Promise<void>;
  on(event: 'apicallsupdated', listener: CallListener): unknown;
  off(event: 'apicallsupdated', listener: CallListener): unknown;
}

/** A context's call stream; null on a Playwright without one. */
function callStreamOf(context: BrowserContext): CallStream | null {
  const dbg = (context as unknown as { debugger?: Partial<CallStream> }).debugger;
  return typeof dbg?._enable === 'function' && typeof dbg.on === 'function' && typeof dbg.off === 'function'
    ? (dbg as CallStream)
    : null;
}

/** A call of the worker's Playwright as its instrumentation heard it begin. */
interface HeardCall {
  /**
   * The call's zone, on which the runner writes the id of its step (`callId`, the id the call stream names it by;
   * `stepId` before Playwright 1.64).
   */
  zone: { callId?: unknown; stepId?: unknown; apiName?: unknown; title?: unknown };
  selector: string | null;
  began: number;
}

/** The id of the runner's step a call's zone names; null before the runner gave it one. */
function zoneStepId(zone: { callId?: unknown; stepId?: unknown } | null | undefined): string | null {
  if (typeof zone?.callId === 'string' && zone.callId) return zone.callId;
  return typeof zone?.stepId === 'string' && zone.stepId ? zone.stepId : null;
}

/** Where a view follows a context's calls from: the call stream, or the in-process instrumentation. */
export type CallSource = 'stream' | 'listener';

/** How a view follows the calls: from which source, and the title the runner gives a call by its id. */
export interface FollowOptions {
  source?: CallSource;
  titleOf?: (id: string) => string | null;
}

/** Who hears each call of the worker's Playwright end (`onCallEnded`): its id, once the runner gave it one. */
const endListeners = new Set<(id: string | null) => void>();

/** Hear each call of the worker's Playwright end, internal calls aside; returns what stops hearing them. */
export function onCallEnded(listener: (id: string | null) => void): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

/** A text a call of the worker's Playwright typed: its locator's selector (null for none: the keyboard's, an element's). */
export interface TypedValue {
  selector: string | null;
  value: string;
}

/** The calls that type text, and the parameter that holds it. */
const TYPING: ReadonlyMap<string, 'value' | 'text'> = new Map([
  ['fill', 'value'],
  ['type', 'text'],
  ['keyboardType', 'text'],
  ['keyboardInsertText', 'text'],
]);

/** Who hears each text a call types (`onTyped`). */
const typedListeners = new Set<(typed: TypedValue) => void>();

/** Hear each text a call of the worker's Playwright types as it begins, internal calls aside; returns what stops. */
export function onTyped(listener: (typed: TypedValue) => void): () => void {
  typedListeners.add(listener);
  return () => typedListeners.delete(listener);
}

/** Tell each listener in `listeners` `value`: none of them throws into the call. */
function tellAll<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      // A listener never breaks the test's call.
    }
  }
}

/** The calls of the worker's Playwright running now, by their zone. */
const heard = new Map<object, HeardCall>();
/** The Playwright instances whose calls are heard: one listener each. */
const tracked = new WeakSet<object>();

/**
 * Hear each call of the worker's Playwright as it begins (when, and a locator call's selector), and forget it as it
 * ends. The instrumentation never hears an internal call, so none of Piwi's own.
 */
export function trackCalls(playwright: unknown): void {
  const instrumentation = (playwright as { _instrumentation?: { addListener?: (listener: object) => void } } | null)
    ?._instrumentation;
  if (!playwright || tracked.has(playwright as object) || typeof instrumentation?.addListener !== 'function') return;
  tracked.add(playwright as object);
  instrumentation.addListener({
    onApiCallBegin: (zone: object, channel?: { method?: unknown; params?: Record<string, unknown> | null }) => {
      try {
        if (channel?.method === '__waitInfo__') return;
        const selector = channel?.params?.selector;
        const read = typeof selector === 'string' && selector ? selector : null;
        heard.set(zone, { zone, selector: read, began: Date.now() });
        if (heard.size > MAX_HEARD) heard.delete(heard.keys().next().value!);
        const key = typeof channel?.method === 'string' ? TYPING.get(channel.method) : undefined;
        const value = key ? channel?.params?.[key] : undefined;
        if (typeof value === 'string' && value) tellAll(typedListeners, { selector: read, value });
      } catch {
        // A call is heard, or not, but never broken.
      }
    },
    onApiCallEnd: (zone: { callId?: unknown; stepId?: unknown }) => {
      try {
        heard.delete(zone);
        tellAll(endListeners, zoneStepId(zone));
      } catch {
        // A call is heard, or not, but never broken.
      }
    },
  });
}

/** The call heard under the id the call stream names it by. */
function heardAs(id: string): HeardCall | null {
  for (const call of heard.values()) if (zoneStepId(call.zone) === id) return call;
  return null;
}

/** A call's file relative to the working directory, with forward slashes; null for one outside it or in a package. */
function userFile(file: unknown): string | null {
  if (typeof file !== 'string' || !file || /[\\/]node_modules[\\/]/.test(file)) return null;
  const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
}

/**
 * A call of a context as its source told it so far: what it heard as it heard it (`named`, `heardLines`,
 * `heardError`), and what a view is told, its secrets hidden once it is told (`title`, `lines`, `error`).
 */
interface Call {
  id: string;
  /** Its title as heard, used when the runner gives it none. */
  named: string;
  title: string | null;
  file: string | null;
  line: number | null;
  status: LiveCallLog['status'];
  heardLines: string[];
  lines: string[];
  point: { x: number; y: number } | null;
  heardError: string | null;
  error: string | null;
  began: number;
  ended: number | null;
  /** The order the stream told it in, among its context's calls. */
  order: number;
  selector: string | null;
  /** Its locator names a field that holds a secret: the values its assertion quotes are hidden. Null until told. */
  secretField: boolean | null;
}

/** A call as its source first heard it: told nothing yet. */
function heardCall(
  fields: Pick<Call, 'id' | 'named' | 'file' | 'line' | 'status' | 'began' | 'order' | 'selector'>,
): Call {
  return {
    ...fields,
    title: null,
    heardLines: [],
    lines: [],
    point: null,
    heardError: null,
    error: null,
    ended: null,
    secretField: null,
  };
}

/** Keep a line of a call's log as heard, `KEPT_LINES` at most: one past them only says whether it names a secret field. */
function hearLine(call: Call, line: string): void {
  call.heardLines.push(line);
  if (call.heardLines.length <= KEPT_LINES) return;
  const dropped = call.heardLines.shift()!;
  if (call.secretField !== true && namesSecretField(dropped)) call.secretField = true;
}

/**
 * What a call heard, made fit to be told: its title (the runner's by its id, else its own), the lines of its log heard
 * since and its error, with what may be a secret hidden, once each.
 */
function settle(call: Call, titleOf: (id: string) => string | null): void {
  call.title ??= hideSecretsInText(hideTypedText(titleOf(call.id) ?? call.named)).slice(0, MAX_TITLE);
  call.secretField ??= call.selector ? isSecretLocator(call.selector) : false;
  for (const line of call.heardLines) {
    call.secretField ||= namesSecretField(line);
    call.lines.push(hideSecretsInText(hideSecretsInLog(line, call.secretField)).slice(0, MAX_LINE));
  }
  call.heardLines = [];
  if (call.lines.length > KEPT_LINES) call.lines.splice(0, call.lines.length - KEPT_LINES);
  if (call.heardError !== null) {
    call.error = hideSecretsInText(hideSecretsInLog(call.heardError, call.secretField)).slice(0, MAX_LINE);
    call.heardError = null;
  }
}

/** A context's calls, followed from the first view of one of its pages until the context goes. */
interface ContextCalls {
  calls: Map<string, Call>;
  told: number;
  /** Each view that follows them, told of each change. */
  views: Set<() => void>;
  /** The title the runner gives a call by its id; none for the call stream's, which names its own. */
  titleOf: (id: string) => string | null;
  /** The calls come from the worker's instrumentation alone, without their log: refreshed as a view tells them. */
  heardOnly?: boolean;
}

const followed = new WeakMap<BrowserContext, Promise<ContextCalls | null>>();
const listened = new WeakMap<BrowserContext, ContextCalls>();

/** Take one update of the call stream into its call. */
function take(state: ContextCalls, update: CallUpdate): void {
  if (typeof update?.id !== 'string' || typeof update.title !== 'string') return;
  const status = update.status === 'running' ? 'running' : update.status === 'error' ? 'failed' : 'passed';
  let call = state.calls.get(update.id);
  if (!call) {
    const heardOne = heardAs(update.id);
    call = heardCall({
      id: update.id,
      named: update.title,
      file: userFile(update.location?.file),
      line: typeof update.location?.line === 'number' ? update.location.line : null,
      status,
      began: heardOne?.began ?? Date.now(),
      order: ++state.told,
      selector: heardOne?.selector ?? null,
    });
    state.calls.set(update.id, call);
  }
  if (Array.isArray(update.newLogEntries)) {
    for (const entry of update.newLogEntries) if (typeof entry === 'string') hearLine(call, entry);
  }
  const point = update.actionPoint;
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    call.point = { x: point.x as number, y: point.y as number };
  }
  if (typeof update.error === 'string' && update.error) call.heardError = update.error.split('\n')[0]!;
  call.status = status;
  if (status !== 'running' && call.ended === null) call.ended = Date.now();
}

/**
 * The call a view shows: the running call told last, else the call told last, ended, unless it ended before `since`
 * (in a test before the view's, of a context the two share).
 */
function shownCall(state: ContextCalls, since: number): Call | null {
  let shown: Call | null = null;
  for (const call of state.calls.values()) {
    if (call.ended !== null && call.ended < since) continue;
    if (!shown) {
      shown = call;
      continue;
    }
    const running = call.status === 'running';
    if (running !== (shown.status === 'running') ? running : call.order > shown.order) shown = call;
  }
  return shown;
}

/** Forget the calls that ended, but the one told last. */
function prune(state: ContextCalls): void {
  let last: Call | null = null;
  for (const call of state.calls.values()) if (!last || call.order > last.order) last = call;
  for (const [id, call] of state.calls) if (call.status !== 'running' && call !== last) state.calls.delete(id);
}

/**
 * Follow a context's calls from now until it goes: the call stream's listener first, since turning the stream on tells
 * the calls running then. Resolves null on a Playwright without the stream, or one that refuses to turn it on.
 */
async function followContext(context: BrowserContext): Promise<ContextCalls | null> {
  const stream = callStreamOf(context);
  if (!stream) return null;
  const state: ContextCalls = { calls: new Map(), told: 0, views: new Set(), titleOf: () => null };
  const listener: CallListener = (updates) => {
    if (!Array.isArray(updates)) return;
    for (const update of updates) take(state, update);
    prune(state);
    for (const view of state.views) view();
  };
  stream.on('apicallsupdated', listener);
  try {
    await internalCall(context, () => stream._enable());
  } catch {
    stream.off('apicallsupdated', listener);
    return null;
  }
  return state;
}

/** The part of Playwright's server-side instrumentation a listener needs. */
interface ServerInstrumentation {
  addListener(listener: object, context: unknown): void;
  removeListener(listener: object): void;
}

/** A call's metadata, as Playwright's server keeps it while the call runs. */
interface CallMetadata {
  id: string;
  /** The id of the runner's step, where it is not `id` (before Playwright 1.64). */
  stepId?: unknown;
  method: string;
  type?: unknown;
  title?: unknown;
  internal?: unknown;
  location?: { file?: unknown; line?: unknown } | null;
  params?: { selector?: unknown } | null;
  point?: { x?: unknown; y?: unknown } | null;
  error?: { error?: { message?: unknown } } | null;
}

function isMetadata(value: unknown): value is CallMetadata {
  const meta = value as Partial<CallMetadata> | null;
  return !!meta && typeof meta === 'object' && typeof meta.id === 'string' && typeof meta.method === 'string';
}

/**
 * A hook's call metadata, and the point an input action acts on: Playwright 1.64 hands a hook the call's progress, which
 * holds its metadata, then the object called and the point; an earlier one hands it the object called and the metadata,
 * which holds the point.
 */
function hookCall(args: unknown[]): { meta: CallMetadata; point: unknown } | null {
  const progress = args[0] as { metadata?: unknown } | null;
  if (progress && typeof progress === 'object' && isMetadata(progress.metadata)) {
    return { meta: progress.metadata, point: args[2] };
  }
  return isMetadata(args[1]) ? { meta: args[1], point: args[1].point } : null;
}

/** The in-process server object of a context, and its instrumentation; null for a connected browser's, or another shape. */
function serverInstrumentationOf(
  context: BrowserContext,
): { impl: object; instrumentation: ServerInstrumentation } | null {
  const connection = (context as unknown as { _connection?: { toImpl?: unknown } })._connection;
  if (typeof connection?.toImpl !== 'function') return null;
  let impl: unknown;
  try {
    impl = (connection.toImpl as (object: unknown) => unknown)(context);
  } catch {
    return null;
  }
  const instrumentation = (impl as { instrumentation?: Partial<ServerInstrumentation> } | null)?.instrumentation;
  if (
    !impl ||
    typeof instrumentation?.addListener !== 'function' ||
    typeof instrumentation.removeListener !== 'function'
  ) {
    return null;
  }
  return { impl: impl as object, instrumentation: instrumentation as ServerInstrumentation };
}

/** A call's title as its metadata names it, when the runner gives it none: Playwright's title, else its method. */
function metadataTitle(meta: CallMetadata): string {
  if (typeof meta.title === 'string' && meta.title) return meta.title;
  const selector = typeof meta.params?.selector === 'string' ? ` ${meta.params.selector}` : '';
  return `${typeof meta.type === 'string' ? `${meta.type}.` : ''}${meta.method}${selector}`;
}

/**
 * Follow a context's calls through Playwright's in-process instrumentation, from now until the context closes, which
 * removes the listener; null for a context without one. Each hook is synchronous and only reads the call.
 */
function listenContext(context: BrowserContext, titleOf: (id: string) => string | null): ContextCalls | null {
  const known = listened.get(context);
  if (known) return known;
  const server = serverInstrumentationOf(context);
  if (!server) return null;
  const state: ContextCalls = { calls: new Map(), told: 0, views: new Set(), titleOf };
  const changed = (): void => {
    prune(state);
    for (const view of state.views) view();
  };
  /** A hook's body, which never throws into the call it hears. */
  const guarded =
    (hook: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      try {
        hook(...args);
      } catch {
        // A call is heard, or not, but never broken.
      }
    };
  const listener = {
    onBeforeCall: guarded((...args) => {
      const call = hookCall(args);
      if (!call || call.meta.internal || call.meta.method === '__waitInfo__') return;
      const { meta } = call;
      const selector = typeof meta.params?.selector === 'string' && meta.params.selector ? meta.params.selector : null;
      state.calls.set(
        meta.id,
        heardCall({
          id: typeof meta.stepId === 'string' && meta.stepId ? meta.stepId : meta.id,
          named: metadataTitle(meta),
          file: userFile(meta.location?.file),
          line: typeof meta.location?.line === 'number' ? meta.location.line : null,
          status: 'running',
          began: Date.now(),
          order: ++state.told,
          selector,
        }),
      );
      if (state.calls.size > MAX_HEARD) state.calls.delete(state.calls.keys().next().value!);
      changed();
    }),
    onCallLog: guarded((_object, meta, logName, message) => {
      if (logName !== 'api' || !isMetadata(meta) || typeof message !== 'string') return;
      const call = state.calls.get(meta.id);
      if (!call) return;
      hearLine(call, message);
      changed();
    }),
    onBeforeInputAction: guarded((...args) => {
      const hooked = hookCall(args);
      const call = hooked ? state.calls.get(hooked.meta.id) : undefined;
      const point = hooked?.point as { x?: unknown; y?: unknown } | null | undefined;
      if (!call || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      call.point = { x: point.x as number, y: point.y as number };
      changed();
    }),
    onAfterCall: guarded((...args) => {
      const hooked = hookCall(args);
      const call = hooked ? state.calls.get(hooked.meta.id) : undefined;
      if (!hooked || !call) return;
      const message = hooked.meta.error?.error?.message;
      if (typeof message === 'string' && message) call.heardError = message.split('\n')[0]!;
      call.status = hooked.meta.error ? 'failed' : 'passed';
      call.ended = Date.now();
      changed();
    }),
  };
  try {
    server.instrumentation.addListener(listener, server.impl);
  } catch {
    return null;
  }
  context.once('close', () => {
    try {
      server.instrumentation.removeListener(listener);
    } catch {
      // The context's server object went with it.
    }
  });
  listened.set(context, state);
  return state;
}

/**
 * Follow a context's calls through Playwright's in-process instrumentation from as it opens, in a worker whose run Piwi
 * may pause and that can show a view: a view that comes while a call waits shows that call at once. Nothing for a
 * context with no in-process server.
 */
export function listenCalls(context: BrowserContext, titleOf: (id: string) => string | null): void {
  try {
    listenContext(context, titleOf);
  } catch {
    // A context of another shape is followed as a view comes, or not at all.
  }
}

/**
 * The calls of a context as the worker's instrumentation hears them, for a context with no in-process server: each
 * running call, its title the runner's, without its log. The calls of every context of the worker are heard alike.
 */
function heardCalls(titleOf: (id: string) => string | null): ContextCalls {
  return { calls: new Map(), told: 0, views: new Set(), titleOf, heardOnly: true };
}

/** Refresh a context's calls from the calls the worker's instrumentation hears running now. */
function refreshHeard(state: ContextCalls): void {
  const running = new Set<string>();
  for (const one of heard.values()) {
    const id = zoneStepId(one.zone);
    if (!id) continue;
    running.add(id);
    if (state.calls.has(id)) continue;
    const named =
      typeof one.zone.title === 'string' && one.zone.title ? one.zone.title : String(one.zone.apiName ?? 'call');
    state.calls.set(
      id,
      heardCall({
        id,
        named,
        file: null,
        line: null,
        status: 'running',
        began: one.began,
        order: ++state.told,
        selector: one.selector,
      }),
    );
  }
  for (const call of state.calls.values()) {
    if (call.status === 'running' && !running.has(call.id)) {
      call.status = 'passed';
      call.ended = Date.now();
    }
  }
  prune(state);
}

/** The part of an element of the page the read below uses, as the page sees it. */
interface PageElement {
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  getAttribute(name: string): string | null;
  disabled?: unknown;
}

/** What the elements a selector matches read as: how many, the first one's box, and whether it is enabled. */
interface Matches {
  count: number;
  box: LiveBox | null;
  enabled: boolean | null;
}

/**
 * Follow the calls of `page`'s context as Playwright logs them, telling `onLog` the call shown (`shownCall`) at once
 * and at each change, none that ended before `since` (when the view's test began). From the call stream (`stream`,
 * the default), else from the in-process instrumentation (`listener`), or the calls alone where it has none. Resolves
 * with what stops following, or null on a Playwright without the call stream.
 */
export async function followCallLog(
  page: Page,
  since: number,
  onLog: (log: LiveCallLog) => void,
  options: FollowOptions = {},
): Promise<(() => void) | null> {
  const context = page.context();
  const titleOf = options.titleOf ?? (() => null);
  let calls: ContextCalls | null;
  if (options.source === 'listener') {
    calls = listenContext(context, titleOf) ?? heardCalls(titleOf);
  } else {
    let state = followed.get(context);
    if (!state) {
      state = followContext(context);
      followed.set(context, state);
    }
    calls = await state;
  }
  if (!calls) return null;
  let stopped = false;
  let reading = false;
  /** The elements the shown call's selector matched, and the call they were read for. */
  let target: { id: string; matches: Matches } | null = null;

  /** Whether the call's element and its point are on the watched page: it is its context's one page. */
  const onThisPage = (): boolean => !page.isClosed() && context.pages().length === 1;

  const tell = (): void => {
    if (calls.heardOnly) refreshHeard(calls);
    const shown = shownCall(calls, since);
    if (stopped || !shown) return;
    settle(shown, calls.titleOf);
    const here = onThisPage();
    onLog({
      id: shown.id,
      call: { title: shown.title!, file: shown.file, line: shown.line },
      status: shown.status,
      lines: compressCallLog(shown.lines).slice(-MAX_LIVE_CALL_LOG_LINES),
      point: here ? shown.point : null,
      target: here && shown.status === 'running' && target?.id === shown.id ? target.matches : null,
      viewport: page.viewportSize(),
      ms: (shown.ended ?? Date.now()) - shown.began,
      error: shown.error,
    });
  };
  calls.views.add(tell);
  tell();

  // While the call shown has waited a second, the elements its locator matches.
  const timer = setInterval(() => {
    if (calls.heardOnly) tell();
    const shown = shownCall(calls, since);
    const selector = shown?.selector;
    if (stopped || reading || !shown || shown.status !== 'running' || !selector || !onThisPage()) return;
    if (Date.now() - shown.began < TARGET_EVERY_MS) return;
    reading = true;
    // A selector into a frame matches in that frame: its box is the frame's, not the page's.
    const framed = selector.includes('internal:control=enter-frame');
    void internalCall(page, () =>
      page.locator(selector).evaluateAll((elements): Matches => {
        const first = elements[0] as unknown as PageElement | undefined;
        if (!first) return { count: 0, box: null, enabled: null };
        const rect = first.getBoundingClientRect();
        const disabled = first.disabled === true || first.getAttribute('aria-disabled') === 'true';
        return {
          count: elements.length,
          box: rect.width || rect.height ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          enabled: !disabled,
        };
      }),
    )
      .then((matches) => {
        if (stopped || shownCall(calls, since) !== shown || shown.status !== 'running') return;
        // The call found its element where this read found none: it runs in a frame of the page of its own.
        if (!matches.count && shown.lines.some((line) => line.includes('locator resolved to'))) return;
        target = { id: shown.id, matches: framed ? { ...matches, box: null } : matches };
        tell();
      })
      .catch(() => undefined)
      .finally(() => {
        reading = false;
      });
  }, TARGET_EVERY_MS);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
    calls.views.delete(tell);
  };
}
