import type { Page } from '@playwright/test';
import { FrameAcks, LatestPacer, isViewSize } from '@piwitests/core/run-view';
import { barHiddenShots, jpegCodec, jpegSize, within } from './live-mask.js';
import { callMethod, internalCall } from './quiet-capture.js';

/**
 * A live view of a page for a viewer outside it: the page's screencast (`page.screencast.start`, an internal call),
 * its frames paced and capped as the view's options say, the same for the editor's view of a stopped page
 * (`run-channel.ts`) and the run page's view on the team instance (`live-view.ts`). The size and quality a view asks
 * for apply unless another client of the page's one screencast came first (a test's video, its trace's images), whose
 * size and quality every later client gets; the view's end stops its own client alone, so that one stays whole. Its
 * frames are acknowledged at the view's pace (`FrameAcks`), one held at a time. Playwright gives a page one screencast
 * client of its own: where the view cannot hold it (the test runs one itself, another view of the page holds it), an
 * image of the page every `shotMs`, its caret as the page shows it. A test that starts or stops a screencast while a
 * view holds the page's client (`guardScreencast`) ends that client first, and the view goes on with images, as every
 * later view of that page does. A frame the same as the one before is dropped; one longer than `maxFrameBytes` is too,
 * an image of the page at `lightQuality` taken in its place, one at a time and `shotMs` apart, and when that one is too
 * long as well, the view says once why no frame goes (`refuse`), until a frame goes again. Frames go at most `fps` a
 * second (fewer when `spacing` holds a heavy one back), the latest one alone while the way out is `busy`. Each frame
 * passes through the view's `screen` before it goes: the frame goes as it returns it, or none goes, or the viewers
 * hear why none goes, the latest frame alone waiting meanwhile. Piwi's pause bar, which a headed stop shows in the
 * page, is painted over in each frame that may show it (`pauseBarShows`), by `screen` in the same pass as its own
 * boxes. The latest sent is kept in memory until the view ends, and sent again on `resend`, for a viewer that came
 * since (a still page paints no other). Nothing here stores a frame.
 */

/** How much earlier than the time Playwright names (its paint, or its dispatch) a screencast frame may show the page. */
const SCREENCAST_LAG_MS = 100;
/**
 * How long a frame waits for the pause bar's box to be read, once no image of the page is being taken without the bar,
 * before it goes as it is.
 */
const BAR_READ_MS = 1000;
/** How old a frame that names no time (before Playwright 1.61) is taken to be, against when the pause bar came down. */
const UNDATED_MS = 1000;

type Started = { dispose?: () => Promise<unknown> } | undefined;
type Screencast = {
  start?: (options: {
    size: { width: number; height: number };
    quality: number;
    onFrame: (frame: {
      data: Buffer;
      timestamp?: number;
      viewportWidth: number;
      viewportHeight: number;
    }) => Promise<void> | void;
  }) => Promise<Started>;
  stop?: () => Promise<void>;
};

/** A view that holds its page's screencast client, or is starting it: `release` ends the client, images follow. */
interface Holder {
  release(): Promise<void>;
}

/** The views of each page that hold its screencast client, or are starting it. */
const HOLDERS = new WeakMap<Page, Set<Holder>>();
/** The pages whose test started or stopped a screencast of its own: their views take images. */
const TEST_SCREENCASTS = new WeakSet<Page>();
/** The page's screencast as Playwright made it, for each one `guardScreencast` handed the test in its place. */
const OWN_SCREENCASTS = new WeakMap<object, Screencast>();

/** The page's own screencast, behind the guard the test is handed. */
function screencastOf(page: Page): Screencast | undefined {
  const seen = (page as unknown as { screencast?: Screencast }).screencast;
  return (seen && OWN_SCREENCASTS.get(seen)) ?? seen;
}

/** The test asks the page's screencast for itself: every view's client of the page ends first. */
function yieldToTest(page: Page): Promise<unknown> | null {
  TEST_SCREENCASTS.add(page);
  const holders = HOLDERS.get(page);
  if (!holders?.size) return null;
  return Promise.all([...holders].map((holder) => holder.release()));
}

/**
 * Hand the test `page.screencast` behind a guard: its `start` and `stop`, the test's, first end the client a view of
 * the page holds, so the test gets the page's one client. Every other call goes to the screencast as it is.
 */
