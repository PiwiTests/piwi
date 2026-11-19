import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, expect } from 'vitest';
import {
  MAX_TRACE_FRAMES,
  buildTraceFrames,
  traceFrameSource,
  traceImageContentType,
} from '../../server/utils/trace-insights';
import { parseTraceTexts } from '../../server/utils/trace-events';
import { parseZipSync } from '../utils/zip';

const lines = (events: object[]) => events.map((e) => JSON.stringify(e)).join('\n');

/** The browser context's header: its trace clock reads 500 at epoch 1_700_000_000_000. */
const libraryContext = { type: 'context-options', origin: 'library', wallTime: 1_700_000_000_000, monotonicTime: 500 };

describe('parseTraceTexts — screencast frames', () => {
  test('reads the 1.63 `file` and the earlier `sha1` shape, and skips a frame without an image, a page or a time', () => {
    const parsed = parseTraceTexts([
      lines([
        {
          type: 'screencast-frame',
          pageId: 'page@1',
          file: 'screencast/page@1-10.jpeg',
          width: 1280,
          height: 720,
          timestamp: 600,
        },
        { type: 'screencast-frame', pageId: 'page@1', sha1: 'page@1-20.jpeg', width: 640, height: 480, timestamp: 700 },
        { type: 'screencast-frame', pageId: 'page@1', timestamp: 800 },
        { type: 'screencast-frame', file: 'screencast/x.jpeg', timestamp: 800 },
        { type: 'screencast-frame', pageId: 'page@1', file: 'screencast/y.jpeg' },
      ]),
    ]);
    expect(parsed.screencastFrames).toEqual([
      { pageId: 'page@1', file: 'screencast/page@1-10.jpeg', width: 1280, height: 720, timestamp: 600 },
      { pageId: 'page@1', file: 'resources/page@1-20.jpeg', width: 640, height: 480, timestamp: 700 },
    ]);
  });
});

describe('buildTraceFrames', () => {
  test('places each frame on the wall clock of the browser context, page by page', () => {
    const parsed = parseTraceTexts([
      lines([
        { type: 'context-options', origin: 'testRunner', wallTime: 1_600_000_000_000, monotonicTime: 0 },
        libraryContext,
        {
          type: 'screencast-frame',
          pageId: 'page@2',
          file: 'screencast/b-1.jpeg',
          width: 800,
          height: 600,
          timestamp: 900,
        },
        {
          type: 'screencast-frame',
          pageId: 'page@1',
          file: 'screencast/a-2.jpeg',
          width: 1280,
          height: 720,
          timestamp: 750,
        },
        {
          type: 'screencast-frame',
          pageId: 'page@1',
          file: 'screencast/a-1.jpeg',
          width: 1280,
          height: 720,
          timestamp: 600,
        },
      ]),
    ]);

    expect(buildTraceFrames(parsed)).toEqual({
      status: 'ok',
      total: 3,
      capped: false,
      // The test runner's header says when the test started.
      startEpochMs: 1_600_000_000_000,
      pages: [
        {
          pageId: 'page@1',
          frames: [
            { epochMs: 1_700_000_000_100, name: 'screencast/a-1.jpeg', width: 1280, height: 720 },
            { epochMs: 1_700_000_000_250, name: 'screencast/a-2.jpeg', width: 1280, height: 720 },
          ],
        },
        {
          pageId: 'page@2',
          frames: [{ epochMs: 1_700_000_000_400, name: 'screencast/b-1.jpeg', width: 800, height: 600 }],
        },
      ],
    });
  });

  test('says when there is no trace, no frame, or no clock to place them on', () => {
    expect(buildTraceFrames(null)).toEqual({
      status: 'no-trace',
      pages: [],
      total: 0,
      capped: false,
      startEpochMs: null,
    });
    expect(buildTraceFrames(parseTraceTexts([lines([libraryContext])])).status).toBe('no-frames');

    const unanchored = buildTraceFrames(
      parseTraceTexts([lines([{ type: 'screencast-frame', pageId: 'p', file: 'screencast/f.jpeg', timestamp: 1 }])]),
    );
    expect(unanchored).toEqual({ status: 'no-frames', pages: [], total: 1, capped: false, startEpochMs: null });
  });

  test('past the cap, lists an even sample of each page with its last frame', () => {
    const count = MAX_TRACE_FRAMES * 2 + 1;
    const frames = Array.from({ length: count }, (_, i) => ({
      type: 'screencast-frame',
      pageId: 'page@1',
      file: `screencast/f-${i}.jpeg`,
      timestamp: 500 + i,
    }));
    const result = buildTraceFrames(parseTraceTexts([lines([libraryContext, ...frames])]));

    expect(result.total).toBe(count);
    expect(result.capped).toBe(true);
    const names = result.pages[0]!.frames.map((f) => f.name);
    expect(names.length).toBeLessThanOrEqual(MAX_TRACE_FRAMES + 1);
    expect(names[0]).toBe('screencast/f-0.jpeg');
    expect(names[1]).toBe('screencast/f-3.jpeg');
    expect(names.at(-1)).toBe(`screencast/f-${count - 1}.jpeg`);
  });
});

