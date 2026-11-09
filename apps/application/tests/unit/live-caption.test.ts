import { describe, expect, test } from 'vitest';
import { stepAfterFrame } from '~/utils/live-caption';

/** Which step the live view's caption names over its image's call. */

const step = { title: 'Click', subtitle: "getByRole('button')", parentTitle: 'pays', startedAt: 2000 };

describe('the live view caption', () => {
  test('names the step the test began after the image, while it is of the test the view shows', () => {
    expect(stepAfterFrame(step, 1500, 'pays')).toBe(step);
    expect(stepAfterFrame({ ...step, parentTitle: null }, 1500, 'pays')).toEqual({ ...step, parentTitle: null });
  });

  test('keeps the image’s call for a step begun before it, of another test, or without a time on either side', () => {
    expect(stepAfterFrame(step, 2000, 'pays')).toBeNull();
    expect(stepAfterFrame(step, 2500, 'pays')).toBeNull();
    expect(stepAfterFrame(step, 1500, 'refunds')).toBeNull();
    expect(stepAfterFrame(step, 0, 'pays')).toBeNull();
    expect(stepAfterFrame({ ...step, startedAt: null }, 1500, 'pays')).toBeNull();
    expect(stepAfterFrame(null, 1500, 'pays')).toBeNull();
  });
});
