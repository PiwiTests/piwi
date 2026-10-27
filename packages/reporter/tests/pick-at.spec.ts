import { describe, expect, it } from 'vitest';
import { boxesAt, snapshotBoxes } from '../src/internal/capture/pick-at.js';

/** A page's ARIA snapshot in AI mode with its boxes, as Playwright 1.64 writes it, a page scrolled and an iframe in it. */
const SNAPSHOT = `- generic [active] [ref=e1] [box=8,-1057,784,1649]:
  - heading "Sign in" [level=1] [ref=e2] [box=8,-1057,784,37]
  - generic [ref=e3] [box=8,81,227,17]:
    - text: Email
    - textbox "Email" [ref=e4] [box=50,80,185,21]: dev@example.com [ref=e9] [box=0,0,9999,9999]
  - button "Continue \\"now\\" [ref=e8] [box=0,0,1,1]" [ref=e5] [box=239,80,69,21]
  - link "Home" [ref=e6] [box=10,120,0,0]:
    - /url: /home
  - iframe [ref=e7] [box=48,522,204,64]:
    - button "Inner" [ref=f1e2] [box=8,8,46,21]`;

describe('pick on the image', () => {
  it('reads the main frame’s elements and their boxes, whatever a name or a value says', () => {
    expect(snapshotBoxes(SNAPSHOT)).toEqual([
      { ref: 'e1', role: 'generic', x: 8, y: -1057, width: 784, height: 1649, depth: 0, ancestors: [] },
      { ref: 'e2', role: 'heading', x: 8, y: -1057, width: 784, height: 37, depth: 1, ancestors: ['e1'] },
      { ref: 'e3', role: 'generic', x: 8, y: 81, width: 227, height: 17, depth: 1, ancestors: ['e1'] },
      // The value after the colon names no box of its own.
      { ref: 'e4', role: 'textbox', x: 50, y: 80, width: 185, height: 21, depth: 2, ancestors: ['e1', 'e3'] },
      // A name that looks like a ref and a box is a name.
      { ref: 'e5', role: 'button', x: 239, y: 80, width: 69, height: 21, depth: 1, ancestors: ['e1'] },
      // An element with no size is left out, and so is one in an iframe, whose box is its frame's.
      { ref: 'e7', role: 'iframe', x: 48, y: 522, width: 204, height: 64, depth: 1, ancestors: ['e1'] },
    ]);
    expect(snapshotBoxes('- button "Go" [ref=e1]')).toEqual([]);
    expect(snapshotBoxes('')).toEqual([]);
  });

  it('finds the elements under a point, the innermost first, then the smallest and the deepest', () => {
    const boxes = snapshotBoxes(SNAPSHOT);
    expect(boxesAt(boxes, 273.9, 90.4).map((b) => b.ref)).toEqual(['e5', 'e1']);
    // The field overflows its label's smaller box: the field is under the point.
    expect(boxesAt(boxes, 60, 90).map((b) => b.ref)).toEqual(['e4', 'e3', 'e1']);
    expect(boxesAt(boxes, 100, 540).map((b) => b.ref)).toEqual(['e7', 'e1']);
    // A box holds its left and top edges, not its right and bottom ones.
    expect(boxesAt(boxes, 308, 90).map((b) => b.ref)).toEqual(['e1']);
    expect(boxesAt(boxes, 239, 80).map((b) => b.ref)).toEqual(['e5', 'e1']);
    expect(boxesAt(boxes, 900, 900)).toEqual([]);
    const twins = snapshotBoxes(`- generic [ref=e1] [box=0,0,10,10]:
  - generic [ref=e2] [box=0,0,10,10]`);
    expect(boxesAt(twins, 5, 5).map((b) => b.ref)).toEqual(['e2', 'e1']);
    // Two elements that overlap, neither in the other: the smaller.
    const siblings = snapshotBoxes(`- generic [ref=e1] [box=0,0,100,100]:
  - dialog [ref=e2] [box=0,0,50,50]
  - button "Go" [ref=e3] [box=10,10,20,20]`);
    expect(boxesAt(siblings, 15, 15).map((b) => b.ref)).toEqual(['e3', 'e2', 'e1']);
  });
});
