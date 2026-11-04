import { describe, expect, test } from 'vitest';
import { diagnosisImageOrder, inTurns } from '../../app/utils/diagnosis-screenshots';

/** A test's attachments in attachment order: ten step screenshots, then Playwright's at the failure. */
const steps = Array.from({ length: 10 }, (_, i) => ({ name: `Step ${i + 1}: Open alerts` }));
const withPlaywrightShot = [...steps, { name: 'screenshot' }];
const name = (image: { name: string }) => image.name;

describe('diagnosisImageOrder', () => {
  test('puts the newest first, so the screenshot Playwright took at the failure leads', () => {
    const ordered = diagnosisImageOrder(withPlaywrightShot, name);
    expect(ordered.slice(0, 3).map(name)).toEqual(['screenshot', 'Step 10: Open alerts', 'Step 9: Open alerts']);
  });

  test("puts the capture fixtures' screenshot of the failing page first", () => {
    const ordered = diagnosisImageOrder(
      [...steps.slice(0, 3), { name: 'piwi-failure-screenshot' }, ...steps.slice(3)],
      name,
      true,
    );
    expect(ordered[0]).toEqual({ name: 'piwi-failure-screenshot' });
    expect(ordered[1]).toEqual({ name: 'Step 10: Open alerts' });
  });
});

describe('inTurns', () => {
  test("takes each list's first before any list's second", () => {
    expect(inTurns([['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']])).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  });

  test('keeps every item, so a test with many screenshots leaves the first slots to the others', () => {
    const many = Array.from({ length: 11 }, (_, i) => `a${i + 1}`);
    expect(inTurns([many, ['b1', 'b2']]).slice(0, 4)).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(inTurns([many, ['b1', 'b2']])).toHaveLength(13);
    expect(inTurns([])).toEqual([]);
  });
});