describe('traceFrameSource', () => {
  const parsed = parseTraceTexts([
    lines([
      { type: 'screencast-frame', pageId: 'p', file: 'screencast/p-1.jpeg', timestamp: 1 },
      { type: 'screencast-frame', pageId: 'p', sha1: 'p-2.jpeg', timestamp: 2 },
      { type: 'screencast-frame', pageId: 'p', file: 'aria/c1-before.json', timestamp: 3 },
    ]),
  ]);

  test('reads a 1.63 frame from its entry and an earlier one from its resource', () => {
    expect(traceFrameSource(parsed, 'screencast/p-1.jpeg')).toEqual({ kind: 'entry', name: 'screencast/p-1.jpeg' });
    expect(traceFrameSource(parsed, 'resources/p-2.jpeg')).toEqual({ kind: 'resource', name: 'p-2.jpeg' });
  });

  test('reaches no entry the frames do not name, nor one outside the two frame folders', () => {
    expect(traceFrameSource(parsed, 'screencast/p-9.jpeg')).toBeNull();
    expect(traceFrameSource(parsed, 'resources/src@abc.txt')).toBeNull();
    expect(traceFrameSource(parsed, 'aria/c1-before.json')).toBeNull();
    expect(traceFrameSource(null, 'screencast/p-1.jpeg')).toBeNull();
  });
});

describe('traceImageContentType', () => {
  test('names a JPEG, a PNG and a WebP by their first bytes, and nothing else', () => {
    expect(traceImageContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(traceImageContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'image/png',
    );
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(traceImageContentType(webp)).toBe('image/webp');
    expect(traceImageContentType(new TextEncoder().encode('<html>'))).toBeNull();
    expect(traceImageContentType(new Uint8Array())).toBeNull();
  });
});

describe('committed demo trace', () => {
  const entries = parseZipSync(readFileSync(join(__dirname, '../../public/demo/traces/checkout-pay-timeout.zip')));
  const parsed = parseTraceTexts(entries.filter((e) => e.name.endsWith('.trace')).map((e) => e.data.toString('utf8')));

  test('lists its screencast on the wall clock Playwright names each frame by', () => {
    const result = buildTraceFrames(parsed);
    expect(result.status).toBe('ok');
    // A trace without a test runner's header started when its browser context opened.
    expect(result.startEpochMs).toBe(parsed.contexts[0]!.wallTime);
    expect(result.pages).toHaveLength(1);
    const frames = result.pages[0]!.frames;
    expect(frames).toHaveLength(9);
    for (const frame of frames) {
      // `page@<id>-<epoch ms>.jpeg`: the clock the frame list reads, give or take the context's rounding.
      const named = Number(/-(\d+)\.jpeg$/.exec(frame.name)![1]);
      expect(Math.abs(frame.epochMs - named)).toBeLessThanOrEqual(1);
      expect(frame).toMatchObject({ width: 640, height: 480 });
      expect(entries.some((e) => e.name === frame.name)).toBe(true);
    }
  });
});
