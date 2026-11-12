import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Page } from '@playwright/test';
import {
  LANE_TEXT_DEPTH,
  LANE_THUMB_HEIGHT,
  LANE_THUMB_WIDTH,
  MAX_FILMSTRIP,
  MAX_FILMSTRIP_BYTES,
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
import { onCallEnded } from './live-call-log.js';
import { thumbnailOf } from './live-mask.js';
import type { PageFrame } from './page-view.js';
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
 *   last read stopped, only the lines of its ARIA snapshots parsed; the ARIA files the lines name, under that folder
 *   alone. Nothing is written, nor any option of the trace changed, and its screencast images are never read.
 * - **Text** (`takeLaneText`): the page's ARIA snapshot, from the trace's latest one of the attempt when the project's
 *   trace writes them, else taken through an internal call (`ariaSnapshot` in AI mode, `LANE_TEXT_DEPTH` levels deep),
 *   masked by `maskAriaSnapshot` with the values the page's secret fields hold now and the masks the wire names, its
 *   credentials hidden. A mask the text cannot find (`ariaMaskProblem`) sends no text, saying why.
 * - **The filmstrip** (`LaneFilmstrip`): one image for each call of the test that ended, the runner's own (its title
 *   the runner's step), from the wire's own lane view, masked as each of its frames is (`live-mask.ts`): its latest
 *   frame `THUMB_AFTER_MS` after the call ended, scaled down, taken only while someone watches the lane and kept in the
 *   worker's memory for that test alone, for a viewer that comes later.
 */

/** The most bytes of a trace read at once: the rest waits for the next read. */
const MAX_READ = 8 * 1024 * 1024;
/** The longest line of a trace kept whole across two reads: a longer one (a DOM snapshot's) is passed over. */
const MAX_LINE = 64 * 1024;
/** The longest ARIA file of a trace read, in bytes. */
const MAX_ARIA_FILE = 4 * 1024 * 1024;
/** The most trace files of an attempt read: its own, and those of the contexts it opened. */
const MAX_TRACE_FILES = 8;
/** How long taking the page's text may take. */
const TEXT_MS = 5000;

/**
 * The test the layers are of: its id, when it began, the runner's title of a call, whether a call is one a fixture made
 * as it set the test up or tore it down (`Launch browser`, `Create page`), and where its trace grows.
 */
export interface LayersTest {
  id: string;
  began: number;
  titleOf(callId: string): string | null;
  fixtureCall(callId: string): boolean;
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

/** What the attempt's trace told so far. */
interface AttemptTrace {
  dir: string;
  base: string;
  tails: Map<string, TraceTail>;
  /** The latest ARIA snapshot it wrote, and its call. */
  aria: { call: string; file: string } | null;
  /** Reads one after the other. */
  reading: Promise<void>;
}

let attempt: AttemptTrace | null = null;

/** The trace's lines read: every other one (a call, a screencast image, a DOM snapshot) is passed over unparsed. */
const ARIA_LINE = '{"type":"aria-snapshot"';

/** A file the trace names, under its folder alone; null for any other path. */
function underTrace(dir: string, file: unknown): string | null {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  const full = path.resolve(dir, file);
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}

/** Take one line of the trace into what it told: its ARIA snapshot alone. */
function takeLine(trace: AttemptTrace, line: string): void {
  if (!line.startsWith(ARIA_LINE)) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (event.type === 'aria-snapshot' && typeof event.callId === 'string' && typeof event.file === 'string') {
    trace.aria = { call: event.callId, file: event.file };
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
      aria: null,
      reading: Promise.resolve(),
    };
  }
  const trace = attempt;
  const read = trace.reading.then(async () => {
    for (const file of await attemptFiles(trace.dir, trace.base)) {
      if (!trace.tails.has(file)) trace.tails.set(file, new TraceTail(file));
    }
    for (const tail of trace.tails.values()) {
      for (const line of await tail.read()) takeLine(trace, line);
    }
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

/** How long after a call of the test ended its image is taken for the filmstrip: what it changed has painted by then. */
const THUMB_AFTER_MS = 300;
/** How long after an image of a filmstrip was scaled down the next one is: each takes a few milliseconds of the thread. */
const THUMB_SPACING_MS = 500;
/** The most frames held for the filmstrip while they wait to be scaled down: past them, the oldest is dropped. */
const MAX_WAITING_FRAMES = 6;
/** The JPEG quality of an image of the filmstrip. */
const THUMB_QUALITY = 60;

/** An image of a test's filmstrip, and its JPEG. */
export interface KeptThumb {
  thumb: LaneThumb;
  data: Buffer;
}

/** A lane view while someone watches it: the test it shows, and its latest frame of where the lane stands, masked. */
export interface WatchedLane {
  test: string;
  latest(): PageFrame | null;
}

/**
 * A test's filmstrip as a wire's lane view takes it (the run channel's, the live view's): while someone watches the
 * lane (`watched`), the view's latest frame `THUMB_AFTER_MS` after each call of its test ended that the runner names,
 * masked as every frame of the view is, one image a call, none for a call a fixture made as it set the test up or tore
 * it down (`fixtureCall`). Each frame is scaled down within `LANE_THUMB_WIDTH` by
 * `LANE_THUMB_HEIGHT` (`thumbnailOf`), `THUMB_SPACING_MS` after the one before at least, the ones that wait held in
 * memory (`MAX_WAITING_FRAMES` at most, the oldest dropped). Kept in the worker's memory for that test alone, the latest
 * `MAX_FILMSTRIP` images and `MAX_FILMSTRIP_BYTES` at most, for a viewer that comes later (`of`); never stored, nor taken
 * from anything but the view's frames. Each image kept is told to `kept`.
 */
export class LaneFilmstrip {
  private test: string | null = null;
  private thumbs: KeptThumb[] = [];
  private bytes = 0;
  /** How many images the test's strip took, which numbers the next. */
  private taken = 0;
  /** The frames of the test's calls that wait to be scaled down, oldest first, and the timer that takes the next. */
  private waiting: Array<{ id: string; title: string; frame: PageFrame }> = [];
  private draining: ReturnType<typeof setTimeout> | null = null;
  private unhear: (() => void) | null;

  constructor(
    private readonly watched: () => WatchedLane | null,
    private readonly kept: (thumb: KeptThumb, test: string) => void,
  ) {
    this.unhear = onCallEnded((id) => this.callEnded(id));
  }

  /** The images kept of the test `test`, oldest first; none of another test. */
  of(test: string | null): KeptThumb[] {
    return test !== null && test === this.test ? [...this.thumbs] : [];
  }

  /** Another test begins: the images of the one before go, and the frames that wait. */
  forget(): void {
    this.test = null;
    this.thumbs = [];
    this.bytes = 0;
    this.taken = 0;
    this.waiting = [];
    if (this.draining) clearTimeout(this.draining);
    this.draining = null;
  }

  /** No image is taken any more, and those kept go. */
  close(): void {
    this.unhear?.();
    this.unhear = null;
    this.forget();
  }

  private callEnded(id: string | null): void {
    const title = id ? layersTitleOf(id) : null;
    const lane = this.watched();
    if (!id || !title || !lane || current?.fixtureCall(id)) return;
    const { test } = lane;
    const timer = setTimeout(() => this.hold(id, title, test), THUMB_AFTER_MS);
    timer.unref?.();
  }

  /** Hold the view's latest frame for the call `id` of the test `test`, to be scaled down as the pace allows. */
  private hold(id: string, title: string, test: string): void {
    const lane = this.unhear ? this.watched() : null;
    const frame = lane?.test === test ? lane.latest() : null;
    if (!frame) return;
    if (this.test !== test) {
      this.forget();
      this.test = test;
    }
    if (this.thumbs.some((one) => one.thumb.call === id) || this.waiting.some((one) => one.id === id)) return;
    this.waiting.push({ id, title, frame });
    if (this.waiting.length > MAX_WAITING_FRAMES) this.waiting.shift();
    this.drain();
  }

  /** Scale down the oldest frame that waits and keep its image, the next one `THUMB_SPACING_MS` later. */
  private drain(): void {
    if (this.draining || !this.waiting.length) return;
    this.keep(this.waiting.shift()!);
    this.draining = setTimeout(() => {
      this.draining = null;
      this.drain();
    }, THUMB_SPACING_MS);
    this.draining.unref?.();
  }

  private keep({ id, title, frame }: { id: string; title: string; frame: PageFrame }): void {
    const test = this.test;
    if (test === null) return;
    const small = thumbnailOf(frame.data, {
      width: LANE_THUMB_WIDTH,
      height: LANE_THUMB_HEIGHT,
      quality: THUMB_QUALITY,
      maxBytes: MAX_LANE_THUMB,
    });
    if (!small) return;
    const at = Number.isFinite(frame.at) ? Math.round(frame.at) : Date.now();
    const one: KeptThumb = {
      thumb: { call: id, title, index: ++this.taken, width: small.width, height: small.height, at },
      data: small.data,
    };
    this.thumbs.push(one);
    this.bytes += small.data.length;
    while (this.thumbs.length > MAX_FILMSTRIP || this.bytes > MAX_FILMSTRIP_BYTES) {
      this.bytes -= this.thumbs.shift()!.data.length;
    }
    this.kept(one, test);
  }
}
