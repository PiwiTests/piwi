import { describe, expect, test } from 'vitest';
import type { RunOutputLine } from '@piwitests/run-ui/run-output';
import {
  mergeRunOutputLines,
  outputWindowNameOf,
  runOutputWindowName,
  type RunOutputState,
} from '../../app/utils/run-output-channel';

const line = (id: number): RunOutputLine => ({ id, text: `line ${id}`, error: false });
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
const state = (sent: RunOutputLine[], key = 1): RunOutputState => ({
  type: 'state',
  name: 'piwi-run-output-1',
  key,
  title: 'checkout completes',
  status: { label: 'Running 0/1…', color: 'info' },
  detail: 'acme · playwright test',
  note: null,
  startedAt: 0,
  finishedAt: null,
  running: true,
  stopRequested: false,
  stopRequestedAt: null,
  refs: ['desktop-1'],
  hold: { on: false, refusal: null },
  rerunnable: false,
  piwiRunId: null,
  failed: false,
  sourceRunId: null,
  projectId: '1',
  projectLabel: 'acme',
  rows: [],
  rowsHold: false,
  lines: sent,
});

describe('mergeRunOutputLines', () => {
  test('adds the lines that follow on to those the window has', () => {
    expect(mergeRunOutputLines(lines(1, 3), 1, state(lines(4, 5)), 10).map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
  });

  test('takes the lines in place of its own when they do not follow on', () => {
    expect(mergeRunOutputLines(lines(1, 3), 1, state(lines(1, 4)), 10).map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(mergeRunOutputLines(lines(1, 3), 1, state(lines(8, 9)), 10).map((l) => l.id)).toEqual([8, 9]);
    expect(mergeRunOutputLines([], null, state(lines(1, 2)), 10).map((l) => l.id)).toEqual([1, 2]);
  });

  test('keeps its lines when the state carries none, and only the last `max`', () => {
    expect(mergeRunOutputLines(lines(1, 3), 1, state([]), 10).map((l) => l.id)).toEqual([1, 2, 3]);
    expect(mergeRunOutputLines(lines(1, 3), 1, state(lines(4, 6)), 4).map((l) => l.id)).toEqual([3, 4, 5, 6]);
  });

  test('drops the lines of the run it showed once the state is of another run, even with none of its own yet', () => {
    expect(mergeRunOutputLines(lines(1, 3), 1, state([], 2), 10)).toEqual([]);
    expect(mergeRunOutputLines(lines(1, 3), 1, state(lines(4, 5), 2), 10).map((l) => l.id)).toEqual([4, 5]);
  });
});

test('an output window name is one the shell takes', () => {
  expect(runOutputWindowName(12)).toMatch(/^[a-z0-9-]{1,64}$/);
});

test('an output window is known by its name from the label the shell gave it, whatever page opened it', () => {
  expect(outputWindowNameOf(`output-${runOutputWindowName(12)}_3`)).toBe(runOutputWindowName(12));
  expect(outputWindowNameOf(`output-${runOutputWindowName(12)}_14`)).toBe(runOutputWindowName(12));
  expect(outputWindowNameOf('worker-desktop-41-0')).toBeNull();
  expect(outputWindowNameOf('output-piwi-run-output-12')).toBeNull();
  expect(outputWindowNameOf('main')).toBeNull();
});
