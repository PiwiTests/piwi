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
 *   stopped, every `READ_MS`, a link or anything but a regular file never read. The trace folder and its resources
 *   folder are checked as each turn starts and again as each file opens: still folders whose real path is the one
 *   checked, so that neither they nor a folder above them is a link; else the reading stops, saying why. Of the
 *   trace: each call as it begins (`before`: its id, its title, the text it types), and the `frame-snapshot` events,
 *   each numbered in its frame as Playwright numbers them, a line past `MAX_SNAPSHOT_LINE` counted where it was and
 *   passed over. Of the network file: each resource a page loaded (`resource-snapshot`) that `inspectResourceType`
 *   allows, by its page and address.
 * - **What is kept.** The snapshots of every page's main frame, from the main frame's last full snapshot as Inspect
 *   opens (`MAX_SNAPSHOT_BACKLOG` bytes and `MAX_WAITING` snapshots at most, the oldest after a frame's full one left
 *   out), then each new one, in the trace's order; the reading and the keeping run in slices (`SLICE_MS`,
 *   `SLICE_ITEMS`), the server's other work running between them. Before one is kept, what its page's secrets show is
 *   removed (`hideFrameSnapshotSecrets`) with the attempt's secrets as the trace tells them: the values the secret
 *   fields of every frame held, learned from each snapshot of any frame as it is read, before anything of it is let go
 *   (`snapshotFieldSecrets`), and each value its calls typed into a field their locator names for a secret or with no
 *   locator. A snapshot that cannot be read whole, or past `MAX_SNAPSHOT_BYTES` once hidden, stops its frame's chain
 *   until its next full snapshot, saying why; one of another frame, its page's main frame's. Its call's title is the
 *   runner's of its step as the lane's layers named it (`titled`; the step is the call's `stepId` in the trace, else
 *   its id), else the trace's own, the text it types and its credentials hidden.
 * - **Resources.** Before a snapshot, each resource it names (`snapshotResourceUrls`, and what a stylesheet among them
 *   names, `cssReferences`, `CSS_DEPTH` imports deep) that its page loaded, from the trace folder's `resources/` alone,
 *   `MAX_RESOURCE_BYTES` at most and its bytes of the kind its content type says (`isInspectResourceBytes`): a
 *   stylesheet, a font, an image other than SVG; never a script, a document nor an SVG.
 * - **Memory.** Every lane's stores and readers share one budget (`MAX_DESKTOP_INSPECT_BYTES`): a reader counts each
 *   snapshot it parsed against it (`PARSED_COST` its line's bytes) while its frame's chain or the queue holds it, a
 *   snapshot the budget has no room for stopping its frame's chain, and gives it all back as it closes. It knows
 *   `MAX_FRAMES` frames, the names `MAX_CSS_SHEETS` stylesheets hold and `MAX_UNKEPT` resources it did not keep, the
 *   least recently seen going past them, and reads every file through one buffer of `MAX_READ` bytes.
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
  MAX_WORKER_SNAPSHOT_COUNT,
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
/** The most bytes of a file one read takes, into the reader's one buffer: the rest waits for the next. */
const MAX_READ = MB;
/** The most reads of a file one turn takes as Inspect opens, to catch up with it: the rest waits for the next turn. */
const MAX_READS_A_TURN = 128;
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
/**
 * The most frames a reader knows (their count, chain and whether they stopped), and pages whose main frame it knows:
 * past them, the least recently seen go.
 */
const MAX_FRAMES = 1024;
/** The most stylesheets whose names a reader keeps, and names of each: past them, the oldest go. */
const MAX_CSS_SHEETS = 256;
/** The most resources a reader remembers it did not keep: past them, the oldest go. */
const MAX_UNKEPT = 4096;
/** What a snapshot parsed for its frame's chain holds in memory, by its line's bytes, against the shared budget. */
const PARSED_COST = 3;
const CHAINED_OVERHEAD = 256;
/** The most bytes the resources a snapshot names take in its header. */
const MAX_RESOURCE_LIST = 32 * 1024;
/** How deep stylesheets are followed through their imports for the resources they name. */
const CSS_DEPTH = 3;
/** The most bytes of snapshots a turn hides and keeps: the rest waits for a turn right after. */
const MAX_TAKEN_A_TURN = 16 * MB;
/** The most snapshots that wait to be kept: as many as the store keeps of a lane. */
const MAX_WAITING = MAX_WORKER_SNAPSHOT_COUNT;
/** How long, and over how many lines or snapshots, a reader works before the server's other work runs. */
const SLICE_MS = 20;
const SLICE_ITEMS = 256;
/** How long after a worker named no trace of its running attempt it is asked again, while Inspect is open. */
const ASK_AGAIN_MS = 2000;
/** The most lanes Inspect reads at once: one more is refused. */
const MAX_INSPECTED_LANES = 16;
/** The most bytes every lane's Inspect keeps together: past them, nothing new is kept. */
const MAX_DESKTOP_INSPECT_BYTES = 256 * MB;

/** What the desktop app's store says of a page it does not show: it reads the pages from the test's own trace. */
export const DESKTOP_INSPECT_WORDS: InspectWords = {
  gone: `The page at this call is no longer kept: the desktop app keeps a lane’s latest ${MAX_WORKER_SNAPSHOTS / MB} MB of pages while its test runs.`,
  unsent: `The desktop app did not keep the page this one builds on: it leaves out a page over ${MAX_SNAPSHOT_BYTES / MB} MB, one it cannot read whole, and, as Inspect opens, the oldest past ${MAX_WAITING.toLocaleString('en-US')} pages or ${MAX_SNAPSHOT_BACKLOG / MB} MB.`,
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
const UNREAD_FRAME =
  'The page is not shown: the desktop app could not read one of its frames whole (too deep, too large, or naming one it no longer holds), so it could not hide its secrets.';
const BEHIND = 'The page is not shown: Inspect fell behind the test’s calls.';
const OVER_BACKLOG = `The page is not shown: its snapshots since its navigation are more than ${MAX_WAITING.toLocaleString('en-US')}, or larger than ${MAX_SNAPSHOT_BACKLOG / MB} MB.`;
const FULL = 'The page is not shown: the desktop app keeps no more pages for Inspect now.';
const UNTIL_NAVIGATION = 'Inspect shows it again from its next navigation.';
/** Why the reading of the trace stops: its folder is no longer the one checked. */
const FOLDER_MOVED =
  "Inspect stopped reading this test's trace: the runner's trace folder, a folder above it or its resources folder is a link or no longer a folder.";
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

/**
 * Whether `folder` is still the folder checked: a folder, spelled as the file system spells it with every link
 * followed, so that neither it nor a folder above it is a link. Null when it is not there.
 */
async function sameFolder(folder: string): Promise<boolean | null> {
  try {
    const [stat, real] = await Promise.all([fs.lstat(folder), fs.realpath(folder)]);
    return stat.isDirectory() && real === folder;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : false;
  }
}

/** How a file of the trace opens: to read, never through a link, and without waiting on a named pipe. */
const OPEN_PLAIN = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** Opens a regular file for reading, never through a link, and nothing else; null when it cannot. */
async function openPlain(file: string): Promise<fs.FileHandle | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, OPEN_PLAIN);
  } catch {
    return null;
  }
  try {
    if ((await handle.stat()).isFile()) return handle;
  } catch {
    // Its kind cannot be read: it is not read.
  }
  await handle.close().catch(() => undefined);
  return null;
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
    private readonly open: (file: string) => Promise<fs.FileHandle | null>,
  ) {}

  /** Read what the file gained, `buffer.length` bytes at most, into `buffer`, which the reader's tails share. */
  async read(buffer: Buffer): Promise<Array<string | TraceGap>> {
    const handle = await this.open(this.file);
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
      const length = Math.min(size - this.offset, buffer.length);
      this.behind = size - this.offset > length;
      if (length <= 0) return [];
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
 * those of the contexts it opened (`-recording<N>`), `MAX_TRACE_FILES` at most, the newest past them; null when the
 * folder cannot be listed.
 */
export async function desktopAttemptFiles(traces: string, base: string): Promise<string[] | null> {
  let names: string[];
  try {
    names = await fs.readdir(traces);
  } catch {
    return null;
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

/**
 * A snapshot read, parsed, and what it counts against the budget, by its line's bytes, while its frame's chain or the
 * queue holds it (`holders`).
 */
interface Chained {
  snapshot: Record<string, unknown>;
  bytes: number;
  cost: number;
  holders: number;
}

/** What a reader knows of a frame of the trace. */
interface FrameRead {
  /** How many of its snapshots the trace holds so far: the next one's place. */
  count: number;
  /** The page it is the main frame of, as its snapshots said; null for a frame in a page. */
  page: string | null;
  /** Whether its chain stopped: none of its snapshots is kept until its next full one. */
  stopped: boolean;
  /** Its snapshots since its last full one, by place, as the trace wrote them, for a later one's references. */
  chain: Map<number, Chained>;
}

/** A snapshot read, as it waits to be kept: what it is, and where it is in the queue (`WaitingQueue`). */
interface Waiting {
  fields: Omit<LiveSnapshot, 'resources' | 'title'>;
  callId: string;
  /** The snapshot, parsed, which the queue holds until it lets it go (`release`). */
  read: Chained;
  bytes: number;
  /** Its frame's turn in the queue as it came: a frame's snapshots dropped together end that turn. */
  turn: number;
  gone: boolean;
}

/** A frame's snapshots that wait: their turn, how many and their bytes, and the full one among them, if any. */
interface WaitingFrame {
  turn: number;
  count: number;
  bytes: number;
  full: Waiting | null;
}

/**
 * The snapshots that wait to be kept, oldest first, with how many and their bytes: each change takes a constant time,
 * but what it lets go, each once. A frame's snapshots go together (`dropFrame`) by ending its turn, and the queue is
 * built again once those gone outnumber, or outweigh, those that wait. Each one it no longer holds is let go
 * (`release`), but one taken (`shift`), which its taker lets go.
 */
class WaitingQueue {
  constructor(private readonly release: (one: Waiting) => void) {}

  private items: Array<Waiting | undefined> = [];
  private head = 0;
  /** Where the oldest snapshot that is not full is looked for: each one before it is full, or gone. */
  private partial = 0;
  private turns = 0;
  private readonly frames = new Map<string, WaitingFrame>();
  /** The snapshots let go by their frame that the list still holds, and their bytes. */
  private goneCount = 0;
  private goneBytes = 0;
  count = 0;
  bytes = 0;

  push(one: Omit<Waiting, 'turn' | 'gone'>): void {
    let frame = this.frames.get(one.fields.frame);
    if (!frame) {
      frame = { turn: ++this.turns, count: 0, bytes: 0, full: null };
      this.frames.set(one.fields.frame, frame);
    }
    const waiting: Waiting = { ...one, turn: frame.turn, gone: false };
    frame.count++;
    frame.bytes += one.bytes;
    if (one.fields.full) frame.full = waiting;
    this.items.push(waiting);
    this.count++;
    this.bytes += one.bytes;
  }

  /** The oldest that waits, taken out of the queue; undefined when none waits. */
  shift(): Waiting | undefined {
    const one = this.peek();
    if (!one) return undefined;
    this.items[this.head++] = undefined;
    this.remove(one);
    this.compact();
    return one;
  }

  /** The oldest that waits, left in the queue, those gone before it let go. */
  peek(): Waiting | undefined {
    while (this.head < this.items.length) {
      const one = this.items[this.head];
      if (one && this.waits(one)) return one;
      if (one) {
        this.forgetGone(one);
        this.release(one);
      }
      this.items[this.head++] = undefined;
    }
    this.reset();
    return undefined;
  }

  /** Whether a full snapshot of `frame` waits: the oldest of its frame's that wait, which starts its chain again. */
  waitsFull(frame: string): boolean {
    return !!this.frames.get(frame)?.full;
  }

  /** Let go every snapshot of `frame` that waits. */
  dropFrame(frame: string): void {
    const waiting = this.frames.get(frame);
    if (!waiting) return;
    this.frames.delete(frame);
    this.count -= waiting.count;
    this.bytes -= waiting.bytes;
    this.goneCount += waiting.count;
    this.goneBytes += waiting.bytes;
    this.compact();
  }

  /** Let go the oldest snapshot that waits and is not full; false when every one that waits is full. */
  dropOldestPartial(): boolean {
    this.partial = Math.max(this.partial, this.head);
    for (; this.partial < this.items.length; this.partial++) {
      const one = this.items[this.partial];
      if (!one || !this.waits(one) || one.fields.full) continue;
      this.items[this.partial++] = undefined;
      this.remove(one);
      this.release(one);
      return true;
    }
    return false;
  }

  /** Let go everything. */
  clear(): void {
    for (let at = this.head; at < this.items.length; at++) {
      const one = this.items[at];
      if (one) this.release(one);
    }
    this.frames.clear();
    this.count = 0;
    this.bytes = 0;
    this.reset();
  }

  private waits(one: Waiting): boolean {
    return !one.gone && this.frames.get(one.fields.frame)?.turn === one.turn;
  }

  /** Take a snapshot that waits out of the counts. */
  private remove(one: Waiting): void {
    one.gone = true;
    const frame = this.frames.get(one.fields.frame)!;
    frame.count--;
    frame.bytes -= one.bytes;
    if (frame.full === one) frame.full = null;
    if (!frame.count) this.frames.delete(one.fields.frame);
    this.count--;
    this.bytes -= one.bytes;
  }

  /** A snapshot its frame let go, which the list held, is out of the list. */
  private forgetGone(one: Waiting): void {
    if (one.gone) return;
    one.gone = true;
    this.goneCount--;
    this.goneBytes -= one.bytes;
  }

  /** Build the list again of those that wait once those gone outnumber or outweigh them, or its read part is long. */
  private compact(): void {
    if (this.goneCount > this.count + 1024 || this.goneBytes > this.bytes + MAX_SNAPSHOT_BYTES) {
      const waiting: Waiting[] = [];
      for (let at = this.head; at < this.items.length; at++) {
        const one = this.items[at];
        if (one && this.waits(one)) {
          waiting.push(one);
        } else if (one) {
          one.gone = true;
          this.release(one);
        }
      }
      this.items = waiting;
      this.head = 0;
      this.partial = 0;
      this.goneCount = 0;
      this.goneBytes = 0;
    } else if (this.head > 4096 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.partial = Math.max(0, this.partial - this.head);
      this.head = 0;
    }
  }

  private reset(): void {
    this.items = [];
    this.head = 0;
    this.partial = 0;
    this.goneCount = 0;
    this.goneBytes = 0;
  }
}

/** Work cut in slices: `due` once a slice is spent, and `next` lets the event loop's other work run before the next. */
class Slices {
  private since = performance.now();
  private items = 0;

  due(): boolean {
    return ++this.items >= SLICE_ITEMS || performance.now() - this.since >= SLICE_MS;
  }

  async next(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.since = performance.now();
    this.items = 0;
  }
}

/** What a reader of a lane's trace reads, and where what it read goes. */
export interface DesktopTraceReaderOptions {
  /** The runner's trace folder of the lane's worker, and the name the attempt's files start with. */
  trace: Pick<LaneTrace, 'traces' | 'base'>;
  /** The store the snapshots and resources go into, and the key of the lane's worker in it. */
  store: RunInspect;
  key: string;
  /**
   * The budget every lane's Inspect shares, which the store counts against too: the snapshots the reader parsed and
   * keeps for their frames' chains count against it. Its own, of `MAX_DESKTOP_INSPECT_BYTES`, when not given.
   */
  budget?: InspectBudget;
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
  /** The files of the attempt read, and the one buffer their reads go through. */
  private readonly tails = new Map<string, DesktopTraceTail>();
  private buffer: Buffer | null = null;
  /** The frames of the trace, the least recently seen first, and the main frame of each page. */
  private readonly frames = new Map<string, FrameRead>();
  private readonly pageMains = new Map<string, string>();
  /** The bytes of the lines of the snapshots the frames' chains keep, and what they count against the budget. */
  private chainBytes = 0;
  private charged = 0;
  private readonly budget: InspectBudget;
  /** The snapshots that wait to be kept, oldest first. */
  private readonly queue = new WaitingQueue((one) => this.release(one.read));
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

  constructor(private readonly options: DesktopTraceReaderOptions) {
    this.budget = options.budget ?? new InspectBudget(MAX_DESKTOP_INSPECT_BYTES);
  }

  start(): void {
    this.schedule(0);
  }

  /** Nothing more is read nor kept: what the frames' chains counted is given back to the budget. */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.clear();
    this.frames.clear();
    this.pageMains.clear();
    this.tails.clear();
    this.buffer = null;
    this.budget.used -= this.charged;
    this.charged = 0;
    this.chainBytes = 0;
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
      if (this.caughtUp && !this.closed) more = await this.keepWaiting();
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
      tail = new DesktopTraceTail(file, maxLine, (one) => this.open(one));
      this.tails.set(file, tail);
    }
    return tail;
  }

  /** The lines a file of the trace gained, read through the reader's one buffer. */
  private lines(tail: DesktopTraceTail): Promise<Array<string | TraceGap>> {
    this.buffer ??= Buffer.alloc(MAX_READ);
    return tail.read(this.buffer);
  }

  /**
   * Read each file of the trace from where it stopped: its resources first, then its calls and snapshots. Its folder
   * and its resources folder are checked first, and again as each file opens (`open`).
   */
  private async read(): Promise<boolean> {
    let behind = false;
    const { traces } = this.options.trace;
    if (!(await this.holds(traces)) || (await this.holds(path.join(traces, 'resources'))) === false) return false;
    const slices = new Slices();
    const files = await desktopAttemptFiles(traces, this.options.trace.base);
    if (!files) return false;
    // A file no longer among the attempt's newest is not read again.
    const read = new Set(files.flatMap((file) => [file, file.replace(/\.trace$/, '.network')]));
    for (const file of this.tails.keys()) if (!read.has(file)) this.tails.delete(file);
    for (const file of files) {
      const network = this.tail(file.replace(/\.trace$/, '.network'), MAX_NETWORK_LINE);
      for (let i = 0; i < MAX_READS_A_TURN && !this.closed; i++) {
        for (const line of await this.lines(network)) {
          if (slices.due()) await slices.next();
          if (this.closed) break;
          if (typeof line === 'string' && line.startsWith(RESOURCE_LINE)) this.takeResource(line);
        }
        if (!network.behind) break;
      }
      const trace = this.tail(file, MAX_SNAPSHOT_LINE);
      for (let i = 0; i < MAX_READS_A_TURN && !this.closed; i++) {
        for (const line of await this.lines(trace)) {
          if (slices.due()) await slices.next();
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

  /**
   * A snapshot's line passed over for its length: its frame counts it where it was, and its chain stops there; what
   * its fields held is not read, so the pages of a frame in a page stop too.
   */
  private passedOver(head: string): void {
    const id = /"frameId":"([^"]{1,200})"/.exec(head)?.[1];
    if (!head.startsWith(SNAPSHOT_LINE) || !id) return;
    this.snapshotsRead++;
    const frame = this.frame(id);
    frame.count++;
    this.stopChain(id, TOO_LARGE, 'kept');
    const page = /"pageId":"([^"]{1,200})"/.exec(head)?.[1];
    if (frame.page === null && page) this.stopPage(page);
  }

  /**
   * A snapshot of any frame: numbered in its frame and kept for its chain, what its secret fields hold learned
   * (`learnSecrets`) before anything of it is let go; of a page's main frame, queued to be kept.
   */
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
    const frame = this.frame(frameId);
    const index = frame.count++;
    if (!Array.isArray(snapshot.html)) return;
    const main = snapshot.isMainFrame !== false;
    if (main) {
      frame.page = pageId;
      this.pageMains.delete(pageId);
      this.pageMains.set(pageId, frameId);
      if (this.pageMains.size > MAX_FRAMES) this.pageMains.delete(this.pageMains.keys().next().value!);
    }
    const readable = this.learnSecrets(frameId, index, snapshot.html);
    const full = isFullSnapshot(snapshot.html);
    const chained = this.keepInChain(frame, index, full, snapshot, line.length);
    if (!main) {
      if (!readable) this.stopPage(pageId);
      return;
    }
    if (full) {
      // The page navigated: its main frame's snapshots before it are not kept, and its chain starts again.
      this.queue.dropFrame(frameId);
      frame.stopped = false;
    }
    if (!readable) return this.stopChain(frameId, UNREAD_SNAPSHOT, 'kept');
    // A snapshot its frame's chain has no room for: a later one that names it could not be read.
    if (!chained) return this.stopChain(frameId, FULL, 'kept');
    const phase = snapshotPhase(snapshot);
    if (!phase || !isLayerCallId(callId) || frame.stopped) return;
    const queue = this.queue;
    if (this.caughtUp && (queue.bytes + line.length > MAX_SNAPSHOT_BACKLOG || queue.count >= MAX_WAITING)) {
      this.stopChain(frameId, BEHIND, 'kept');
      return;
    }
    const at = typeof wallTime === 'number' && wallTime > 1e12 ? wallTime : Date.now();
    const step = this.calls.get(callId)?.step ?? callId;
    chained.holders++;
    queue.push({
      fields: { call: step, phase, page: pageId, frame: frameId, main: true, full, index, at },
      callId,
      read: chained,
      bytes: line.length,
    });
    if (!this.caughtUp) this.trimBacklog();
  }

  /**
   * The snapshots waiting as Inspect opens, within `MAX_SNAPSHOT_BACKLOG` and `MAX_WAITING`: past them, the oldest
   * after a frame's full one go, never a full one; with full ones alone left, the oldest one's frame keeps none of its
   * chain.
   */
  private trimBacklog(): void {
    while (this.queue.bytes > MAX_SNAPSHOT_BACKLOG || this.queue.count > MAX_WAITING) {
      if (this.queue.dropOldestPartial()) continue;
      const oldest = this.queue.peek();
      if (!oldest) return;
      this.stopChain(oldest.fields.frame, OVER_BACKLOG, 'none');
    }
  }

  /**
   * A snapshot of `frame` is not kept, for `why`: its chain stops until its next full snapshot, and the windows hear
   * why for a page's main frame. The frame's snapshots waiting stay (`kept`: they come before it), go up to a full one,
   * which starts its chain again (`until-full`: they come after it), or all go (`none`).
   */
  private stopChain(frame: string, why: string, waiting: 'kept' | 'until-full' | 'none'): void {
    // A frame's full snapshot that waits is the oldest of its frame's that wait: its navigation let go those before it.
    if (waiting === 'until-full' && this.queue.waitsFull(frame)) return;
    if (waiting !== 'kept') this.queue.dropFrame(frame);
    const read = this.frames.get(frame);
    if (!read || read.stopped) return;
    read.stopped = true;
    if (read.page !== null) this.tell(`${why} ${UNTIL_NAVIGATION}`);
  }

  /**
   * What the reader knows of a frame, seen now: past `MAX_FRAMES`, the least recently seen goes, its chain given back to
   * the budget and its snapshots that wait let go. One seen again after it went counts its snapshots from 0: a
   * reference of one to a snapshot before cannot be read, which stops its chain until its next full snapshot.
   */
  private frame(id: string): FrameRead {
    let frame = this.frames.get(id);
    if (frame) {
      this.frames.delete(id);
    } else {
      frame = { count: 0, page: null, stopped: false, chain: new Map() };
    }
    this.frames.set(id, frame);
    if (this.frames.size > MAX_FRAMES) {
      const [oldest, gone] = this.frames.entries().next().value!;
      this.frames.delete(oldest);
      for (const old of gone.chain.values()) this.forget(old);
      this.queue.dropFrame(oldest);
      if (gone.page !== null && this.pageMains.get(gone.page) === oldest) this.pageMains.delete(gone.page);
    }
    return frame;
  }

  /**
   * Whether `folder`, the trace folder or its resources folder, is still the folder checked: null when it is not there
   * (nothing is read in it); false when it is a link, or a folder above it is, or it is no longer a folder, which stops
   * the reader, saying why.
   */
  private async holds(folder: string): Promise<boolean | null> {
    const same = await sameFolder(folder);
    if (same === false && !this.closed) {
      this.tell(FOLDER_MOVED);
      this.close();
    }
    return same;
  }

  /** Open a file of the trace folder or its resources folder to read, the folder checked again right before. */
  private async open(file: string): Promise<fs.FileHandle | null> {
    if (!(await this.holds(path.dirname(file))) || this.closed) return null;
    return openPlain(file);
  }

  /**
   * Learn what the secret fields of a frame's snapshot hold as it is read, its labels' references followed through
   * its frame's chain: every page kept hides it. Whether it could be read whole; one that cannot is read for what its
   * own nodes show.
   */
  private learnSecrets(frame: string, index: number, html: unknown): boolean {
    const whole = snapshotFieldSecrets(html, this.resolver(frame, index));
    for (const value of whole ?? snapshotFieldSecrets(html) ?? []) {
      this.held.delete(value);
      this.held.add(value);
      if (this.held.size > MAX_HELD) this.held.delete(this.held.values().next().value!);
    }
    return whole !== null;
  }

  /** A frame of the page `page` could not be read whole: its main frame's pages stop until its next navigation. */
  private stopPage(page: string): void {
    const main = this.pageMains.get(page);
    if (main) this.stopChain(main, UNREAD_FRAME, 'kept');
  }

  /** Tell the windows why a page goes no further, or why the trace has none: a reader closed tells nothing. */
  private tell(text: string): void {
    if (!this.closed) this.options.refused(text);
  }

  /**
   * Keep a frame's snapshot for what a later one's references name, its chain started again by a full one, what it
   * holds parsed counted against the budget (`PARSED_COST`). Past twice the backlog's bound, or past the budget, the
   * least recently seen frames' oldest go: a snapshot that names one of them cannot be read. What it counts, or null
   * when the budget has no room for it once they went.
   */
  private keepInChain(
    frame: FrameRead,
    index: number,
    full: boolean,
    snapshot: Record<string, unknown>,
    bytes: number,
  ): Chained | null {
    if (full) {
      for (const old of frame.chain.values()) this.forget(old);
      frame.chain.clear();
    }
    const kept: Chained = { snapshot, bytes, cost: PARSED_COST * bytes + CHAINED_OVERHEAD, holders: 1 };
    const room = () => this.chainBytes + bytes <= 2 * MAX_SNAPSHOT_BACKLOG && this.budget.fits(kept.cost);
    evict: for (const other of this.frames.values()) {
      for (const [at, old] of other.chain) {
        if (room()) break evict;
        other.chain.delete(at);
        this.forget(old);
      }
    }
    if (!room()) return null;
    frame.chain.set(index, kept);
    this.chainBytes += bytes;
    this.charged += kept.cost;
    this.budget.used += kept.cost;
    return kept;
  }

  /** A snapshot a frame's chain kept goes from it. */
  private forget(old: Chained): void {
    this.chainBytes -= old.bytes;
    this.release(old);
  }

  /** A holder of a snapshot read lets it go: once none holds it, what it counted is given back. */
  private release(read: Chained): void {
    if (--read.holders > 0 || this.closed) return;
    this.charged -= read.cost;
    this.budget.used -= read.cost;
  }

  /** The nodes the references of the frame's snapshot at `index` name, from its chain kept. */
  private resolver(frame: string, index: number): SnapshotResolver {
    const chain = this.frames.get(frame)?.chain;
    const nodes = new Map<number, unknown[] | null>();
    const at =
      (from: number): SnapshotResolver =>
      (back, node) => {
        const target = from - back;
        const snapshot = back > 0 ? chain?.get(target)?.snapshot : undefined;
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
    const slices = new Slices();
    while (!this.closed) {
      if (taken >= MAX_TAKEN_A_TURN) return true;
      const next = this.queue.shift();
      if (!next) return false;
      taken += next.bytes;
      try {
        await this.keep(next);
      } finally {
        this.release(next.read);
      }
      if (slices.due()) await slices.next();
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
    const { fields } = waiting;
    const { snapshot } = waiting.read;
    const resolve = this.resolver(fields.frame, fields.index);
    const secrets = this.secrets();
    const shown = hideFrameSnapshotSecrets(snapshot, { secrets, resolve });
    if (!shown) return this.stopChain(fields.frame, UNREAD_SNAPSHOT, 'until-full');
    const data = Buffer.from(JSON.stringify(shown));
    if (data.length > MAX_SNAPSHOT_BYTES) return this.stopChain(fields.frame, TOO_LARGE, 'until-full');
    const named: LiveSnapshotResource[] = [];
    const resources = await this.resourcesOf(snapshot, fields.page);
    for (const resource of resources) {
      if (this.closed) return;
      if (!(await this.keepResource(resource))) continue;
      if (this.closed) return;
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
    // A reader closed as it read keeps nothing: its store let everything go.
    if (this.closed) return false;
    if (!bytes || !isInspectResourceBytes(resource.contentType, bytes)) {
      this.unkept.add(resource.sha1);
      if (this.unkept.size > MAX_UNKEPT) this.unkept.delete(this.unkept.values().next().value!);
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
    const handle = await this.open(path.join(this.options.trace.traces, 'resources', sha1));
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
          if (this.closed) return;
          await add(named, depth + 1);
        }
      }
    };
    await add(snapshotResourceUrls(snapshot), 0);
    return [...found.values()];
  }

  /**
   * What a stylesheet of the trace names, `MAX_SNAPSHOT_RESOURCES` at most, read once while among the
   * `MAX_CSS_SHEETS` latest read.
   */
  private async cssNamesOf(sha1: string): Promise<string[]> {
    let names = this.cssNames.get(sha1);
    if (!names) {
      const bytes = await this.resourceBytes(sha1);
      if (this.closed) return [];
      names = bytes && isInspectResourceBytes('text/css', bytes) ? cssReferences(bytes.toString('utf8')) : [];
      names = names.slice(0, MAX_SNAPSHOT_RESOURCES);
      this.cssNames.set(sha1, names);
      if (this.cssNames.size > MAX_CSS_SHEETS) this.cssNames.delete(this.cssNames.keys().next().value!);
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
      budget: this.budget,
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
