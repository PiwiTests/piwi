import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Page } from '@playwright/test';
import {
  LANE_TEXT_DEPTH,
  MAX_FILMSTRIP,
  MAX_LANE_TEXT,
  MAX_LANE_THUMB,
  MAX_PAGE_EVENTS_PER_SECOND,
  ariaTreeText,
  type LaneText,
  type LaneThumb,
  type PageEvent,
} from '@piwitests/core/live-layers';
import { ariaMaskProblem, hideSecretsInText, hideTypedText, maskAriaSnapshot } from '@piwitests/core/mask';
import { RateWindow } from '@piwitests/core/run-view';
import { fieldSecrets } from './agent-page.js';
import { jpegSize } from './live-mask.js';
import { internalCall } from './quiet-capture.js';

/**
 * The layers of the lane's view beside its images (`@piwitests/core/live-layers`), as the worker makes them for the
 * two wires that ask: the run channel's lane view (`run-channel.ts`) and the instance's live view (`live-view.ts`).
 * Nothing here runs while no wire asks.
 *
 * - **Page events**: `run-events.ts`'s listeners tell each event here (`tellPageEvent`) while a wire subscribes
 *   (`subscribePageEvents`), each subscription at its own pace, `MAX_PAGE_EVENTS_PER_SECOND` at most, the others
 *   counted and said as `dropped`.
 * - **The test's growing trace**: where the runner traces the attempt, its files are read as they grow (`traceOf`):
 *   `<outputDir>/.playwright-artifacts-<workerIndex>/traces/<testId>[-retry<k>][-recording<N>].trace`, from where the
 *   last read stopped, only the lines of calls, screencast images and ARIA snapshots parsed; the images and the ARIA
 *   files the lines name, under that folder alone. Nothing is written, nor any option of the trace changed.
 * - **Text** (`takeLaneText`): the page's ARIA snapshot, from the trace's latest one of the attempt when the project's
 *   trace writes them, else taken through an internal call (`ariaSnapshot` in AI mode, `LANE_TEXT_DEPTH` levels deep),
 *   masked by `maskAriaSnapshot` with the values the page's secret fields hold now and the masks the wire names, its
 *   credentials hidden. A mask the text cannot find (`ariaMaskProblem`) sends no text, saying why.
 * - **The trace's filmstrip** (`traceThumbs`): one image for each call of the attempt that ended, the runner's own
 *   (its title the runner's step), from the trace's screencast: the latest image of the page by `SETTLE_MS` after the
 *   call ended, once the trace went past that time or stopped growing. Nothing is captured for it.
 */

/** How long after a call ended its page is shown in the filmstrip: what the call changed has painted by then. */
const SETTLE_MS = 300;
/** The most bytes of a trace read at once: the rest waits for the next read. */
const MAX_READ = 8 * 1024 * 1024;
/** The longest line of a trace kept whole across two reads: a longer one (a DOM snapshot's) is passed over. */
const MAX_LINE = 64 * 1024;
/** The longest ARIA file of a trace read, in bytes. */
const MAX_ARIA_FILE = 4 * 1024 * 1024;
/** The most calls and screencast images of an attempt remembered: the latest. */
const MAX_TRACE_CALLS = 2000;
const MAX_TRACE_FRAMES = 500;
/** The most trace files of an attempt read: its own, and those of the contexts it opened. */
const MAX_TRACE_FILES = 8;
/** How long taking the page's text may take. */
const TEXT_MS = 5000;

/** The test the layers are of: its id, when it began, the runner's title of a call, and where its trace grows. */
export interface LayersTest {
  id: string;
  began: number;
  titleOf(callId: string): string | null;
  /** The folder the runner writes the attempt's trace in, and the name its files start with; null when unknown. */
  trace: { dir: string; base: string } | null;
}

let current: LayersTest | null = null;

/** The test whose layers are made from now on: its trace read from its start. */
export function layersTestBegan(test: LayersTest): void {
  current = test;
  attempt = null;
}

/** The test ended: its trace is no longer read, and its requests not followed. */
export function layersTestEnded(): void {
  current = null;
  attempt = null;
}

/** The test the layers are of now; null between two tests. */
export function layersTest(): LayersTest | null {
  return current;
}

/** The title the runner gives the call `id` of the running test, the text it types and its credentials hidden. */
export function layersTitleOf(id: string): string | null {
  const title = current?.titleOf(id) ?? null;
  return title === null ? null : hideSecretsInText(hideTypedText(title)).slice(0, 300);
}

