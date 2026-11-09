import { describe, expect, test } from 'vitest';
import type { LocalRunLine } from '../../app/composables/useDesktopLocalRuns';
import { mergeRunOutputLines, runOutputWindowName, type RunOutputState } from '../../app/utils/run-output-channel';

const line = (id: number): LocalRunLine => ({ id, text: `line ${id}`, error: false });
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
const state = (sent: LocalRunLine[]): RunOutputState => ({
  type: 'state',
  name: 'piwi-run-output-1',
  title: 'checkout completes',
  status: { label: 'Running 0/1…', color: 'info' },
  detail: 'acme · playwright test',
  startedAt: 0,
  finishedAt: null,
  running: true,
  stopRequested: false,
  lines: sent,
});

describe('mergeRunOutputLines', () => {
  test('adds the lines that follow on to those the window has', () => {
    expect(mergeRunOutputLines(lines(1, 3), state(lines(4, 5)), 10).map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
  });

  test('takes the lines in place of its own when they do not follow on', () => {
    expect(mergeRunOutputLines(lines(1, 3), state(lines(1, 4)), 10).map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(mergeRunOutputLines(lines(1, 3), state(lines(8, 9)), 10).map((l) => l.id)).toEqual([8, 9]);
    expect(mergeRunOutputLines([], state(lines(1, 2)), 10).map((l) => l.id)).toEqual([1, 2]);
  });

  test('keeps its lines when the state carries none, and only the last `max`', () => {
    expect(mergeRunOutputLines(lines(1, 3), state([]), 10).map((l) => l.id)).toEqual([1, 2, 3]);
    expect(mergeRunOutputLines(lines(1, 3), state(lines(4, 6)), 4).map((l) => l.id)).toEqual([3, 4, 5, 6]);
  });
});

test('an output window name is one the shell takes', () => {
  expect(runOutputWindowName(12)).toMatch(/^[a-z0-9-]{1,64}$/);
});
