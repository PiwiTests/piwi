/**
 * Desktop build: **Inspect** in the Local runs tray, the page of a watched lane's running test at each of its calls, as
 * a document, read from the test's own growing trace on this machine. The server is the run's hub (`desktop-runs.ts`):
 * the lane's worker names its attempt's trace file to it alone, and the file passes the checks of **Open the trace so
 * far** (`RunSessions.laneTrace`); the server then reads the attempt's files in that folder itself. No path goes to a
 * window: it hears each snapshot's call, title and moment (`DesktopInspectEvent`), and reads each page rendered from
 * `GET /api/desktop/runs/inspect/page`, through the store and the renderer the run page's Inspect uses (`RunInspect`,
 * in the desktop app's words, `DESKTOP_INSPECT_WORDS`), so the same sanitizing and the same frame apply.
 *
 * - **What is read** (`DesktopTraceReader`), as the reporter's Inspect reads the runner's trace: each file of the
 *   attempt (`<base>[-recording<N>].trace`, `MAX_TRACE_FILES` at most) and its `.network`, from where the last read
 *   stopped, every `READ_MS`, a link or anything but a regular file never read. Of the trace: each call as it begins
 *   (`before`: its id, its title, the text it types), and the `frame-snapshot` events, each numbered in its frame as
 *   Playwright numbers them, a line past `MAX_SNAPSHOT_LINE` counted where it was and passed over. Of the network file:
 *   each resource a page loaded (`resource-snapshot`) that `inspectResourceType` allows, by its page and address.
 * - **What is kept.** The snapshots of every page's main frame, from the main frame's last full snapshot as Inspect
 *   opens (`MAX_SNAPSHOT_BACKLOG` bytes at most, the oldest after a frame's full one left out), then each new one, in
 *   the trace's order. Before one is kept, what its page's secrets show is removed (`hideFrameSnapshotSecrets`) with
 *   the attempt's secrets as the trace tells them: the values its secret fields held in the snapshots read so far, this
 *   one included (`snapshotFieldSecrets`), and each value its calls typed into a field their locator names for a secret
 *   or with no locator; its call's title is the runner's of its step as the lane's layers named it (`titled`; the
 *   step is the call's `stepId` in the trace, else its id), else the trace's own, the text it types and its credentials
 *   hidden. A snapshot that cannot be read whole, or past `MAX_SNAPSHOT_BYTES` once hidden, stops its frame's chain
 *   until its next full snapshot, saying why.
 * - **Resources.** Before a snapshot, each resource it names (`snapshotResourceUrls`, and what a stylesheet among them
 *   names, `cssReferences`, `CSS_DEPTH` imports deep) that its page loaded, from the trace folder's `resources/` alone,
 *   `MAX_RESOURCE_BYTES` at most and its bytes of the kind its content type says (`isInspectResourceBytes`): a
 *   stylesheet, a font, an image other than SVG; never a script, a document nor an SVG.
 * - **When** (`DesktopInspects`). Reading starts as a window opens Inspect on a lane (`open`), and follows the lane's
 *   attempts while one has it open (`sessionChanged`): a test's end lets go everything kept of it (`RunInspect.clear`),
 *   and the next test's trace is asked for. A worker that names none says why (the reporter's sentence, as for a test
 *   its runner does not trace), asked again every `ASK_AGAIN_MS`. It stops as the last window closes it or leaves, or
 *   the run ends: nothing is kept past the test, nor written anywhere.
 */
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isLayerCallId } from '@piwitests/core/live-layers';
import {
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_URL,
  MAX_SNAPSHOT_BACKLOG,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_RESOURCES,
  cssReferences,
  hideFrameSnapshotSecrets,
  hideResourceUrl,
  inspectResourceType,
  isFullSnapshot,
  isInspectResourceBytes,
  isResourceSha1,
  resolveResourceUrl,
  snapshotFieldSecrets,
  snapshotNodes,
  snapshotPhase,
  snapshotResourceUrls,
  type LiveSnapshot,
  type LiveSnapshotResource,
  type SnapshotPhase,
  type SnapshotResolver,
} from '@piwitests/core/live-inspect';
import { hideSecretsInText, hideTypedText, isSecretLocator } from '@piwitests/core/mask';
import type { LaneTrace, RunControlResult, RunSession } from '@piwitests/editor/run-host';
import {
  MAX_DESKTOP_INSPECT_LISTED,
  isDesktopRunViewer,
  type DesktopInspectCalls,
  type DesktopInspectEvent,
  type DesktopInspectNotice,
} from '#shared/desktop-runs';
import {
  InspectBudget,
  MAX_WORKER_SNAPSHOTS,
  RunInspect,
  SNAPSHOT_MASKED_GONE,
  SNAPSHOT_TOO_LARGE,
  type InspectWords,
  type LiveSnapshotPage,
  type LiveSnapshotRefusal,
} from './live-inspect';

