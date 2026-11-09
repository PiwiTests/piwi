import { describe, expect, it } from 'vitest';
import { sameShape } from '../src/internal/capture/run-channel.js';

describe('the image of a stopped page', () => {
  it('goes when it has its viewport’s shape, at whatever size', () => {
    expect(sameShape({ width: 1000, height: 640 }, { width: 1000, height: 640 })).toBe(true);
    expect(sameShape({ width: 2000, height: 1280 }, { width: 1000, height: 640 })).toBe(true);
    // A pixel a rounding takes.
    expect(sameShape({ width: 1001, height: 640 }, { width: 1000, height: 640 })).toBe(true);
  });

  it('goes nowhere when its shape is not its viewport’s, or it has no height', () => {
    // Two by two copies of a quarter of the page, or a window's frame around it.
    expect(sameShape({ width: 1000, height: 1280 }, { width: 1000, height: 640 })).toBe(false);
    expect(sameShape({ width: 1280, height: 720 }, { width: 1000, height: 640 })).toBe(false);
    expect(sameShape({ width: 1000, height: 0 }, { width: 1000, height: 640 })).toBe(false);
  });
});
