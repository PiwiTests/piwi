import { describe, it, expect } from 'vitest';
import { cornerInset, nextCorner } from '../../src/content/hud-corner.js';

describe('the recording bar’s corner', () => {
  it('moves round the viewport, back where it started after four moves', () => {
    expect(nextCorner('bottom-right')).toBe('bottom-left');
    expect(nextCorner('bottom-left')).toBe('top-left');
    expect(nextCorner('top-left')).toBe('top-right');
    expect(nextCorner('top-right')).toBe('bottom-right');
  });

  it('sits 16 pixels from the two edges of its corner', () => {
    expect(cornerInset('bottom-right')).toBe('auto 16px 16px auto');
    expect(cornerInset('bottom-left')).toBe('auto auto 16px 16px');
    expect(cornerInset('top-left')).toBe('16px auto auto 16px');
    expect(cornerInset('top-right')).toBe('16px 16px auto auto');
  });
});