const MB = 1024 * 1024;
/** How often a lane's trace is read for new snapshots while a window has Inspect open on it. */
const READ_MS = 400;
/** The most bytes of a file one read takes: the rest waits for the next. */
const MAX_READ = 8 * MB;
/** The most reads of a file one turn takes as Inspect opens, to catch up with it: the rest waits for the next turn. */
const MAX_READS_A_TURN = 16;
/** The longest line of a trace read whole: a snapshot's event of `MAX_SNAPSHOT_BYTES` and its wrapping. */
const MAX_SNAPSHOT_LINE = MAX_SNAPSHOT_BYTES + 64 * 1024;
/** The longest line of a trace's network file read: a resource's record, its headers included. */
const MAX_NETWORK_LINE = MB;
/** How much of a line passed over for its length is read: where its fields start. */
const LONG_LINE_HEAD = 1024;
/** The most trace files of an attempt read: its own, and those of the contexts it opened, the newest. */
const MAX_TRACE_FILES = 8;
/** The most resources the trace recorded that are kept by page and address: past them, the oldest go. */
const MAX_RECORDED_RESOURCES = 4096;
/** The most calls whose step and title are kept: past them, the oldest go. */
const MAX_CALLS = 4096;
/** The most values the attempt's calls typed that are kept, and values its secret fields held: the oldest go. */
const MAX_TYPED = 64;
const MAX_HELD = 256;
/** The most bytes the resources a snapshot names take in its header. */
const MAX_RESOURCE_LIST = 32 * 1024;
/** How deep stylesheets are followed through their imports for the resources they name. */
const CSS_DEPTH = 3;
/** The most bytes of snapshots a turn hides and keeps: the rest waits for a turn right after. */
const MAX_TAKEN_A_TURN = 16 * MB;
/** How long after a worker named no trace of its running attempt it is asked again, while Inspect is open. */
const ASK_AGAIN_MS = 2000;
/** The most lanes Inspect reads at once: one more is refused. */
const MAX_INSPECTED_LANES = 16;
/** The most bytes every lane's Inspect keeps together: past them, nothing new is kept. */
const MAX_DESKTOP_INSPECT_BYTES = 256 * MB;

/** What the desktop app's store says of a page it does not show: it reads the pages from the test's own trace. */
export const DESKTOP_INSPECT_WORDS: InspectWords = {
  gone: `The page at this call is no longer kept: the desktop app keeps a lane’s latest ${MAX_WORKER_SNAPSHOTS / MB} MB of pages while its test runs.`,
  unsent: `The desktop app did not keep the page this one builds on: it leaves out a page over ${MAX_SNAPSHOT_BYTES / MB} MB, one it cannot read whole, and, as Inspect opens, the oldest past ${MAX_SNAPSHOT_BACKLOG / MB} MB.`,
  testEnded: 'The page at this call is of a test that ended: the desktop app keeps the running test’s.',
  maskedGone: SNAPSHOT_MASKED_GONE,
  missing: 'The test’s trace holds no page of this call at that moment.',
  unreadable: 'The desktop app cannot read the page at this call whole.',
  tooLarge: SNAPSHOT_TOO_LARGE,
};

/** Why a page's snapshots go no further until its next navigation, as the tray says it. */
const TOO_LARGE = `The page is not shown: its snapshot is larger than ${MAX_SNAPSHOT_BYTES / MB} MB.`;
const UNREAD_SNAPSHOT =
  'The page is not shown: the desktop app could not read its snapshot whole (too deep, too large, or naming one it no longer holds), so it could not hide its secrets.';
const BEHIND = 'The page is not shown: Inspect fell behind the test’s calls.';
const OVER_BACKLOG = `The page is not shown: its snapshots since its navigation are larger than ${MAX_SNAPSHOT_BACKLOG / MB} MB.`;
const FULL = 'The page is not shown: the desktop app keeps no more pages for Inspect now.';
const UNTIL_NAVIGATION = 'Inspect shows it again from its next navigation.';
/** Why no page of the attempt shows: its trace takes no DOM snapshot. */
const NO_SNAPSHOTS =
  "Inspect has no page to show: this test's trace takes no DOM snapshots (its trace option's snapshots, or their dom, is off).";
/** How many calls a trace with no snapshot holds before Inspect says it takes none. */
const CALLS_BEFORE_NO_SNAPSHOTS = 3;

/** The trace lines read: a call as it begins, a DOM snapshot, a resource the page loaded. */
const BEFORE_LINE = '{"type":"before"';
const SNAPSHOT_LINE = '{"type":"frame-snapshot"';
const RESOURCE_LINE = '{"type":"resource-snapshot"';

/** The calls that type text, and the parameter of Playwright's protocol that holds it. */
const TYPING: ReadonlyMap<string, 'value' | 'text'> = new Map([
  ['fill', 'value'],
  ['type', 'text'],
  ['keyboardType', 'text'],
  ['keyboardInsertText', 'text'],
]);

/** A line of a trace passed over for its length, where it was among the others: its first `LONG_LINE_HEAD` characters. */
interface TraceGap {
  head: string;
}

/** Whether `file` is a regular file, not a link; false when it is not there. */
async function isPlainFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/** Opens a regular file for reading, never through a link; null when it cannot. */
async function openPlain(file: string): Promise<fs.FileHandle | null> {
  if (!(await isPlainFile(file))) return null;
  try {
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if ((await handle.stat()).isFile()) return handle;
    await handle.close();
    return null;
  } catch {
    return null;
  }
}

/**
 * One file of the trace, read from where the last read stopped, its complete lines alone: a line longer than
 * `maxLine` is passed over, a `TraceGap` in its place. `behind` says the file held more than the last read took.
 */
class DesktopTraceTail {
  private offset = 0;
  private rest = '';
  private skipping = false;
  private decoder = new StringDecoder('utf8');
  behind = false;

  constructor(
    readonly file: string,
    private readonly maxLine: number,
  ) {}