export function guardScreencast(page: Page): void {
  const own = (page as unknown as { screencast?: unknown }).screencast;
  if (!own || typeof own !== 'object' || OWN_SCREENCASTS.has(own)) return;
  const guarded = new Proxy(own, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      if (prop !== 'start' && prop !== 'stop') return (...args: unknown[]) => callMethod(target, prop, args);
      return (...args: unknown[]) => {
        const yielded = yieldToTest(page);
        return yielded ? yielded.then(() => callMethod(target, prop, args)) : callMethod(target, prop, args);
      };
    },
  });
  OWN_SCREENCASTS.set(guarded, own as Screencast);
  try {
    (page as unknown as { screencast: object }).screencast = guarded;
  } catch {
    // A page whose screencast cannot be replaced keeps it: the test's own start then fails while a view holds it.
  }
}

/** A box of a frame, in the pixels it names its viewport in (`PageFrame`'s `width` and `height`). */
export interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A viewport's size, in the pixels a frame or a read names it in. */
interface Size {
  width: number;
  height: number;
}

/**
 * A read of the pause bar: its bottom edge in the viewport, 0 for a bar laid out nowhere in it, and the viewport's
 * size, in CSS pixels.
 */
interface BarRead extends Size {
  bottom: number;
}

/** Piwi's pause bar as a page last drew it. */
interface PauseBar {
  /** Settles once the bar is drawn. */
  drawn: Promise<unknown>;
  /** The latest read of the bar, when it began, and the viewport of the frames it was made for. */
  read: Promise<BarRead | null>;
  readAt: number;
  readFor: Size | null;
  /** Whether the latest read settled without a band, unanswered or laid out nowhere: the next frame reads it again. */
  missed: boolean;
  /** The latest read that found the bar laid out, for a frame the page painted before the bar came down. */
  found: BarRead | null;
  goneAt: number | null;
}

/** The pause bar each page drew last. */
const PAUSE_BARS = new WeakMap<Page, PauseBar>();

/**
 * Read the bar's bottom edge and the viewport's size in the page, through an internal call, once no image of the page
 * is being taken without the bar (`barHiddenShots`); null without an answer, or without a bar. A bar laid out nowhere
 * in the viewport reads as such (`bottom` 0), unless an image without it began meanwhile: it is read again once that
 * image is taken.
 */
async function readBar(page: Page, bar: PauseBar): Promise<BarRead | null> {
  type Document = { getElementById(id: string): { getBoundingClientRect(): { bottom: number } } | null };
  type Window = { document?: Document; innerWidth: number; innerHeight: number };
  for (;;) {
    const hidden = barHiddenShots(page);
    await hidden.ended;
    const read = await internalCall(page, () =>
      page.evaluate(() => {
        const view = globalThis as unknown as Window;
        const shown = view.document?.getElementById('__piwi-pause-bar');
        return shown
          ? { bottom: shown.getBoundingClientRect().bottom, width: view.innerWidth, height: view.innerHeight }
          : null;
      }),
    ).catch(() => null);
    if (!read) return null;
    if (read.bottom > 0 && read.width > 0) {
      bar.found = read;
      return read;
    }
    if (barHiddenShots(page).begun === hidden.begun) return { ...read, bottom: 0 };
    if (bar.goneAt !== null) return null;
  }
}

/** Read the bar again, once `after` settles, for the frames that name the viewport `madeFor`. */
function readBarAgain(
  page: Page,
  bar: PauseBar,
  madeFor: Size | null,
  after: Promise<unknown> = Promise.resolve(),
): void {
  const read = after.then(
    () => readBar(page, bar),
    () => null,
  );
  bar.read = read;
  bar.readAt = Date.now();
  bar.readFor = madeFor;
  bar.missed = false;
  void read.then((found) => {
    if (bar.read === read) bar.missed = !found || found.bottom <= 0;
  });
}

/**
 * Piwi's pause bar shows in `page` from now on, drawn once `drawn` settles: each view of the page paints it over, from
 * the viewport's top to the bar's bottom edge, across the viewport, as the bar is fixed there. Its bottom edge is read
 * through an internal call as soon as it is drawn, and again for a view that began after that read, for a frame that
 * names another viewport than the read was made for (the bar wraps on a narrower one), and after a read without a
 * band. Returns what tells that it came down: from then on, a frame the page painted later shows it no more.
 */
export function pauseBarShows(page: Page, drawn: Promise<unknown>): () => void {
  const bar: PauseBar = {
    drawn,
    read: Promise.resolve(null),
    readAt: 0,
    readFor: null,
    missed: false,
    found: null,
    goneAt: null,
  };
  readBarAgain(page, bar, null, drawn);
  PAUSE_BARS.set(page, bar);
  return () => {
    bar.goneAt ??= Date.now();
  };
}