/** A wire's subscription to the page events: its pace, and how many it did not send since it last sent one. */
interface EventSubscriber {
  send(event: PageEvent, at: number): void;
  rate: RateWindow;
  dropped: number;
}

const eventSubscribers = new Set<EventSubscriber>();

/**
 * Hear the page events from now on, `MAX_PAGE_EVENTS_PER_SECOND` a second at most, those past it counted and said as
 * `dropped` before the next one; returns what stops hearing them.
 */
export function subscribePageEvents(send: (event: PageEvent, at: number) => void): () => void {
  const own: EventSubscriber = { send, rate: new RateWindow(MAX_PAGE_EVENTS_PER_SECOND), dropped: 0 };
  eventSubscribers.add(own);
  return () => eventSubscribers.delete(own);
}

/** Whether a wire hears the page events now. */
export function pageEventsWanted(): boolean {
  return eventSubscribers.size > 0;
}

/** Tell every wire that subscribes something the page or a request of the test said, now. */
export function tellPageEvent(event: PageEvent): void {
  const at = Date.now();
  for (const own of eventSubscribers) {
    if (!own.rate.take(own.dropped ? 2 : 1)) {
      own.dropped++;
      continue;
    }
    try {
      if (own.dropped) own.send({ kind: 'dropped', count: own.dropped }, at);
      own.dropped = 0;
      own.send(event, at);
    } catch {
      // A wire that cannot send now drops it.
    }
  }
}

/** One file of the trace, read from where the last read stopped, its complete lines alone. */
class TraceTail {
  private offset = 0;
  private rest = '';
  /** A line longer than `MAX_LINE` is being passed over, to its end. */
  private skipping = false;
  private decoder = new StringDecoder('utf8');

  constructor(readonly file: string) {}