  async read(): Promise<Array<string | TraceGap>> {
    const handle = await openPlain(this.file);
    if (!handle) return [];
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
      this.behind = size - this.offset > length;
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
      const lines: Array<string | TraceGap> = (this.rest + text)
        .split('\n')
        .map((line) => (line.length > this.maxLine ? { head: line.slice(0, LONG_LINE_HEAD) } : line));
      const rest = lines.pop() ?? '';
      this.rest = typeof rest === 'string' ? rest : '';
      if (typeof rest !== 'string') {
        // The line the read ends in is passed over to its end, which a later read finds.
        lines.push(rest);
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

/**
 * The trace files of the attempt in the runner's trace folder `traces`, whose names start with `base`: its own, and
 * those of the contexts it opened (`-recording<N>`), `MAX_TRACE_FILES` at most, the newest past them.
 */
export async function desktopAttemptFiles(traces: string, base: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(traces);
  } catch {
    return [];
  }
  const own = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-recording(\\d+))?\\.trace$`);
  const files = names
    .map((name) => ({ name, match: own.exec(name) }))
    .filter((file) => file.match)
    .map(({ name, match }) => ({ name, n: match![1] === undefined ? -1 : Number(match![1]) }))
    .sort((a, b) => a.n - b.n);
  const kept = files.length > MAX_TRACE_FILES ? [files[0]!, ...files.slice(1 - MAX_TRACE_FILES)] : files;
  return kept.map((file) => path.join(traces, file.name));
}

/** A resource a page loaded, as the trace recorded it: its file under `resources/` and its content type. */
interface Recorded {
  sha1: string;
  contentType: string;
}

/** A snapshot read, as it waits to be kept. */
interface Waiting {
  fields: Omit<LiveSnapshot, 'resources' | 'title'>;
  callId: string;
  snapshot: Record<string, unknown>;
  bytes: number;
}

/** What a reader of a lane's trace reads, and where what it read goes. */
export interface DesktopTraceReaderOptions {
  /** The runner's trace folder of the lane's worker, and the name the attempt's files start with. */
  trace: Pick<LaneTrace, 'traces' | 'base'>;
  /** The store the snapshots and resources go into, and the key of the lane's worker in it. */
  store: RunInspect;
  key: string;
  /** The lane's worker's index, which each notice names. */
  worker: number;
  /** The running test's title, which each notice names. */
  test: string | null;
  /** The runner's title of a call by the id of its step, as the lane's layers named it; null when not heard. */
  titleOf?(call: string): string | null;
  /** A snapshot was kept: the windows with Inspect open hear of it. */
  kept(notice: DesktopInspectNotice): void;
  /** Why a page goes no further, said once for a main frame's chain, or why the trace has no page. */
  refused(text: string): void;
  readMs?: number;
}

/** A wait of `ms` milliseconds that keeps no process alive. */
function later(ms: number, then: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(then, ms);
  timer.unref?.();
  return timer;
}

/**
 * Reads a lane's running attempt's trace as it grows, its snapshots and the resources they name, into `store`, from
 * as it starts until it closes.
 */
export class DesktopTraceReader {
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  /** Whether the reads caught up with the trace once: the latest page's snapshots are kept first. */
  private caughtUp = false;
  private readonly tails = new Map<string, DesktopTraceTail>();
  /** How many snapshots of each frame the trace holds so far: the next one's place. */
  private readonly counts = new Map<string, number>();
  /** The frames that are a page's main frame, as their snapshots said. */
  private readonly mainFrames = new Set<string>();
  /** Each main frame's snapshots since its last full one, by place, as the trace wrote them, for the labels. */
  private readonly chains = new Map<string, Map<number, Record<string, unknown>>>();
  private chainBytes = 0;
  private readonly chainSizes = new Map<Record<string, unknown>, number>();
  /** The snapshots that wait to be kept, oldest first, and their bytes. */
  private queue: Waiting[] = [];
  private queued = 0;
  /** The frames whose chain stopped: none of their snapshots is kept until their next full one. */
  private readonly stopped = new Set<string>();
  /** The runner's step and the trace's title of each call, by the trace's id of it. */
  private readonly calls = new Map<string, { step: string; title: string }>();
  private snapshotsRead = 0;
  private toldNoSnapshots = false;
  /** The resources the trace recorded, by page and address. */
  private readonly recorded = new Map<string, Recorded>();
  /** The resources a stylesheet names, by its file. */
  private readonly cssNames = new Map<string, string[]>();
  /** The resources not kept: not there, past their bound, or not of their kind. */
  private readonly unkept = new Set<string>();
  /** The values the attempt's calls typed into a secret field, and those its secret fields held, the latest last. */
  private typed: string[] = [];
  private readonly held = new Set<string>();

  constructor(private readonly options: DesktopTraceReaderOptions) {}

  start(): void {
    this.schedule(0);
  }

  /** Nothing more is read nor kept. */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.queued = 0;
    this.chains.clear();
    this.chainSizes.clear();
  }

  private schedule(wait: number): void {
    if (this.closed || this.timer) return;
    this.timer = later(wait, () => {
      this.timer = null;
      void this.turn();
    });
  }

  /**
   * Read what the trace gained, then keep what waits once the reads caught up with it, `MAX_TAKEN_A_TURN` bytes at
   * most; again `READ_MS` later, or at once while more waits.
   */
  async turn(): Promise<void> {
    if (this.closed || this.reading) return;
    this.reading = true;
    let more = false;
    try {
      if (!(await this.read())) this.caughtUp = true;
      if (this.caughtUp) more = await this.keepWaiting();
    } catch {
      // A trace that cannot be read now is read again next turn.
    } finally {
      this.reading = false;
    }
    this.schedule(more ? 0 : (this.options.readMs ?? READ_MS));
  }

  private tail(file: string, maxLine: number): DesktopTraceTail {
    let tail = this.tails.get(file);
    if (!tail) {
      tail = new DesktopTraceTail(file, maxLine);
      this.tails.set(file, tail);
    }
    return tail;
  }

  /** Read each file of the trace from where it stopped: its resources first, then its calls and snapshots. */
  private async read(): Promise<boolean> {
    let behind = false;
    for (const file of await desktopAttemptFiles(this.options.trace.traces, this.options.trace.base)) {
      const network = this.tail(file.replace(/\.trace$/, '.network'), MAX_NETWORK_LINE);
      for (let i = 0; i < MAX_READS_A_TURN && !this.closed; i++) {
        for (const line of await network.read()) {
          if (this.closed) break;
          if (typeof line === 'string' && line.startsWith(RESOURCE_LINE)) this.takeResource(line);
        }
        if (!network.behind) break;
      }
      const trace = this.tail(file, MAX_SNAPSHOT_LINE);
      for (let i = 0; i < MAX_READS_A_TURN && !this.closed; i++) {
        for (const line of await trace.read()) {
          if (this.closed) break;
          if (typeof line !== 'string') this.passedOver(line.head);
          else if (line.startsWith(BEFORE_LINE)) this.takeCall(line);
          else if (line.startsWith(SNAPSHOT_LINE)) this.takeSnapshot(line);
        }
        if (!trace.behind) break;
      }
      behind ||= network.behind || trace.behind;
    }
    if (!behind && !this.toldNoSnapshots && !this.snapshotsRead && this.calls.size >= CALLS_BEFORE_NO_SNAPSHOTS) {
      this.toldNoSnapshots = true;
      this.tell(NO_SNAPSHOTS);
    }
    return behind;
  }

  /** A resource a page loaded: kept by its page and address when Inspect may show it. */
  private takeResource(line: string): void {
    let event: { snapshot?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return;
    }
    const record = event.snapshot;
    if (!record || typeof record.pageref !== 'string') return;
    const url = (record.request as { url?: unknown } | undefined)?.url;
    const content = (record.response as { content?: Record<string, unknown> } | undefined)?.content;
    const file = typeof content?._file === 'string' ? content._file : content?._sha1;
    const sha1 = typeof file === 'string' ? file.replace(/^resources\//, '') : null;
    const contentType = inspectResourceType(content?.mimeType);
    if (typeof url !== 'string' || url.length > MAX_RESOURCE_URL || !isResourceSha1(sha1) || !contentType) return;
    const at = resolveResourceUrl(url, null);
    if (!at) return;
    const key = `${record.pageref}\n${at}`;
    this.recorded.delete(key);
    this.recorded.set(key, { sha1, contentType });
    if (this.recorded.size > MAX_RECORDED_RESOURCES) this.recorded.delete(this.recorded.keys().next().value!);
  }

  /** A call as it begins: its runner's step and the trace's title of it, and the text it types into a secret field. */
  private takeCall(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const { callId, stepId, title, apiName, method, params } = event;
    if (!isLayerCallId(callId)) return;
    const step = isLayerCallId(stepId) ? stepId : callId;
    const own = [title, apiName, method].find((one): one is string => typeof one === 'string' && !!one.trim());
    this.calls.set(callId, { step, title: own ?? 'Call' });
    if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value!);
    const key = typeof method === 'string' ? TYPING.get(method) : undefined;
    const given = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    const value = key ? given[key] : undefined;
    const selector = typeof given.selector === 'string' && given.selector ? given.selector : null;
    if (typeof value === 'string' && value.trim() && (selector === null || isSecretLocator(selector))) {
      this.typed = [...this.typed.filter((one) => one !== value), value].slice(-MAX_TYPED);
    }
  }

  /** A snapshot's line passed over for its length: its frame counts it where it was, and its chain stops there. */
  private passedOver(head: string): void {
    const frame = /"frameId":"([^"]{1,200})"/.exec(head)?.[1];
    if (!head.startsWith(SNAPSHOT_LINE) || !frame) return;
    this.snapshotsRead++;
    this.counts.set(frame, (this.counts.get(frame) ?? 0) + 1);
    this.stopChain(frame, TOO_LARGE, 'kept');
  }

  /** A snapshot: numbered in its frame, and, of a page's main frame, kept for its chain and queued to be kept. */
  private takeSnapshot(line: string): void {
    let snapshot: Record<string, unknown>;
    try {
      snapshot = (JSON.parse(line) as { snapshot: Record<string, unknown> }).snapshot;
    } catch {
      return;
    }
    const { frameId, callId, pageId, wallTime } = snapshot ?? {};
    if (typeof pageId !== 'string' || !isLayerCallId(pageId) || typeof frameId !== 'string') return;
    if (!isLayerCallId(frameId)) return;
    this.snapshotsRead++;
    const index = this.counts.get(frameId) ?? 0;
    this.counts.set(frameId, index + 1);
    if (snapshot.isMainFrame === false || !Array.isArray(snapshot.html)) return;
    this.mainFrames.add(frameId);
    const full = isFullSnapshot(snapshot.html);
    this.keepInChain(frameId, index, full, snapshot, line.length);
    if (full) this.stopped.delete(frameId);
    const phase = snapshotPhase(snapshot);
    if (!phase || !isLayerCallId(callId) || this.stopped.has(frameId)) return;
    if (full) {
      // The page navigated: its snapshots before it are not kept.
      const before = this.queue.length;
      this.queue = this.queue.filter((one) => one.fields.page !== pageId);
      if (this.queue.length !== before) this.queued = this.queue.reduce((sum, one) => sum + one.bytes, 0);
    }
    if (this.caughtUp && this.queued + line.length > MAX_SNAPSHOT_BACKLOG) {
      this.stopChain(frameId, BEHIND, 'kept');
      return;
    }
    const at = typeof wallTime === 'number' && wallTime > 1e12 ? wallTime : Date.now();
    const step = this.calls.get(callId)?.step ?? callId;
    this.queue.push({
      fields: { call: step, phase, page: pageId, frame: frameId, main: true, full, index, at },
      callId,
      snapshot,
      bytes: line.length,
    });
    this.queued += line.length;
    if (!this.caughtUp) this.trimBacklog();
  }

  /**
   * The snapshots waiting as Inspect opens, within `MAX_SNAPSHOT_BACKLOG`: past it, the oldest after a frame's full one
   * go, never a full one; with full ones alone left, the oldest one's frame keeps none of its chain.
   */
  private trimBacklog(): void {
    while (this.queued > MAX_SNAPSHOT_BACKLOG && this.queue.length) {
      const at = this.queue.findIndex((one) => !one.fields.full);
      if (at >= 0) {
        this.queued -= this.queue.splice(at, 1)[0]!.bytes;
        continue;
      }
      this.stopChain(this.queue[0]!.fields.frame, OVER_BACKLOG, 'none');
    }
  }

  /**
   * A snapshot of `frame` is not kept, for `why`: its chain stops until its next full snapshot, and the windows hear
   * why for a page's main frame. The frame's snapshots waiting stay (`kept`: they come before it), go up to a full one,
   * which starts its chain again (`until-full`: they come after it), or all go (`none`).
   */
  private stopChain(frame: string, why: string, waiting: 'kept' | 'until-full' | 'none'): void {
    let restarts = false;
    if (waiting !== 'kept') {
      const kept: Waiting[] = [];
      for (const one of this.queue) {
        if (one.fields.frame === frame && one.fields.full && waiting === 'until-full') restarts = true;
        if (one.fields.frame === frame && !restarts) this.queued -= one.bytes;
        else kept.push(one);
      }
      this.queue = kept;
    }
    if (restarts) return;
    const told = this.stopped.has(frame);
    this.stopped.add(frame);
    if (this.mainFrames.has(frame) && !told) this.tell(`${why} ${UNTIL_NAVIGATION}`);
  }

  /** Tell the windows why a page goes no further, or why the trace has none: a reader closed tells nothing. */
  private tell(text: string): void {
    if (!this.closed) this.options.refused(text);
  }

  /** Keep a main frame's snapshot for the labels a later one's references name, its chain started again by a full one. */
  private keepInChain(
    frame: string,
    index: number,
    full: boolean,
    snapshot: Record<string, unknown>,
    bytes: number,
  ): void {
    let chain = this.chains.get(frame);
    if (full || !chain) {
      for (const old of chain?.values() ?? []) this.forget(old);
      chain = new Map();
      this.chains.set(frame, chain);
    }
    chain.set(index, snapshot);
    this.chainSizes.set(snapshot, bytes);
    this.chainBytes += bytes;
    // Past twice the backlog's bound, the oldest kept go: a snapshot that names one of them is not kept.
    for (const kept of this.chains.values()) {
      for (const [at, old] of kept) {
        if (this.chainBytes <= 2 * MAX_SNAPSHOT_BACKLOG) return;
        if (old === snapshot) continue;
        kept.delete(at);
        this.forget(old);
      }
    }
  }

  private forget(snapshot: Record<string, unknown>): void {
    this.chainBytes -= this.chainSizes.get(snapshot) ?? 0;
    this.chainSizes.delete(snapshot);
  }

  /** The nodes the references of the frame's snapshot at `index` name, from its chain kept. */
  private resolver(frame: string, index: number): SnapshotResolver {
    const chain = this.chains.get(frame);
    const nodes = new Map<number, unknown[] | null>();
    const at =
      (from: number): SnapshotResolver =>
      (back, node) => {
        const target = from - back;
        const snapshot = back > 0 ? chain?.get(target) : undefined;
        if (!snapshot) return null;
        let list = nodes.get(target);
        if (list === undefined) {
          list = snapshotNodes(snapshot.html);
          nodes.set(target, list);
        }
        return list && node >= 0 && node < list.length ? { node: list[node], resolve: at(target) } : null;
      };
    return at(index);
  }

  /** Keep what waits, oldest first, `MAX_TAKEN_A_TURN` bytes at most; whether more waits. */
  private async keepWaiting(): Promise<boolean> {
    let taken = 0;
    while (this.queue.length && !this.closed) {
      if (taken >= MAX_TAKEN_A_TURN) return true;
      const next = this.queue.shift()!;
      this.queued -= next.bytes;
      taken += next.bytes;
      await this.keep(next);
    }
    return false;
  }

  /** The attempt's secrets known now: what its calls typed into a secret field, and what its secret fields held. */
  private secrets(): string[] {
    return [...new Set([...this.typed, ...this.held])];
  }

  /**
   * Keep a snapshot, what its page's secrets show removed, after the resources it names; its frame's chain stops when it
   * is not kept.
   */
  private async keep(waiting: Waiting): Promise<void> {
    const { fields, snapshot } = waiting;
    const resolve = this.resolver(fields.frame, fields.index);
    const held = snapshotFieldSecrets(snapshot.html, resolve);
    if (!held) return this.stopChain(fields.frame, UNREAD_SNAPSHOT, 'until-full');
    for (const value of held) {
      this.held.delete(value);
      this.held.add(value);
      if (this.held.size > MAX_HELD) this.held.delete(this.held.values().next().value!);
    }
    const secrets = this.secrets();
    const shown = hideFrameSnapshotSecrets(snapshot, { secrets, resolve });
    if (!shown) return this.stopChain(fields.frame, UNREAD_SNAPSHOT, 'until-full');
    const data = Buffer.from(JSON.stringify(shown));
    if (data.length > MAX_SNAPSHOT_BYTES) return this.stopChain(fields.frame, TOO_LARGE, 'until-full');
    const named: LiveSnapshotResource[] = [];
    for (const resource of await this.resourcesOf(snapshot, fields.page)) {
      if (this.closed) return;
      if (!(await this.keepResource(resource))) continue;
      const url = hideResourceUrl(resource.url, secrets);
      if (url) named.push({ url, sha1: resource.sha1 });
    }
    if (this.closed) return;
    const title = this.titleOf(fields.call, waiting.callId);
    const added = this.options.store.addSnapshot(this.options.key, {
      ...fields,
      title,
      resources: named,
      data,
      test: this.options.test,
    });
    if (added === 'full') return this.stopChain(fields.frame, FULL, 'until-full');
    if (added !== 'kept' || this.closed) return;
    this.options.kept({
      type: 'snapshot',
      shard: null,
      worker: this.options.worker,
      ...fields,
      title,
      test: this.options.test,
    });
  }

  /**
   * A call's title: the runner's of its step (`step`, the trace's `stepId` of the call, else its id), as the lane's
   * layers named it, else the trace's own of the call (`callId`); what it types hidden.
   */
  private titleOf(step: string, callId: string): string {
    const title = this.options.titleOf?.(step) ?? this.calls.get(callId)?.title ?? 'Call';
    return hideSecretsInText(hideTypedText(title)).slice(0, 300);
  }

  /** Keep a resource from the trace folder's `resources/` in the store, once; whether the store holds it. */
  private async keepResource(resource: LiveSnapshotResource & Recorded): Promise<boolean> {
    if (this.options.store.resource(resource.sha1)) return true;
    if (this.unkept.has(resource.sha1)) return false;
    const bytes = await this.resourceBytes(resource.sha1);
    if (!bytes || !isInspectResourceBytes(resource.contentType, bytes)) {
      this.unkept.add(resource.sha1);
      return false;
    }
    const added = this.options.store.addResource({
      sha1: resource.sha1,
      contentType: resource.contentType,
      data: bytes,
    });
    return added === 'kept' || added === 'held';
  }

  /** A resource's bytes, from the trace folder's `resources/` alone, no link; null past `MAX_RESOURCE_BYTES` or unread. */
  private async resourceBytes(sha1: string): Promise<Buffer | null> {
    if (!isResourceSha1(sha1)) return null;
    const folder = path.join(this.options.trace.traces, 'resources');
    try {
      if (!(await fs.lstat(folder)).isDirectory()) return null;
    } catch {
      return null;
    }
    const handle = await openPlain(path.join(folder, sha1));
    if (!handle) return null;
    try {
      const { size } = await handle.stat();
      if (size === 0 || size > MAX_RESOURCE_BYTES) return null;
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await handle.read(bytes, 0, size, 0);
      return bytesRead === size ? bytes : null;
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * The resources a snapshot names that its page loaded and Inspect may show, by their addresses as the page asked for
   * them, with those its stylesheets name, `MAX_SNAPSHOT_RESOURCES` at most and `MAX_RESOURCE_LIST` bytes of names.
   */
  private async resourcesOf(
    snapshot: Record<string, unknown>,
    page: string,
  ): Promise<Array<LiveSnapshotResource & Recorded>> {
    const found = new Map<string, LiveSnapshotResource & Recorded>();
    let bytes = 0;
    const add = async (urls: readonly string[], depth: number): Promise<void> => {
      for (const url of urls) {
        if (found.has(url) || found.size >= MAX_SNAPSHOT_RESOURCES) continue;
        const recorded = this.recorded.get(`${page}\n${url}`);
        if (!recorded) continue;
        bytes += url.length + recorded.sha1.length + 20;
        if (bytes > MAX_RESOURCE_LIST) return;
        found.set(url, { url, ...recorded });
        if (recorded.contentType === 'text/css' && depth < CSS_DEPTH) {
          const named = (await this.cssNamesOf(recorded.sha1))
            .map((ref) => resolveResourceUrl(ref, url))
            .filter((one): one is string => one !== null);
          await add(named, depth + 1);
        }
      }
    };
    await add(snapshotResourceUrls(snapshot), 0);
    return [...found.values()];
  }

  /** What a stylesheet of the trace names, read once. */
  private async cssNamesOf(sha1: string): Promise<string[]> {
    let names = this.cssNames.get(sha1);
    if (!names) {
      const bytes = await this.resourceBytes(sha1);
      names = bytes && isInspectResourceBytes('text/css', bytes) ? cssReferences(bytes.toString('utf8')) : [];
      this.cssNames.set(sha1, names);
    }
    return names;
  }
}

/** The attempt a worker runs, as Inspect follows it: Playwright's id of its test and its retry. */
function attemptOf(test: { id: string; retry: number }): string {
  return `${test.id}#${test.retry}`;
}

/** A lane a window has Inspect open on, as the server reads it. */
interface InspectedLane {
  ref: string;
  lane: number;
  /** The windows that have it open, by their stream's id. */
  viewers: Set<string>;
  /** The attempt it follows: the lane's running test (`attemptOf`); null between tests. */
  attempt: string | null;
  /** That test's title, which each snapshot names, and the index of the worker that runs it. */
  test: string | null;
  worker: number | null;
  reader: DesktopTraceReader | null;
  store: RunInspect | null;
  /** Why no page of the attempt shows, as last said; null when nothing was. */
  refused: string | null;
  asking: boolean;
  /** When the worker is asked again for its attempt's trace. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The runner's title of each of the lane's calls, as its layers named them, by the id of the call's step. */
  titles: Map<string, string>;
  closed: boolean;
}

/** Why a page of Inspect does not show: the store's refusal, or a window that has Inspect not open on the lane (409). */
type InspectRefusal = LiveSnapshotRefusal | { status: 409; message: string };

/** What a window hears of a lane: the attempt Inspect follows, with a snapshot read of it or why none shows. */
type InspectTold = { attempt: string | null; snapshot?: DesktopInspectNotice; refused?: string };

/** The hub's sessions, as Inspect reads them: the runs now, and a lane's checked trace for this server alone. */
export interface DesktopInspectSessions {
  current(): RunSession[];
  laneTrace(params: { ref: string; lane: number }): Promise<LaneTrace | { ok: false; message: string }>;
}

export interface DesktopInspectsOptions {
  sessions: DesktopInspectSessions;
  /** Tell a window, by its stream's id, what Inspect read of a lane it has open. */
  send(viewer: string, event: DesktopInspectEvent): void;
  readMs?: number;
  askAgainMs?: number;
  budget?: InspectBudget;
}

/** The key of a lane of a run. */
function laneKey(ref: string, lane: number): string {
  return `${ref}#${lane}`;
}

/** **Inspect** of the lanes the app's windows have it open on: one reader of each lane's running attempt's trace. */
export class DesktopInspects {
  private readonly lanes = new Map<string, InspectedLane>();
  private readonly budget: InspectBudget;

