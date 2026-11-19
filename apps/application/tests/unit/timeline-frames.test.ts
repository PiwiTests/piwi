import { describe, test, expect } from 'vitest';
import {
  RECORDED_APART_MS,
  frameAspect,
  frameIndexAt,
  frameTiles,
  placeTraceFrames,
  type PlacedFrame,
} from '../../app/utils/timeline-frames';
import type { TraceFramesResponse } from '../../types/api';

const ORIGIN = 1_800_000_000_000;

function response(startEpochMs: number | null, epochs: number[]): TraceFramesResponse {
  return {
    status: 'ok',
    total: epochs.length,
    capped: false,
    startEpochMs,
    pages: [
      {
        pageId: 'page@1',
        frames: epochs.map((epochMs, i) => ({ epochMs, name: `screencast/f-${i}.jpeg`, width: 1280, height: 720 })),
      },
    ],
  };
}

const frames = (...ats: number[]): PlacedFrame[] => ats.map((at, i) => ({ at, name: `f-${i}`, width: 0, height: 0 }));

describe('placeTraceFrames', () => {
  test('keeps the wall clock for a trace recorded with its execution', () => {
    const placed = placeTraceFrames(response(ORIGIN + 150, [ORIGIN + 400, ORIGIN + 900]), {
      origin: ORIGIN,
      testStart: 100,
    });
    expect(placed[0]!.frames.map((f) => f.at)).toEqual([400, 900]);
  });

  test("places a trace recorded at another time by its test start, on the execution's", () => {
    const recorded = ORIGIN - 90 * 24 * 3_600_000;
    const placed = placeTraceFrames(response(recorded, [recorded + 168, recorded + 2_456]), {
      origin: ORIGIN,
      testStart: 40,
    });
    expect(placed[0]!.frames.map((f) => f.at)).toEqual([208, 2_496]);
  });

  test('takes a start within the margin as recorded together', () => {
    const start = ORIGIN + RECORDED_APART_MS;
    const placed = placeTraceFrames(response(start, [start + 10]), { origin: ORIGIN, testStart: 0 });
    expect(placed[0]!.frames[0]!.at).toBe(RECORDED_APART_MS + 10);
  });

  test('places nothing without frames', () => {
    expect(placeTraceFrames(null, { origin: ORIGIN, testStart: 0 })).toEqual([]);
    expect(
      placeTraceFrames(
        { status: 'no-frames', pages: [], total: 0, capped: false, startEpochMs: null },
        { origin: ORIGIN, testStart: 0 },
      ),
    ).toEqual([]);
  });
});

describe('frameIndexAt', () => {
  const list = frames(100, 200, 200, 500);

  test('names the last frame painted by then', () => {
    expect(frameIndexAt(list, 99)).toBe(-1);
    expect(frameIndexAt(list, 100)).toBe(0);
    expect(frameIndexAt(list, 250)).toBe(2);
    expect(frameIndexAt(list, 10_000)).toBe(3);
    expect(frameIndexAt([], 10)).toBe(-1);
  });
});

describe('frameTiles', () => {
  test("shows each tile's frame at its middle, none before the first", () => {
    expect(frameTiles(frames(100, 300), { start: 0, end: 400 }, 4)).toEqual([-1, 0, 0, 1]);
    expect(frameTiles(frames(100), { start: 0, end: 400 }, 0)).toEqual([]);
  });
});

describe('frameAspect', () => {
  test('reads the first sized frame, held to a sane ratio', () => {
    expect(frameAspect([{ pageId: 'p', frames: [{ at: 0, name: 'a', width: 1280, height: 720 }] }])).toBeCloseTo(
      16 / 9,
    );
    expect(frameAspect([{ pageId: 'p', frames: frames(0) }])).toBeCloseTo(4 / 3);
    expect(frameAspect([{ pageId: 'p', frames: [{ at: 0, name: 'a', width: 4000, height: 10 }] }])).toBe(3);
  });
});
