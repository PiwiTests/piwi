import type { Page } from '@playwright/test';
import { LatestPacer, fitViewSize } from '@piwitests/core/run-view';
import { maskSecretFields, type SecretFieldMask } from './live-mask.js';
import { openPageView, type PageFrame, type PageView } from './page-view.js';

/**
 * The worker's lane, as every viewer outside the page sees it: the test it runs (Playwright's id), the page that test
 * shows (its `page` fixture's, else the first page the browser opened during it, else the next one still open once
 * that one closes), and the stop it stands at with that stop's page. The page shown is the stop's while the worker
 * stands at one (its own page when the stop names none), else the running test's; none between two tests.
 *
 * One live view of the page shown (`openPageView`) feeds every sink that subscribes: the editor's views of a stop and
 * of the lane through the run connection (`run-channel.ts`), and the team instance's (`live-view.ts`). Its frames are
 * masked once (`live-mask.ts`: the page's secret fields, and the masks every sink names), each sink then taking them at
 * its own pace (`LatestPacer`), the latest alone while its way out is busy. The view asks the page for the largest size
 * and the highest quality and pace a sink asks, keeps each frame within the smallest size in bytes one takes, and opens
 * again when the page shown or what the sinks ask changes. Nothing runs while no sink subscribes, and nothing here
 * stores a frame: each sink keeps the latest it was given, in memory, for a viewer that comes later.
 */

/** How long closing the view may take before the test goes on without waiting for it. */
const CLOSE_MS = 1000;

/**
 * A frame of the lane: the page's, the test it shows (null for a stop held outside a test), and the stop the worker
 * stands at (null while it runs).
 */
interface LaneFrame extends PageFrame {
  test: string | null;
  stop: number | null;
}

/** Where the lane stands as an image goes, or as the view says none goes. */
export interface LaneAt {
  test: string | null;
  stop: number | null;
}

/** What a sink asks of the lane's frames, and where they go. */
export interface LaneSink {
  /** The largest frame it takes, in pixels: the page's viewport scaled down to fit (`fitViewSize`). */
  maxWidth: number;
  maxHeight: number;
  /** The JPEG quality it asks. */
  quality: number;
  /** The most frames it takes a second. */
  fps: number;
  /** The least time after a frame it took before the next one, when longer than a frame's interval. */
  spacing?(frame: PageFrame): number;
  /** The longest frame it takes, in bytes. */
  maxFrameBytes: number;
  /** The quality of the lighter image taken in place of a frame too long, and how often at most. */
  lightQuality: number;
  shotMs: number;
  /**
   * The locators it paints over beyond the page's secret fields; null for masks this reporter cannot read, which holds
   * every image back. A sink that names none leaves it out.
   */
  masks?(): readonly string[] | null;
  /** Whether its way out is backed up: the latest frame alone waits. */
  busy(): boolean;
  send(frame: LaneFrame): void;
  /** No image goes, and why: `why`, or each image of the page is too long, a lighter one included. */
  refuse(why: string | undefined, at: LaneAt): void;
}

/** A sink's hold on the lane's frames. */
export interface LaneSubscription {
  /** The view the sink is fed from now, once open: null when the page shown could not be read, or none is. */
  ready(): Promise<PageView | null>;
  /** Send the sink the latest frame it took again, or why none goes: a still page paints no other. */
  resend(): void;
  /** Forget the latest frame of every sink, and take an image of the page now: the masks changed. */
  refresh(): void;
  close(): Promise<void>;
}

interface LaneTest {
  id: string;
  /** The `page` fixture's page, which it shows first. */
  fixture: Page | null;
  /** The pages the browser opened during it, oldest first. */
  seen: Page[];
}

/** The latest frame given, or why none goes. */
type Kept = LaneFrame | { refused: string | undefined; at: LaneAt };

interface Subscriber {
  sink: LaneSink;
  pacer: LatestPacer<LaneFrame>;
  last: Kept | null;
}

interface Source {
  page: Page;
  /** What the sinks asked as it opened. */
  asked: string;
  view: Promise<PageView | null>;
  mask: SecretFieldMask;
  onClose: () => void;
  /** The latest frame it gave the sinks, or why none goes: a sink that comes later is given it. */
  latest: Kept | null;
}

let test: LaneTest | null = null;
let stop: { id: number; page: Page | null } | null = null;
const subscribers = new Set<Subscriber>();
let source: Source | null = null;
/** The close of each page's views still settling: a view of that page opens once it settled. */
const closingOf = new WeakMap<Page, Promise<void>>();

/** A test with Playwright's id `id` begins: its page shows once known. */
export function laneTestBegan(id: string): void {
  test = { id, fixture: null, seen: [] };
  void sync();
}