  constructor(private readonly options: DesktopInspectsOptions) {
    this.budget = options.budget ?? new InspectBudget(MAX_DESKTOP_INSPECT_BYTES);
  }

  /**
   * The window `viewer` opens Inspect on the lane `lane` of the run `ref`: the lane's running attempt's trace is read
   * while a window has it open, and each window hears what is read of it.
   */
  open(viewer: string, ref: string, lane: number): RunControlResult {
    const session = this.options.sessions.current().find((one) => one.ref === ref && !one.ended);
    if (!session) return { ok: false, message: 'The run has ended.' };
    if (!session.workers.some((worker) => worker.parallelIndex === lane)) {
      return { ok: false, message: `This run has no worker ${lane + 1} now.` };
    }
    const key = laneKey(ref, lane);
    let inspected = this.lanes.get(key);
    if (!inspected) {
      if (this.lanes.size >= MAX_INSPECTED_LANES) {
        return { ok: false, message: `Inspect is open on ${MAX_INSPECTED_LANES} lanes already: close one first.` };
      }
      inspected = {
        ref,
        lane,
        viewers: new Set(),
        attempt: null,
        test: null,
        worker: null,
        reader: null,
        store: null,
        refused: null,
        asking: false,
        timer: null,
        titles: new Map(),
        closed: false,
      };
      this.lanes.set(key, inspected);
    }
    inspected.viewers.add(viewer);
    this.follow(inspected, session);
    return { ok: true, message: "Inspect shows the test's pages from its own trace, on this machine." };
  }

