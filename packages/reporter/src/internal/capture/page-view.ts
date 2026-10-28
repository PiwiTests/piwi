import type { Page } from '@playwright/test';
import { FrameAcks, LatestPacer, isViewSize } from '@piwitests/core/run-view';
import { internalCall } from './quiet-capture.js';

/**
 * A live view of a page for a viewer outside it: the page's screencast (`page.screencast.start`, an internal call),
 * its frames paced and capped as the view's options say, the same for the editor's view of a stopped page
 * (`run-channel.ts`) and the run page's view on the team instance (`live-view.ts`). The size and quality a view asks
 * for apply unless another client of the page's one screencast came first (a test's video, its trace's images), whose
 * size and quality every later client gets; the view's end stops its own client alone, so that one stays whole. Its
 * frames are acknowledged at the view's pace (`FrameAcks`), one held at a time. Where the screencast cannot start (the
 * test runs one itself), an image of the page every `shotMs`. A frame the same as the one before is dropped; one longer
 * than `maxFrameBytes` is too, an image of the page at `lightQuality` taken in its place, one at a time and `shotMs`
 * apart, and when that one is too long as well, the view says once why no frame goes (`refuse`), until a frame goes
 * again. Frames go at most `fps` a second (fewer when `spacing` holds a heavy one back), the latest one alone while
 * the way out is `busy`; the latest sent is kept in memory until the view ends, and sent again on `resend`, for a
 * viewer that came since (a still page paints no other). Nothing here stores a frame.
 */

/** A frame as the page painted it, and the viewport it shows, in CSS pixels. */
export interface PageFrame {
  data: Buffer;
  width: number;
  height: number;
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
  send(frame: PageFrame): void;
  /** Each image of the page is too long to send, the lighter one included. */
  refuse(): void;
}

export interface PageView {
  /** Whether the view is the page's screencast, not images of it taken on a timer. */
  screencast: boolean;
  /** Send the latest frame sent again, or why none goes, for a viewer that came since. */
  resend(): void;
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
  const viewport = await viewportOf(page);
  if (!viewport) return null;
  let closed = false;
  let last: Buffer | null = null;
  /** The latest frame sent, or that no frame goes: kept for a viewer that comes later, in memory, until the end. */
  let sent: PageFrame | 'refused' | null = null;
  /** Whether the viewers heard that no frame goes, since the last frame that went. */
  let refused = false;
  const interval = 1000 / options.fps;
  const pacer = new LatestPacer<PageFrame>({
    intervalMs: interval,
    ...(options.spacing ? { spacing: options.spacing } : {}),
    busy: options.busy,
    send: (frame) => {
      if (!options.live()) return;
      refused = false;
      sent = frame;
      options.send(frame);
    },
  });
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
          if (shot.length <= options.maxFrameBytes) return pacer.offer({ data: shot, ...viewport });
          if (refused || !options.live()) return;
          refused = true;
          sent = 'refused';
          options.refuse();
        },
        () => undefined,
      )
      .finally(() => {
        lighter = null;
      });
  };
  const onFrame = (data: Buffer, width: number, height: number): void => {
    if (closed || last?.equals(data)) return;
    last = data;
    if (data.length > options.maxFrameBytes) return lighten();
    const named = isViewSize(width, height);
    pacer.offer({ data, width: named ? width : viewport.width, height: named ? height : viewport.height });
  };
  type Started = { dispose?: () => Promise<unknown> } | undefined;
  type Screencast = {
    start?: (options: {
      size: { width: number; height: number };
      quality: number;
      onFrame: (frame: { data: Buffer; viewportWidth: number; viewportHeight: number }) => Promise<void> | void;
    }) => Promise<Started>;
    stop?: () => Promise<void>;
  };
  const screencast = (page as unknown as { screencast?: Screencast }).screencast;
  let end: (() => Promise<unknown>) | null = null;
  let shots: ReturnType<typeof setTimeout> | null = null;
  /** The view's acknowledgments: one frame each interval waits for its own, the others none. */
  const acks = new FrameAcks(interval);
  try {
    if (typeof screencast?.start !== 'function') throw new Error('This Playwright has no screencast.');
    const started = await internalCall(page, () =>
      screencast.start!({
        size: options.size(viewport),
        quality: options.quality,
        onFrame: (frame) => {
          onFrame(frame.data, frame.viewportWidth, frame.viewportHeight);
          return acks.next();
        },
      }),
    );
    // Its own client alone: the client a test's video records through stays.
    end = () =>
      internalCall(page, async () => {
        if (typeof started?.dispose === 'function') await started.dispose();
        else await screencast.stop?.();
      });
  } catch {
    const shoot = async (): Promise<void> => {
      shots = null;
      if (closed || page.isClosed()) return;
      const shot = await internalCall(page, () =>
        page.screenshot({ type: 'jpeg', quality: options.quality, scale: 'css', timeout: 5000 }),
      ).catch(() => null);
      if (shot) onFrame(shot, viewport.width, viewport.height);
      if (!closed) {
        shots = setTimeout(() => void shoot(), options.shotMs);
        shots.unref?.();
      }
    };
    void shoot();
  }
  return {
    screencast: end !== null,
    resend: () => {
      if (closed || !sent || !options.live()) return;
      if (sent === 'refused') options.refuse();
      else options.send(sent);
    },
    close: async () => {
      closed = true;
      sent = null;
      acks.close();
      pacer.close();
      if (shots) clearTimeout(shots);
      // A lighter image on its way is the view's last call to the page.
      await lighter;
      if (end && !page.isClosed()) await end().catch(() => undefined);
    },
  };
}