  /** The lines the file gained since the last read, `MAX_READ` bytes at most; none when it cannot be read. */
  async read(): Promise<string[]> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.file, 'r');
    } catch {
      return [];
    }
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        // Another file of the same name: read it from its start.
        this.offset = 0;
        this.rest = '';
        this.skipping = false;
        this.decoder = new StringDecoder('utf8');
      }
      const length = Math.min(size - this.offset, MAX_READ);
      if (length <= 0) return [];
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      let text = this.decoder.write(buffer.subarray(0, bytesRead));
      if (this.skipping) {
        const end = text.indexOf('\n');
        if (end < 0) return [];
        this.skipping = false;
        text = text.slice(end + 1);
      }
      const lines = (this.rest + text).split('\n');
      this.rest = lines.pop() ?? '';
      if (this.rest.length > MAX_LINE) {
        this.rest = '';
        this.skipping = true;
      }
      return lines;
    } catch {
      return [];
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

/** A call of the attempt as its trace tells it. */
interface TraceCall {
  id: string;
  /** When it ended, on the trace's clock; null while it runs. */
  end: number | null;
  /** The screencast image that shows it, once chosen (`resolve`); null when none does. */
  frame: { file: string; wall: number | null } | null;
  resolved: boolean;
}

/** What the attempt's trace told so far. */
interface AttemptTrace {
  dir: string;
  base: string;
  tails: Map<string, TraceTail>;
  calls: Map<string, TraceCall>;
  frames: Array<{ file: string; at: number; wall: number | null }>;
  /** The latest ARIA snapshot it wrote, and its call. */
  aria: { call: string; file: string } | null;
  /** The latest time it named, on its clock. */
  latest: number;
  /** It did not grow at its last read: the calls that ended are shown as they are. */
  still: boolean;
  /** Reads one after the other. */
  reading: Promise<void>;
}

let attempt: AttemptTrace | null = null;

/** The trace types read: every other line (a DOM snapshot, a network entry) is passed over unparsed. */
const READ_TYPES = ['{"type":"before"', '{"type":"after"', '{"type":"screencast-frame"', '{"type":"aria-snapshot"'];

/** A file the trace names, under its folder alone; null for any other path. */
function underTrace(dir: string, file: unknown): string | null {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  const full = path.resolve(dir, file);
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}

/** Take one line of the trace into what it told. */
function takeLine(trace: AttemptTrace, line: string): void {
  if (!READ_TYPES.some((start) => line.startsWith(start))) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const time = [event.timestamp, event.startTime, event.endTime].find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  if (time !== undefined) trace.latest = Math.max(trace.latest, time);
  const id = typeof event.callId === 'string' ? event.callId : null;
  switch (event.type) {
    case 'before':
      if (id && !trace.calls.has(id)) {
        trace.calls.set(id, { id, end: null, frame: null, resolved: false });
        if (trace.calls.size > MAX_TRACE_CALLS) trace.calls.delete(trace.calls.keys().next().value!);
      }
      return;
    case 'after': {
      const call = id ? trace.calls.get(id) : undefined;
      if (call && typeof event.endTime === 'number') call.end = event.endTime;
      return;
    }
    case 'screencast-frame':
      if (typeof event.file === 'string' && time !== undefined) {
        const wall = typeof event.frameSwapWallTime === 'number' ? Math.round(event.frameSwapWallTime) : null;
        trace.frames.push({ file: event.file, at: time, wall });
        if (trace.frames.length > MAX_TRACE_FRAMES) trace.frames.shift();
      }
      return;
    case 'aria-snapshot':
      if (id && typeof event.file === 'string') trace.aria = { call: id, file: event.file };
      return;
  }
}

/** Choose the image of each call that ended, once its page settled in the trace or the trace stopped growing. */
function resolveCalls(trace: AttemptTrace): void {
  for (const call of trace.calls.values()) {
    if (call.resolved || call.end === null) continue;
    const settled = call.end + SETTLE_MS;
    if (trace.latest < settled && !trace.still) continue;
    let shown: AttemptTrace['frames'][number] | null = null;
    for (const frame of trace.frames) if (frame.at <= settled && (!shown || frame.at >= shown.at)) shown = frame;
    call.frame = shown ? { file: shown.file, wall: shown.wall } : null;
    call.resolved = true;
  }
}

/** The trace files of the attempt now: its own, and those of the contexts it opened (`-recording<N>`). */
async function attemptFiles(dir: string, base: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const own = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-recording\\d+)?\\.trace$`);
  return names
    .filter((name) => own.test(name))
    .sort()
    .slice(0, MAX_TRACE_FILES)
    .map((name) => path.join(dir, name));
}

/** The running test's trace, read up to now; null for a test whose trace is not known. */
async function traceOf(): Promise<AttemptTrace | null> {
  const test = current;
  if (!test?.trace) return null;
  if (!attempt || attempt.dir !== test.trace.dir || attempt.base !== test.trace.base) {
    attempt = {
      dir: test.trace.dir,
      base: test.trace.base,
      tails: new Map(),
      calls: new Map(),
      frames: [],
      aria: null,
      latest: -Infinity,
      still: false,
      reading: Promise.resolve(),
    };
  }
  const trace = attempt;
  const read = trace.reading.then(async () => {
    for (const file of await attemptFiles(trace.dir, trace.base)) {
      if (!trace.tails.has(file)) trace.tails.set(file, new TraceTail(file));
    }
    let grew = false;
    for (const tail of trace.tails.values()) {
      const lines = await tail.read();
      if (lines.length) grew = true;
      for (const line of lines) takeLine(trace, line);
    }
    trace.still = !grew;
    resolveCalls(trace);
  });
  trace.reading = read.catch(() => undefined);
  await trace.reading;
  return attempt === trace ? trace : null;
}

/** The latest ARIA snapshot the running test's trace wrote, as text, with its call; null when it wrote none. */
async function traceAria(): Promise<{ call: string; text: string; cut: boolean } | null> {
  const trace = await traceOf();
  const written = trace?.aria;
  const file = written && trace ? underTrace(trace.dir, written.file) : null;
  if (!written || !file) return null;
  try {
    const { size } = await fs.stat(file);
    if (size > MAX_ARIA_FILE) return null;
    const tree = ariaTreeText(JSON.parse(await fs.readFile(file, 'utf8')) as unknown, MAX_LANE_TEXT);
    return tree?.text.trim() ? { call: written.call, ...tree } : null;
  } catch {
    return null;
  }
}

/** Why no text of the page goes, as a viewer reads it. */
const NO_PAGE_TEXT = 'No page to read: this test shows none now.';
const UNREAD_MASKS =
  "The page's text is not sent: the project masks elements this reporter cannot read. Update the Piwi reporter.";

/**
 * The page's text now: the trace's latest ARIA snapshot of the running test where its trace writes them, else, with
 * `take`, an ARIA snapshot of `page` in AI mode, `LANE_TEXT_DEPTH` levels deep, through an internal call. Masked with
 * the values the page's secret fields hold now and `masks` (the project's; null for masks this reporter cannot read,
 * which sends no text), its credentials hidden, cut at `MAX_LANE_TEXT`. Null when the trace wrote none and `take` is
 * false. Never throws.
 */
export async function takeLaneText(
  page: Page | null,
  masks: readonly string[] | null,
  take: boolean,
): Promise<LaneText | { refused: string } | null> {
  if (masks === null) return { refused: UNREAD_MASKS };
  for (const mask of masks) {
    const problem = ariaMaskProblem(mask);
    if (problem) return { refused: `The page's text is not sent, since it cannot hide a masked element: ${problem}` };
  }
  const traced = await traceAria();
  let raw: { call: string | null; source: LaneText['source']; text: string; cut: boolean } | null = traced
    ? { ...traced, source: 'trace' }
    : null;
  if (!raw) {
    if (!take) return null;
    if (!page || page.isClosed()) return { refused: NO_PAGE_TEXT };
    try {
      const snapshot = await internalCall(page, () =>
        page.ariaSnapshot({ mode: 'ai', depth: LANE_TEXT_DEPTH, timeout: TEXT_MS }),
      );
      raw = { call: null, source: 'snapshot', text: snapshot, cut: snapshot.length > MAX_LANE_TEXT };
    } catch {
      return { refused: 'The page could not be read: it closed, or did not answer in time.' };
    }
  }
  const secrets =
    page && !page.isClosed() ? await internalCall(page, () => fieldSecrets(page)).catch(() => [] as string[]) : [];
  const text = hideSecretsInText(maskAriaSnapshot(raw.text, { secrets, masks }));
  return {
    call: raw.call,
    source: raw.source,
    text: text.slice(0, MAX_LANE_TEXT),
    cut: raw.cut || text.length > MAX_LANE_TEXT,
    at: Date.now(),
  };
}