  /** The window `viewer` closes Inspect on a lane: the last one to close it stops its reading, and what it kept goes. */
  close(viewer: string, ref: string, lane: number): RunControlResult {
    const inspected = this.lanes.get(laneKey(ref, lane));
    if (inspected?.viewers.delete(viewer) && !inspected.viewers.size) this.end(inspected);
    return { ok: true, message: 'Inspect closed.' };
  }

  /** The window `viewer` left: it has Inspect open on no lane. */
  leave(viewer: string): void {
    for (const inspected of [...this.lanes.values()]) {
      if (inspected.viewers.delete(viewer) && !inspected.viewers.size) this.end(inspected);
    }
  }

  /** A run changed: each lane of it with Inspect open follows its running attempt, and its end ends them. */
  sessionChanged(session: RunSession): void {
    for (const inspected of [...this.lanes.values()]) {
      if (inspected.ref !== session.ref) continue;
      if (session.ended) {
        this.tell(inspected, { attempt: null });
        this.end(inspected);
      } else {
        this.follow(inspected, session);
      }
    }
  }

  /** The runner's title of a call of a lane, as the lane's layers named it: Inspect names the call's snapshots so. */
  titled(ref: string, lane: number, call: string, title: string): void {
    const inspected = this.lanes.get(laneKey(ref, lane));
    if (!inspected || !isLayerCallId(call) || !title.trim()) return;
    inspected.titles.delete(call);
    inspected.titles.set(call, title);
    if (inspected.titles.size > MAX_CALLS) inspected.titles.delete(inspected.titles.keys().next().value!);
  }

