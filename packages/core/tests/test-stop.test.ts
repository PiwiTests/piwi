import { describe, expect, test } from 'vitest';
import { MAX_TEST_STOP_TITLE, parsePausedMs, parseTestStop, type TestStop } from '../src/wire';

const STOP = {
  reason: 'breakpoint',
  title: "Click getByRole('button', { name: 'Pay' })",
  file: 'tests/checkout.spec.ts',
  line: 12,
  bar: true,
  since: 1_762_400_000_000,
  pausedMs: 4200,
} satisfies TestStop;

describe('a stop as text', () => {
  test('reads field by field', () => {
    expect(parseTestStop(STOP)).toEqual(STOP);
    expect(parseTestStop({ ...STOP, reason: 'teleport' })).toMatchObject({ reason: 'other' });
    expect(parseTestStop({ ...STOP, title: 'x'.repeat(MAX_TEST_STOP_TITLE + 5) })?.title).toHaveLength(
      MAX_TEST_STOP_TITLE,
    );
    expect(parseTestStop({ ...STOP, file: '', line: 3 })).toMatchObject({ file: null, line: null });
    expect(parseTestStop({ ...STOP, line: 0 })).toMatchObject({ file: STOP.file, line: null });
  });

  test('refuses what does not read', () => {
    for (const wrong of [
      null,
      [],
      'stop',
      { ...STOP, reason: 1 },
      { ...STOP, title: null },
      { ...STOP, bar: 'yes' },
      { ...STOP, since: 0 },
      { ...STOP, since: 1.5 },
      { ...STOP, pausedMs: -1 },
      { ...STOP, pausedMs: 40_000_000_000 },
    ]) {
      expect(parseTestStop(wrong), JSON.stringify(wrong)).toBeNull();
    }
    expect(parsePausedMs(1500)).toBe(1500);
    expect(parsePausedMs('1500')).toBeNull();
  });
});