/** The running test's `page` fixture: the page it shows. */
export function lanePage(page: Page): void {
  if (!test || test.fixture === page) return;
  test.fixture = page;
  void sync();
}

/** A page the browser opened: the running test shows it while it shows no other. */
export function laneSawPage(page: Page): void {
  if (!test || test.seen.includes(page)) return;
  test.seen.push(page);
  if (!source) void sync();
}

/** The running test ended: its view closes, `CLOSE_MS` at most. */
export async function laneTestEnded(): Promise<void> {
  test = null;
  stop = null;
  await within(sync(), CLOSE_MS);
}

/** The worker stands at the stop `id` from now on, on `page` (null when the stop names none). */
export function laneStopped(id: number, page: Page | null): void {
  stop = { id, page };
  void sync();
  restamp();
}

/** The stop `id` ended: the running test's page shows again. */
export function laneWentOn(id: number): void {
  if (stop?.id !== id) return;
  stop = null;
  void sync();
  restamp();
}

/**
 * The view goes on showing the same page as the worker stops or goes on: the latest frame it gave, which a still page
 * paints no other after, names where the lane stands now, and goes to every sink again.
 */
function restamp(): void {
  const kept = source?.latest;
  if (!source || !kept || 'refused' in kept || kept.test !== (test?.id ?? null)) return;
  const framed: LaneFrame = { ...kept, stop: stop?.id ?? null };
  source.latest = framed;
  for (const subscriber of subscribers) subscriber.pacer.offer(framed);
}

/** Where the lane stands now: its test and its stop. */
export function laneAt(): LaneAt {
  return { test: test?.id ?? null, stop: stop?.id ?? null };
}

/** Whether `kept` shows where the lane stands now: a frame of a test or a stop it left goes nowhere. */
function current(kept: Kept): boolean {
  const at = 'refused' in kept ? kept.at : kept;
  return at.test === (test?.id ?? null) && at.stop === (stop?.id ?? null);
}

/** The page shown now: the stop's, else the running test's; null between two tests or with none open. */
function lanePageShown(): Page | null {
  const open = (page: Page | null): Page | null => (page && !page.isClosed() ? page : null);
  const own = open(stop?.page ?? null);
  if (own) return own;
  if (!test) return null;
  return open(test.fixture) ?? test.seen.find((page) => !page.isClosed()) ?? null;
}

/** A subscriber's pace: the latest frame alone waits, and one of where the lane no longer stands never goes. */
function pacerOf(own: Subscriber): LatestPacer<LaneFrame> {
  return new LatestPacer<LaneFrame>({
    intervalMs: 1000 / own.sink.fps,
    ...(own.sink.spacing ? { spacing: own.sink.spacing } : {}),
    busy: () => own.sink.busy(),
    send: (frame) => {
      if (!subscribers.has(own) || !current(frame)) return;
      own.last = frame;
      own.sink.send(frame);
    },
  });
}

/** Give a subscriber a frame at its pace, or why none goes at once. */
function give(own: Subscriber, kept: Kept): void {
  if (!('refused' in kept)) return own.pacer.offer(kept);
  own.last = kept;
  own.sink.refuse(kept.refused, kept.at);
}

/** Feed `sink` the lane's frames from now on, until the subscription closes. */
export function subscribeLane(sink: LaneSink): LaneSubscription {
  const own = { sink, last: null } as Subscriber;
  own.pacer = pacerOf(own);
  subscribers.add(own);
  void sync();
  // A view already open gives the latest frame it gave: a still page paints no other.
  if (source?.latest && current(source.latest)) give(own, source.latest);
  return {
    ready: async () => {
      // The view the sink is fed from once the page shown and what the sinks ask settled.
      for (;;) {
        const shown = source;
        const view = await (shown ? shown.view : Promise.resolve(null));
        if (shown === source) return view;
      }
    },
    resend: () => {
      const kept = own.last ?? source?.latest ?? null;
      if (!subscribers.has(own) || !kept || !current(kept)) return;
      if ('refused' in kept) sink.refuse(kept.refused, kept.at);
      else sink.send(kept);
    },
    refresh: () => {
      // No frame masked before goes: the ones waiting are dropped with the latest kept.
      for (const subscriber of subscribers) {
        subscriber.last = null;
        subscriber.pacer.close();
        subscriber.pacer = pacerOf(subscriber);
      }
      if (source) source.latest = null;
      void source?.view.then((view) => view?.refresh());
    },
    close: async () => {
      if (!subscribers.delete(own)) return;
      own.pacer.close();
      await within(sync(), CLOSE_MS);
    },
  };
}