/** Whether two viewports are the same size, within a pixel. */
const sameSize = (a: Size, b: Size): boolean => Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;

/**
 * The band of the pause bar `frame` may show, for a view that began at `since`: the bar shows, or the page painted the
 * frame before it came down (a frame that names no time taken as `UNDATED_MS` old). `frame` names its viewport in CSS
 * pixels, as `screen` hands it over. The bar's bottom edge is read with the viewport's size; while the bar shows, it is
 * read again for a view that began after the latest read, after a read without a band, and for a frame that names
 * another size than that read, unless the read was made for it already. The frame waits for an image of the page
 * taken without the bar to end, then `BAR_READ_MS` at most for the read. None when the frame shows no bar, the bar is
 * laid out nowhere in the viewport, or no read answered.
 */
async function pauseBarBoxes(page: Page, frame: PageFrame, since: number): Promise<FrameBox[]> {
  const bar = PAUSE_BARS.get(page);
  if (!bar) return [];
  if (bar.goneAt !== null && (Number.isFinite(frame.at) ? frame.at : Date.now() - UNDATED_MS) > bar.goneAt) return [];
  const viewport = { width: frame.width, height: frame.height };
  await barHiddenShots(page).ended;
  if (bar.goneAt === null) {
    const stale = bar.readAt < since || bar.missed;
    if (stale || !(bar.readFor && sameSize(bar.readFor, viewport))) {
      const current = stale ? undefined : await within(bar.read, BAR_READ_MS);
      if (current && sameSize(current, viewport)) bar.readFor = viewport;
      else readBarAgain(page, bar, viewport);
    }
  }
  const read = (await within(bar.read, BAR_READ_MS)) ?? bar.found;
  if (!read || read.bottom <= 0) return [];
  return [{ x: 0, y: 0, width: frame.width, height: read.bottom }];
}

/** The pause bar `page` shows now, drawn or being drawn, as one draw of it: null while it shows none. */
export function pauseBarUp(page: Page): { drawn: Promise<unknown> } | null {
  const bar = PAUSE_BARS.get(page);
  return bar && bar.goneAt === null ? bar : null;
}

/** A frame as the page painted it, the viewport it shows, in CSS pixels, and when the page showed it, at the earliest. */
export interface PageFrame {
  data: Buffer;
  width: number;
  height: number;
  /**
   * A screenshot's start, or a screencast frame's time as Playwright names it (no later than its arrival) less
   * `SCREENCAST_LAG_MS`; `-Infinity` for a frame that names none (before Playwright 1.61), which may show the page from
   * before any read.
   */
  at: number;
}

export interface PageViewOptions {
  /** The frame size the view asks of the page's screencast, from its viewport in CSS pixels. */
  size(viewport: { width: number; height: number }): { width: number; height: number };
  /** The JPEG quality the view asks of the page's screencast, and of the images it takes in its place. */
  quality: number;
  /** The most frames the view sends a second. */
  fps: number;
  /** The least time after a frame went before the next one goes, when longer than a frame's interval. */
  spacing?(frame: PageFrame): number;
  /** The longest frame sent, in bytes of JPEG. */
  maxFrameBytes: number;
  /** The JPEG quality of the lighter image taken in place of a frame too long to send. */
  lightQuality: number;
  /** How often the view takes an image of the page where it cannot use the screencast, and a lighter one at most. */
  shotMs: number;
  /** Whether the way out is backed up: the latest frame alone waits. */
  busy(): boolean;
  /** Whether the view's frames still go: none goes once it says no (its stop began to end, its test ended). */
  live(): boolean;
  /**
   * What a frame becomes before it goes, one frame at a time: the frame to send, null to send none, or why none goes,
   * for the viewers. The image it sends has the boxes `also` names for it (the pause bar's band) painted over too, in
   * the same pass as its own, where there is `jpeg-js`: `also` is asked once, right before that paint, with an image
   * that names its viewport in CSS pixels.
   */
  screen(frame: PageFrame, also: (image: PageFrame) => Promise<FrameBox[]>): Promise<PageFrame | string | null>;
  send(frame: PageFrame): void;
  /** Why no image goes: `why`, or each image of the page is too long to send, the lighter one included. */
  refuse(why?: string): void;
}

