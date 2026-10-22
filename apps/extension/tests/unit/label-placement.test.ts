import { describe, it, expect } from 'vitest';
import { placeLabels, type LabelBox } from '../../src/content/label-layout.js';

const VIEWPORT = { width: 800, height: 600 };

function anchor(left: number, top: number, width = 20, height = 20): LabelBox {
  return { left, top, width, height };
}

function apart(a: LabelBox, b: LabelBox): boolean {
  return (
    a.left >= b.left + b.width || b.left >= a.left + a.width || a.top >= b.top + b.height || b.top >= a.top + a.height
  );
}

describe('placeLabels', () => {
  it('puts a label above its element, or on it when there is no room above', () => {
    expect(placeLabels([{ anchor: anchor(30, 100), width: 90, height: 15 }], VIEWPORT)).toEqual([
      { left: 30, top: 85 },
    ]);
    expect(placeLabels([{ anchor: anchor(30, 4), width: 90, height: 15 }], VIEWPORT)).toEqual([{ left: 30, top: 4 }]);
  });

  it('keeps a label inside the viewport', () => {
    expect(placeLabels([{ anchor: anchor(780, 100), width: 90, height: 15 }], VIEWPORT)).toEqual([
      { left: 710, top: 85 },
    ]);
  });

  it('shifts the labels of a row of adjacent elements below then above, the first keeping its place', () => {
    const labels = [0, 1, 2, 3, 4].map((i) => ({ anchor: anchor(100 + i * 22, 200), width: 90, height: 15 }));
    const places = placeLabels(labels, VIEWPORT);
    expect(places.map((p) => p?.top)).toEqual([185, 201, 169, 217, 153]);
    const boxes = places.map((p) => ({ ...p!, width: 90, height: 15 }));
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(apart(a, b)).toBe(true);
  });

  it('leaves out a label with no free place within its rows', () => {
    const labels = Array.from({ length: 20 }, () => ({ anchor: anchor(100, 300), width: 90, height: 15 }));
    const places = placeLabels(labels, VIEWPORT);
    // The place above the element, then six rows below and six above.
    expect(places.filter(Boolean)).toHaveLength(13);
    expect(places.slice(13)).toEqual(Array(7).fill(null));
  });
});
