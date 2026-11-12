import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { MAX_SNAPSHOT_BACKLOG } from '@piwitests/core/live-inspect';
import {
  LIVE_FRAME_BYTE_RATE,
  LIVE_WORKER_POST_LIMITS,
  decodeLiveMessage,
  readLiveWorkerPost,
  type LiveWorkerPost,
} from '@piwitests/core/live-view';
import {
  INSPECT_MASKED,
  INSPECT_UNREAD_MASKS,
  LiveByteBudget,
  LiveInspect,
  type InspectLink,
} from '../src/internal/capture/live-inspect.js';
import { TraceTail } from '../src/internal/capture/lane-layers.js';

/**
 * Inspect's producer apart from a run: why no snapshot goes for a project that masks elements; the trace's lines and
 * those passed over for their length, numbered in their order; the snapshots waiting as Inspect opens and later, within
 * their bound; the bytes a second the live view's frames and Inspect share, which never keep a snapshot waiting more
 * than once; and nothing posted once Inspect closed.
 */

const ID = { shard: null, worker: 1, slot: 0 };
const PAGE = 'page@p';
const MAIN = 'frame@main';
const AT = 1_794_475_486_981;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The private parts of an Inspect the tests drive. */
interface Inner {
  queue: Array<{ fields: { index: number; full: boolean; frame: string }; bytes: number; waited: boolean }>;
  queued: number;
  source: { dir: string; files: () => Promise<string[]>; own: null } | null;
  caughtUp: boolean;
  counts: Map<string, number>;
  read(): Promise<boolean>;
  turn(): Promise<void>;
  pump(): void;
  takeSnapshot(line: string): void;
  sendResource(resource: { url: string; sha1: string; contentType: string }): Promise<void>;
}

const inner = (inspect: LiveInspect) => inspect as unknown as Inner;

/** A page of the trace's, closed, so its secrets are the attempt's known ones. */
function closedPage(): Page {
  return {
    _guid: PAGE,
    isClosed: () => true,
    context: () => ({ pages: () => [] }),
    mainFrame: () => ({ _guid: MAIN }),
  } as unknown as Page;
}

/** An open page whose secret fields cannot be read. */
function unreadPage(): Page {
  const page = {
    _guid: PAGE,
    isClosed: () => false,
    mainFrame: () => ({ _guid: MAIN }),
    frames: () => [{ locator: () => ({ evaluateAll: () => Promise.reject(new Error('gone')) }) }],
    context: () => ({ pages: () => [page] }),
  };
  return page as unknown as Page;
}

/** An Inspect of `page` whose posts are kept, read back as the instance reads them. */
function inspectOf(page: Page, link: Partial<InspectLink> = {}) {
  const posts: Array<LiveWorkerPost | string> = [];
  const inspect = new LiveInspect(page, {
    id: ID,
    test: () => 'pays',
    masks: () => [],
    post: async (body) => {
      const message = decodeLiveMessage(body, LIVE_WORKER_POST_LIMITS);
      posts.push(typeof message === 'string' ? message : readLiveWorkerPost(message));
      return 200;
    },
    budget: new LiveByteBudget(),
    sent: new Set(),
    ...link,
  });
  return { inspect, posts };
}

/** A `frame-snapshot` line of the trace, `pad` characters longer than its snapshot. */
function snapshotLine(frame: string, html: unknown, options: { main?: boolean; page?: string; pad?: number } = {}) {
  return JSON.stringify({
    type: 'frame-snapshot',
    snapshot: {
      callId: 'call@1',
      snapshotName: 'after@call@1',
      pageId: options.page ?? PAGE,
      frameId: frame,
      frameUrl: 'http://shop.test/',
      html,
      wallTime: AT,
      isMainFrame: options.main ?? true,
      pad: 'x'.repeat(options.pad ?? 0),
    },
  });
}

const FULL = (text: string) => ['HTML', {}, ['BODY', {}, text]];
const PART = [[1, 0]];
const MB = 1024 * 1024;

/** What `posts` said of why no page goes. */
const refusals = (posts: Array<LiveWorkerPost | string>) =>
  posts.flatMap((post) => (typeof post === 'object' && 'refused' in post ? [post.refused] : []));
const snapshots = (posts: Array<LiveWorkerPost | string>) =>
  posts.filter((post) => typeof post === 'object' && post.type === 'snapshot' && 'snapshot' in post);

let dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-live-inspect-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('Inspect of a page', () => {
  it('sends why no snapshot goes for a project that masks elements, or masks this reporter cannot read', async () => {
    for (const [masks, why] of [
      [["getByLabel('IBAN')"], INSPECT_MASKED],
      [null, INSPECT_UNREAD_MASKS],
    ] as const) {
      // A page Inspect never touches: no trace is read nor started.
      const page = new Proxy({} as Page, {
        get: () => {
          throw new Error('the page was read');
        },
      });
      const { inspect, posts } = inspectOf(page, { masks: () => masks });
      await inspect.open();
      await inspect.close();
      expect(posts).toEqual([{ type: 'snapshot', ...ID, refused: why, test: 'pays' }]);
    }
  });

  it('sends no snapshot, and says why, while the page’s secret fields cannot be read', async () => {
    const { inspect, posts } = inspectOf(unreadPage());
    inner(inspect).caughtUp = true;
    inner(inspect).takeSnapshot(snapshotLine(MAIN, FULL('a')));
    inner(inspect).pump();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(refusals(posts)).toEqual([
      'The page is not sent: its secret fields could not be read, so Inspect could not hide them. Inspect sends it again from its next navigation.',
    ]);
    // Its chain stops until the page's next full snapshot.
    inner(inspect).takeSnapshot(snapshotLine(MAIN, PART));
    expect(inner(inspect).queue).toEqual([]);
    await inspect.close();
  });

  it('numbers a line passed over for its length in its place among the lines of the same read', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.trace');
    const iframe = 'frame@f';
    let text = '';
    text += `${snapshotLine(iframe, FULL('A'), { main: false })}\n`;
    text += `${snapshotLine(iframe, ['HTML', {}, ['BODY', {}, 'B'], [[1, 0]]], { main: false })}\n`;
    // Lines of another page, so the long one crosses the first read's end.
    for (let i = 0; i < 39; i++) text += `${snapshotLine('frame@o', FULL('y'.repeat(100_000)), { page: 'page@o' })}\n`;
    text += `${snapshotLine(iframe, FULL('z'.repeat(6 * MB)), { main: false })}\n`;
    text += `${snapshotLine(iframe, FULL('D'), { main: false })}\n`;
    fs.writeFileSync(file, text);
    const { inspect } = inspectOf(closedPage());
    inner(inspect).source = { dir, files: async () => [file], own: null };
    await inner(inspect).read();
    await inner(inspect).read();
    expect(inner(inspect).queue.map((one) => one.fields.index)).toEqual([0, 1, 3]);
    expect(inner(inspect).counts.get(iframe)).toBe(4);
    await inspect.close();
  });

  it('sends nothing until its reads caught up with the trace', async () => {
    const { inspect, posts } = inspectOf(closedPage());
    let behind = true;
    inner(inspect).read = async () => behind;
    inner(inspect).takeSnapshot(snapshotLine(MAIN, FULL('a')));
    await inner(inspect).turn();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posts).toEqual([]);
    behind = false;
    await inner(inspect).turn();
    await vi.waitFor(() => expect(snapshots(posts)).toHaveLength(1));
    await inspect.close();
  });
});

describe('the snapshots waiting to go', () => {
  it('keep a frame’s full snapshot as Inspect opens, the oldest after it left out past their bound', async () => {
    const { inspect, posts } = inspectOf(closedPage());
    inner(inspect).takeSnapshot(snapshotLine(MAIN, FULL('a'), { pad: MB }));
    for (let i = 0; i < 20; i++) inner(inspect).takeSnapshot(snapshotLine(MAIN, PART, { pad: MB }));
    const queue = inner(inspect).queue;
    expect(queue[0]!.fields).toMatchObject({ index: 0, full: true });
    expect(queue.slice(1).map((one) => one.fields.index)).toEqual(
      Array.from({ length: queue.length - 1 }, (_, i) => 21 - queue.length + 1 + i),
    );
    expect(inner(inspect).queued).toBeLessThanOrEqual(MAX_SNAPSHOT_BACKLOG);
    expect(queue.length).toBeGreaterThan(10);
    expect(posts).toEqual([]);
    await inspect.close();
  });

  it('send none of a chain whose full snapshots alone are past their bound as Inspect opens, and say why', async () => {
    const { inspect, posts } = inspectOf(closedPage());
    inner(inspect).takeSnapshot(snapshotLine(MAIN, FULL('a'), { pad: 3 * MB }));
    for (let i = 0; i < 5; i++) {
      inner(inspect).takeSnapshot(snapshotLine(`frame@${i}`, FULL('b'), { main: false, pad: 3 * MB }));
    }
    expect(inner(inspect).queue.some((one) => one.fields.frame === MAIN)).toBe(false);
    expect(inner(inspect).queued).toBeLessThanOrEqual(MAX_SNAPSHOT_BACKLOG);
    expect(refusals(posts)).toEqual([
      'The page is not sent: its snapshots since its navigation are larger than 16 MB. Inspect sends it again from its next navigation.',
    ]);
    inner(inspect).takeSnapshot(snapshotLine(MAIN, PART));
    expect(inner(inspect).queue.some((one) => one.fields.frame === MAIN)).toBe(false);
    await inspect.close();
  });

  it('stop a chain past their bound once Inspect is open, those waiting kept, until its next full snapshot', async () => {
    const { inspect, posts } = inspectOf(closedPage());
    inner(inspect).takeSnapshot(snapshotLine(MAIN, FULL('a'), { pad: MB }));
    for (let i = 0; i < 14; i++) inner(inspect).takeSnapshot(snapshotLine(MAIN, PART, { pad: MB }));
    inner(inspect).caughtUp = true;
    const waiting = inner(inspect).queue.map((one) => one.fields.index);
    inner(inspect).takeSnapshot(snapshotLine(MAIN, PART, { pad: 2 * MB }));
    inner(inspect).takeSnapshot(snapshotLine(MAIN, PART));
    expect(inner(inspect).queue.map((one) => one.fields.index)).toEqual(waiting);
    expect(refusals(posts)).toEqual([
      'The page is not sent: Inspect fell behind the test’s calls. Inspect sends it again from its next navigation.',
    ]);
    inner(inspect).takeSnapshot(snapshotLine(MAIN, FULL('b')));
    expect(inner(inspect).queue.map((one) => one.fields.index)).toEqual([17]);
    await inspect.close();
  });
});