/** What the sinks ask together. */
type Asked = Pick<LaneSink, 'maxWidth' | 'maxHeight' | 'quality' | 'fps' | 'maxFrameBytes' | 'lightQuality' | 'shotMs'>;

/** What the sinks ask together: the largest size, the highest quality and pace, the smallest frame in bytes. */
function asked(): Asked {
  const sinks = [...subscribers].map((subscriber) => subscriber.sink);
  return {
    maxWidth: Math.max(...sinks.map((sink) => sink.maxWidth)),
    maxHeight: Math.max(...sinks.map((sink) => sink.maxHeight)),
    quality: Math.max(...sinks.map((sink) => sink.quality)),
    fps: Math.max(...sinks.map((sink) => sink.fps)),
    maxFrameBytes: Math.min(...sinks.map((sink) => sink.maxFrameBytes)),
    lightQuality: Math.min(...sinks.map((sink) => sink.lightQuality)),
    shotMs: Math.min(...sinks.map((sink) => sink.shotMs)),
  };
}

/**
 * Open the view of the page shown for the sinks, close it with none, open it again on another page or ask; settles
 * once the view it closed did.
 */
function sync(): Promise<void> {
  const page = subscribers.size ? lanePageShown() : null;
  const options = page ? asked() : null;
  const key = options ? JSON.stringify(options) : '';
  if (source && source.page === page && source.asked === key) return Promise.resolve();
  const closed = source ? close(source) : Promise.resolve();
  source = page && options ? open(page, options, key) : null;
  return closed;
}

function close(shown: Source): Promise<void> {
  if (source === shown) source = null;
  shown.page.off('close', shown.onClose);
  const closed = shown.view
    .then((view) => view?.close())
    .then(
      () => undefined,
      () => undefined,
    );
  const settling = Promise.all([closingOf.get(shown.page), closed]).then(() => undefined);
  closingOf.set(shown.page, settling);
  void settling.then(() => {
    if (closingOf.get(shown.page) === settling) closingOf.delete(shown.page);
  });
  return closed;
}

function open(page: Page, options: Asked, key: string): Source {
  // A sink whose masks this reporter cannot read (null) holds every image back: the page may show what it masks.
  const masks = (): string[] | null => {
    const all = new Set<string>();
    for (const { sink } of subscribers) {
      if (!sink.masks) continue;
      const named = sink.masks();
      if (named === null) return null;
      for (const locator of named) all.add(locator);
    }
    return [...all];
  };
  const mask = maskSecretFields(page, {
    masks,
    quality: options.quality,
    lightQuality: options.lightQuality,
    maxBytes: options.maxFrameBytes,
  });
  const shown: Source = {
    page,
    asked: key,
    mask,
    view: Promise.resolve(null),
    latest: null,
    onClose: () => {
      if (source === shown) void sync();
    },
  };
  // The page's screencast is free once the views of the page closing now let it go.
  const free = closingOf.get(page) ?? Promise.resolve();
  shown.view = within(free, CLOSE_MS).then(() => (source === shown ? openView(shown, options) : null));
  page.once('close', shown.onClose);
  return shown;
}

function openView(shown: Source, options: Asked): Promise<PageView | null> {
  const live = (): boolean => source === shown;
  const sinks = () => [...subscribers].map((subscriber) => subscriber.sink);
  return openPageView(shown.page, {
    size: (viewport) => fitViewSize(viewport, options.maxWidth, options.maxHeight),
    quality: options.quality,
    fps: options.fps,
    // A frame no sink takes yet is not masked: the view waits as long as the sink that waits least.
    spacing: (frame) => {
      const all = sinks();
      return all.every((sink) => sink.spacing) ? Math.min(...all.map((sink) => sink.spacing!(frame))) : 0;
    },
    maxFrameBytes: options.maxFrameBytes,
    lightQuality: options.lightQuality,
    shotMs: options.shotMs,
    busy: () => shown.mask.resting || sinks().every((sink) => sink.busy()),
    live,
    screen: (frame) => shown.mask.screen(frame),
    send: (frame) => {
      if (!live()) return;
      const framed: LaneFrame = { ...frame, test: test?.id ?? null, stop: stop?.id ?? null };
      shown.latest = framed;
      for (const subscriber of subscribers) subscriber.pacer.offer(framed);
    },
    refuse: (why) => {
      if (!live()) return;
      const kept = { refused: why, at: laneAt() };
      shown.latest = kept;
      for (const subscriber of subscribers) give(subscriber, kept);
    },
  }).catch(() => null);
}

/** `run`, for `ms` at most: settles once it did or they passed, never throwing. */
async function within(run: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    run.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}