export interface PageView {
  /** Whether the view is the page's screencast, not images of it taken on a timer. */
  screencast: boolean;
  /** Send the latest frame sent again, or why none goes, for a viewer that came since. */
  resend(): void;
  /** Forget the latest frame sent, which went through `screen` as it was, and send an image of the page taken now. */
  refresh(): void;
  /**
   * The bottom edge of the pause bar's band, in the pixels the latest frame sent names its viewport in, while the bar
   * shows and the view paints it over; null otherwise.
   */
  barBand(): Promise<number | null>;
  close(): Promise<void>;
}

/** The page's viewport in CSS pixels; null when it cannot be read. */
export async function viewportOf(page: Page): Promise<{ width: number; height: number } | null> {
  const size = page.viewportSize();
  if (size) return size;
  type Window = { innerWidth: number; innerHeight: number };
  const read = await internalCall(page, () =>
    page.evaluate(() => {
      const { innerWidth, innerHeight } = globalThis as unknown as Window;
      return { width: innerWidth, height: innerHeight };
    }),
  ).catch(() => null);
  return read && isViewSize(read.width, read.height) ? read : null;
}

/** Open a live view of `page`, as `options` say; null when its viewport cannot be read. */
export async function openPageView(page: Page, options: PageViewOptions): Promise<PageView | null> {
  /** When the view began: a pause bar read before it is read again for its frames. */
  const since = Date.now();
  const viewport = await viewportOf(page);
  if (!viewport) return null;
  let closed = false;
  let last: Buffer | null = null;
  /** The latest frame sent, or why no frame goes: kept for a viewer that comes later, in memory, until the end. */
  let sent: PageFrame | { refused: string | undefined } | null = null;
  /** Whether the viewers heard that no frame goes, since the last frame that went. */
  let refused = false;
  /** Whether a frame is in `screen`, and its end. */
  let screening = false;
  let screened: Promise<void> | null = null;
  /**
   * How long the paint of the frame sent last took, when the pause bar was painted over in it (decoding, painting and
   * encoding again, not the reads before): the next frame waits as long again past it.
   */
  let paintMs = 0;
  const interval = 1000 / options.fps;
  const deliver = (frame: PageFrame): void => {
    if (closed || !options.live()) return;
    refused = false;
    sent = frame;
    options.send(frame);
  };
  const refuse = (why?: string): void => {
    if (closed || refused || !options.live()) return;
    refused = true;
    sent = { refused: why };
    options.refuse(why);
  };
  /** The frame that goes for `frame`, through `screen`, the pause bar painted over where it may show. */
  const show = async (frame: PageFrame): Promise<void> => {
    let bar: FrameBox[] = [];
    /** When `screen` had the bar's boxes, which it asks right before its paint. */
    let painting = 0;
    const shown = await options.screen(frame, async (image) => {
      bar = await pauseBarBoxes(page, image, since);
      painting = Date.now();
      return bar;
    });
    paintMs = bar.length && painting && jpegCodec() ? Date.now() - painting : 0;
    if (typeof shown === 'string') return refuse(shown);
    if (shown) deliver(shown);
  };
  const pacer = new LatestPacer<PageFrame>({
    intervalMs: interval,
    spacing: (frame) => Math.max(options.spacing?.(frame) ?? 0, 2 * paintMs),
    busy: () => screening || options.busy(),
    send: (frame) => {
      if (!options.live()) return;
      screening = true;
      screened = show(frame)
        .catch(() => undefined)
        .finally(() => {
          screening = false;
          screened = null;
        });
    },
  });
  /**
   * The viewport an image of the page shows, named as the screencast names it: the page's own viewport, else the
   * image's size at CSS scale (a page without one, whose viewport Playwright names in no other pixels).
   */
  const shownSize = (shot: Buffer): Size => page.viewportSize() ?? jpegSize(shot) ?? viewport;
  /** The lighter image on its way, and when the last one was asked. */
  let lighter: Promise<void> | null = null;
  let lighterAt = -Infinity;
  /** A frame too long to send: a lower quality image of the page goes in its place, or the viewers hear why not. */
  const lighten = (): void => {
    const now = Date.now();
    if (lighter || now - lighterAt < options.shotMs) return;
    lighterAt = now;
    lighter = internalCall(page, () =>
      page.screenshot({ type: 'jpeg', quality: options.lightQuality, scale: 'css', caret: 'initial', timeout: 5000 }),
    )
      .then(
        (shot) => {
          if (closed) return;
          if (shot.length <= options.maxFrameBytes) return pacer.offer({ data: shot, ...shownSize(shot), at: now });
          refuse();
        },
        () => undefined,
      )
      .finally(() => {
        lighter = null;
      });
  };
  const onFrame = (data: Buffer, width: number, height: number, at: number): void => {
    if (closed || last?.equals(data)) return;
    last = data;
    if (data.length > options.maxFrameBytes) return lighten();
    const named = isViewSize(width, height);
    pacer.offer({ data, width: named ? width : viewport.width, height: named ? height : viewport.height, at });
  };
  const screencast = screencastOf(page);
  let end: (() => Promise<unknown>) | null = null;
  let shots: ReturnType<typeof setTimeout> | null = null;
  let shooting = false;
  const shoot = async (): Promise<void> => {
    shots = null;
    if (closed || page.isClosed()) return;
    const at = Date.now();
    const shot = await internalCall(page, () =>
      page.screenshot({ type: 'jpeg', quality: options.quality, scale: 'css', caret: 'initial', timeout: 5000 }),
    ).catch(() => null);
    if (shot) {
      const size = shownSize(shot);
      onFrame(shot, size.width, size.height, at);
    }
    if (!closed) {
      shots = setTimeout(() => void shoot(), options.shotMs);
      shots.unref?.();
    }
  };
  /** Images of the page on a timer, in place of its screencast, from now on. */
  const takeShots = (): void => {
    if (shooting || closed) return;
    shooting = true;
    void shoot();
  };
  /** The view's acknowledgments: one frame each interval waits for its own, the others none. */
  const acks = new FrameAcks(interval);
  const holders = HOLDERS.get(page) ?? new Set<Holder>();
  HOLDERS.set(page, holders);
  let starting: Promise<Started> | null = null;
  const holder: Holder = {
    release: async () => {
      holders.delete(holder);
      await starting?.catch(() => undefined);
      const stop = end;
      end = null;
      if (stop && !page.isClosed()) await stop().catch(() => undefined);
      takeShots();
    },
  };
  if (typeof screencast?.start === 'function' && !TEST_SCREENCASTS.has(page)) {
    holders.add(holder);
    starting = internalCall(page, () =>
      screencast.start!({
        size: options.size(viewport),
        quality: options.quality,
        onFrame: (frame) => {
          const now = Date.now();
          // A frame that names no paint time (before Playwright 1.61) is dated before any read.
          const at =
            typeof frame.timestamp === 'number' && Number.isFinite(frame.timestamp)
              ? Math.min(frame.timestamp, now) - SCREENCAST_LAG_MS
              : Number.NEGATIVE_INFINITY;
          onFrame(frame.data, frame.viewportWidth, frame.viewportHeight, at);
          return acks.next();
        },
      }),
    );
    try {
      const started = await starting;
      // Its own client alone: the client a test's video records through stays.
      end = () =>
        internalCall(page, async () => {
          if (typeof started?.dispose === 'function') await started.dispose();
          else await screencast.stop?.();
        });
    } catch {
      holders.delete(holder);
      takeShots();
    }
  } else {
    takeShots();
  }
  return {
    get screencast() {
      return end !== null;
    },
    resend: () => {
      if (closed || !sent || !options.live()) return;
      if ('refused' in sent) options.refuse(sent.refused);
      else options.send(sent);
    },
    barBand: async () => {
      const bar = PAUSE_BARS.get(page);
      if (closed || !bar || bar.goneAt !== null || !jpegCodec()) return null;
      const seen = sent && !('refused' in sent) ? sent : { data: Buffer.alloc(0), ...viewport };
      const [box] = await pauseBarBoxes(page, { ...seen, at: Date.now() }, since);
      return box ? box.height : null;
    },
    refresh: () => {
      if (closed) return;
      sent = null;
      last = null;
      const at = Date.now();
      void internalCall(page, () =>
        page.screenshot({ type: 'jpeg', quality: options.quality, scale: 'css', caret: 'initial', timeout: 5000 }),
      ).then(
        (shot) => {
          const size = shownSize(shot);
          onFrame(shot, size.width, size.height, at);
        },
        () => undefined,
      );
    },
    close: async () => {
      closed = true;
      sent = null;
      acks.close();
      pacer.close();
      if (shots) clearTimeout(shots);
      holders.delete(holder);
      // A lighter image, and a frame in `screen`, on their way are the view's last calls to the page.
      await Promise.all([lighter, screened]);
      const stop = end;
      end = null;
      if (stop && !page.isClosed()) await stop().catch(() => undefined);
    },
  };
}