/** How often the trace is read for a new ARIA snapshot while a wire follows the page's text. */
const TEXT_READ_MS = 1000;

/**
 * Follow the page's text as the running test's trace writes it: each ARIA snapshot it writes after the last one told
 * goes to `onText`, masked with `masks()` as `takeLaneText` masks it, one a second at most; nothing where the trace writes
 * none. Returns what stops following.
 */
export function followTraceText(
  masks: () => readonly string[] | null,
  page: () => Page | null,
  onText: (text: LaneText | { refused: string }) => void,
): () => void {
  let told: string | null = null;
  let reading = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    void (async () => {
      const trace = await traceOf();
      const key = trace?.aria ? `${trace.base}/${trace.aria.file}` : null;
      if (!key || key === told) return;
      told = key;
      const text = await takeLaneText(page(), masks(), false);
      if (text && !stopped) onText(text);
    })()
      .catch(() => undefined)
      .finally(() => {
        reading = false;
      });
  }, TEXT_READ_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** An image of the trace's filmstrip, and its JPEG. */
export interface TraceThumb {
  thumb: LaneThumb;
  data: Buffer;
}

/**
 * The running test's filmstrip as its trace shows it so far: one image for each of its calls that ended and the runner
 * names, the latest `MAX_FILMSTRIP`, each `MAX_LANE_THUMB` bytes at most (a longer one is left out), but those of the
 * calls `skip` names. Read from the trace's own files; none for a test whose trace records no screencast. Never throws.
 */
export async function traceThumbs(skip: ReadonlySet<string> = new Set()): Promise<TraceThumb[]> {
  const trace = await traceOf();
  if (!trace) return [];
  const shown: Array<{ call: TraceCall; title: string }> = [];
  for (const call of trace.calls.values()) {
    if (!call.resolved || !call.frame) continue;
    const title = layersTitleOf(call.id);
    if (title) shown.push({ call, title });
  }
  const thumbs: TraceThumb[] = [];
  for (const [i, { call, title }] of shown.entries()) {
    if (i < shown.length - MAX_FILMSTRIP || skip.has(call.id)) continue;
    const file = underTrace(trace.dir, call.frame!.file);
    if (!file) continue;
    try {
      const { size } = await fs.stat(file);
      if (size > MAX_LANE_THUMB) continue;
      const data = await fs.readFile(file);
      const fits = jpegSize(data);
      if (!fits) continue;
      const at = call.frame!.wall ?? Date.now();
      thumbs.push({ thumb: { call: call.id, title, index: i + 1, ...fits, at }, data });
    } catch {
      // An image the trace has not written yet, or removed: the call shows none.
    }
  }
  return thumbs;
}