  /** What the window `viewer` hears as it opens Inspect on a lane it has it open on; null for one it has not. */
  calls(viewer: string, ref: string, lane: number): DesktopInspectCalls | null {
    const inspected = this.lanes.get(laneKey(ref, lane));
    if (!inspected?.viewers.has(viewer)) return null;
    const worker = inspected.worker;
    const heard = worker === null ? [] : (inspected.store?.heard(String(inspected.lane)) ?? []);
    return {
      attempt: inspected.attempt,
      heard: heard
        .slice(-MAX_DESKTOP_INSPECT_LISTED)
        .map((one): DesktopInspectNotice => ({ type: 'snapshot', shard: null, worker: worker ?? 0, ...one })),
      refused: inspected.refused,
    };
  }

  /**
   * The store of a lane the window `viewer` has Inspect open on, its pages rendered as the run page's are, by the key
   * of the lane's worker in it; null for a lane it has not open.
   */
  storeOf(viewer: string, ref: string, lane: number): { store: RunInspect | null; key: string } | null {
    const inspected = this.lanes.get(laneKey(ref, lane));
    if (!inspected?.viewers.has(viewer)) return null;
    return { store: inspected.store, key: String(lane) };
  }

  /** The page at a call's moment of a lane the window has Inspect open on, rendered; a refusal otherwise. */
  async page(
    viewer: string,
    ref: string,
    lane: number,
    call: string,
    phase: SnapshotPhase,
  ): Promise<LiveSnapshotPage | InspectRefusal> {
    const open = this.storeOf(viewer, ref, lane);
    if (!open) return { status: 409, message: 'This window has no Inspect open on that lane: open it first.' };
    if (!open.store) return { status: 404, message: DESKTOP_INSPECT_WORDS.missing };
    return open.store.render(open.key, call, phase);
  }