describe('the live view’s bytes a second', () => {
  it('say how long one of Inspect’s posts waits for what the frames and its own posts took, a second at most', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const budget = new LiveByteBudget();
    expect(budget.wait()).toBe(0);
    budget.spend(LIVE_FRAME_BYTE_RATE / 4);
    expect(budget.wait()).toBe(250);
    vi.advanceTimersByTime(100);
    expect(budget.wait()).toBe(150);
    budget.spend(LIVE_FRAME_BYTE_RATE * 10);
    expect(budget.wait()).toBe(1000);
    vi.advanceTimersByTime(20_000);
    expect(budget.wait()).toBe(0);
  });

  it('keep each snapshot waiting once at most while the frames take them all', async () => {
    vi.useFakeTimers({
      now: 1_000_000,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const budget = new LiveByteBudget();
    const { inspect, posts } = inspectOf(closedPage(), { budget });
    inner(inspect).caughtUp = true;
    for (let i = 0; i < 20; i++) inner(inspect).takeSnapshot(snapshotLine('frame@f', FULL(`${i}`), { main: false }));
    // Frames of 80 KB, each as soon as its own bytes allow.
    const frame = 80 * 1024;
    const frames = setInterval(() => budget.spend(frame), (frame * 1000) / LIVE_FRAME_BYTE_RATE);
    inner(inspect).pump();
    await vi.advanceTimersByTimeAsync(6000);
    clearInterval(frames);
    expect(snapshots(posts).length).toBeGreaterThanOrEqual(5);
    await inspect.close();
  });
});

describe('a resource of a snapshot', () => {
  it('is not posted once Inspect closed while it waited, nor when its bytes are not what its type says', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'resources'));
    const png = `${'a1'.repeat(20)}.png`;
    const svg = `${'b2'.repeat(20)}.png`;
    fs.writeFileSync(path.join(dir, 'resources', png), PNG);
    fs.writeFileSync(path.join(dir, 'resources', svg), '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const budget = new LiveByteBudget();
    const { inspect, posts } = inspectOf(closedPage(), { budget });
    inner(inspect).source = { dir, files: async () => [], own: null };
    await inner(inspect).sendResource({ url: 'http://shop.test/icon.png', sha1: svg, contentType: 'image/png' });
    expect(posts).toEqual([]);
    budget.spend(LIVE_FRAME_BYTE_RATE * 5);
    const sending = inner(inspect).sendResource({
      url: 'http://shop.test/logo.png',
      sha1: png,
      contentType: 'image/png',
    });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), { interval: 1 });
    await inspect.close();
    await vi.advanceTimersByTimeAsync(2000);
    await sending;
    expect(posts).toEqual([]);
  });
});

describe('a trace file read as it grows', () => {
  it('tells each line passed over for its length in its place among the others', async () => {
    const file = path.join(tempDir(), 'a.trace');
    fs.writeFileSync(file, `a\n${'y'.repeat(50)}\nb\n${'z'.repeat(30)}`);
    const tail = new TraceTail(file, 20);
    expect(await tail.read()).toEqual(['a', { head: 'y'.repeat(50) }, 'b', { head: 'z'.repeat(30) }]);
    fs.appendFileSync(file, 'zz\nc\n');
    expect(await tail.read()).toEqual(['c']);
  });
});