  /** The viewport of the page at a call's moment of a lane the window has Inspect open on; a refusal otherwise. */
  viewport(
    viewer: string,
    ref: string,
    lane: number,
    call: string,
    phase: SnapshotPhase,
  ): LiveSnapshotPage['viewport'] | InspectRefusal {
    const open = this.storeOf(viewer, ref, lane);
    if (!open) return { status: 409, message: 'This window has no Inspect open on that lane: open it first.' };
    if (!open.store) return { status: 404, message: DESKTOP_INSPECT_WORDS.missing };
    return open.store.viewport(open.key, call, phase);
  }

  /** The server stops: every lane's reading stops, and what it kept goes. */
  dispose(): void {
    for (const inspected of [...this.lanes.values()]) this.end(inspected);
  }

  /** Follow the lane's running attempt: another one lets go what was kept of the one before, and asks for its trace. */
  private follow(inspected: InspectedLane, session: RunSession): void {
    const worker = session.workers.find((one) => one.parallelIndex === inspected.lane) ?? null;
    const attempt = worker?.test ? attemptOf(worker.test) : null;
    if (attempt !== inspected.attempt) {
      this.stopReading(inspected);
      inspected.attempt = attempt;
      inspected.test = worker?.test ? worker.test.title.join(' › ') : null;
      inspected.worker = worker?.worker ?? null;
      inspected.refused = null;
      inspected.titles.clear();
      this.tell(inspected, { attempt });
    }
    if (attempt && !inspected.reader && !inspected.asking && !inspected.timer) void this.ask(inspected);
  }

  /** Ask the lane's worker for its attempt's trace, and read it; say why not, and ask again a while later. */
  private async ask(inspected: InspectedLane): Promise<void> {
    const attempt = inspected.attempt;
    inspected.asking = true;
    const found = await this.options.sessions
      .laneTrace({ ref: inspected.ref, lane: inspected.lane })
      .catch((): { ok: false; message: string } => ({ ok: false, message: 'The test did not answer.' }));
    inspected.asking = false;
    if (inspected.closed) return;
    if (inspected.attempt !== attempt) {
      if (inspected.attempt && !inspected.reader && !inspected.timer) void this.ask(inspected);
      return;
    }
    if (!found.ok || attemptOf(found.test) !== attempt) {
      const message = found.ok ? 'The test ended: Inspect shows the one that runs now.' : found.message;
      if (message !== inspected.refused) {
        inspected.refused = message;
        this.tell(inspected, { attempt, refused: message });
      }
      inspected.timer = later(this.options.askAgainMs ?? ASK_AGAIN_MS, () => {
        inspected.timer = null;
        if (!inspected.closed && inspected.attempt === attempt && !inspected.reader) void this.ask(inspected);
      });
      return;
    }
    if (inspected.refused) {
      // The trace is read now: why none was is said no more.
      inspected.refused = null;
      this.tell(inspected, { attempt });
    }
    const store = new RunInspect(this.budget, DESKTOP_INSPECT_WORDS);
    inspected.store = store;
    // What a reader tells is of the attempt it reads: the lane hears none of it once it follows another.
    const current = () => !inspected.closed && inspected.attempt === attempt && inspected.reader === reader;
    const reader = new DesktopTraceReader({
      trace: found,
      store,
      key: String(inspected.lane),
      worker: found.worker,
      test: inspected.test,
      titleOf: (call) => inspected.titles.get(call) ?? null,
      kept: (snapshot) => {
        if (!current()) return;
        if (inspected.refused) inspected.refused = null;
        this.tell(inspected, { attempt, snapshot });
      },
      refused: (text) => {
        if (!current()) return;
        inspected.refused = text;
        this.tell(inspected, { attempt, refused: text });
      },
      readMs: this.options.readMs,
    });
    inspected.reader = reader;
    reader.start();
  }

  /** The lane's reading stops, and what it kept of its attempt goes. */
  private stopReading(inspected: InspectedLane): void {
    if (inspected.timer) clearTimeout(inspected.timer);
    inspected.timer = null;
    inspected.reader?.close();
    inspected.reader = null;
    inspected.store?.clear();
    inspected.store = null;
  }

  private end(inspected: InspectedLane): void {
    inspected.closed = true;
    this.stopReading(inspected);
    this.lanes.delete(laneKey(inspected.ref, inspected.lane));
  }

  /** Tell each window with Inspect open on the lane. */
  private tell(inspected: InspectedLane, event: InspectTold): void {
    const message = { type: 'inspect', ref: inspected.ref, lane: inspected.lane, ...event } as DesktopInspectEvent;
    for (const viewer of inspected.viewers) this.options.send(viewer, message);
  }
}

/** The moments of a call a page of Inspect is taken at. */
const PHASES: readonly string[] = ['before', 'action', 'after'];

/** The window, run and lane a request of Inspect names (`viewer`, `ref`, `lane`), checked one by one; null otherwise. */
export function readDesktopInspectLane(
  query: Record<string, unknown>,
): { viewer: string; ref: string; lane: number } | null {
  const { viewer, ref, lane } = query;
  if (!isDesktopRunViewer(viewer) || typeof ref !== 'string' || !/^[\w-]{1,64}$/.test(ref)) return null;
  if (typeof lane !== 'string' || !/^\d{1,4}$/.test(lane)) return null;
  return { viewer, ref, lane: Number(lane) };
}

/** The call and moment a request of a page of Inspect names (`call`, `phase`), checked; null otherwise. */
export function readDesktopInspectMoment(
  query: Record<string, unknown>,
): { call: string; phase: SnapshotPhase } | null {
  const { call, phase } = query;
  if (!isLayerCallId(call) || typeof phase !== 'string' || !PHASES.includes(phase)) return null;
  return { call, phase: phase as SnapshotPhase };
}
