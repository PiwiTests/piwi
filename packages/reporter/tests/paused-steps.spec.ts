import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectStepMetrics, extractTestStepEvents } from '@piwitests/core/step-analysis';
import { readPauses, withoutPausedTime } from '../src/internal/collect/paused-steps.js';
import type { PauseRecord } from '../src/internal/capture/pause-at.js';

const spec = path.join(path.resolve('/work/shop'), 'tests', 'checkout.spec.ts');

interface Step {
  title: string;
  category: string;
  location?: { file: string; line: number; column: number };
  startTime: Date;
  duration: number;
  steps: Step[];
}

function step(title: string, at: number, duration: number, line: number | null, steps: Step[] = []): Step {
  return {
    title,
    category: line === null ? 'hook' : 'pw:api',
    ...(line === null ? {} : { location: { file: spec, line, column: 5 } }),
    startTime: new Date(at),
    duration,
    steps,
  };
}

function pause(line: number, startedAt: number, duration: number): PauseRecord {
  return { title: 'Navigate', location: `tests/checkout.spec.ts:${line}:5`, reason: 'breakpoint', startedAt, duration };
}

/** Each step's start and duration, depth first. */
function timings(steps: Step[]): Array<[string, number, number]> {
  return steps.flatMap((s) => [
    [s.title, s.startTime.getTime(), s.duration] as [string, number, number],
    ...timings(s.steps),
  ]);
}

describe('withoutPausedTime', () => {
  it('takes a stop out of its call’s step and of every step around it, and leaves the steps before it', () => {
    const goto = step('Navigate', 1_000, 5_200, 4);
    const click = step('Click', 6_300, 100, 5);
    const group = { ...step('Pay with a coupon', 900, 5_600, 3, [goto, click]), category: 'test.step' };
    const hooks = step('Before Hooks', 0, 80, null);
    const steps = [hooks, group];
    const out = withoutPausedTime(steps, [pause(4, 1_050, 5_000)]);

    expect(out[0]).toBe(hooks);
    expect(out[1]!.duration).toBe(600);
    expect(out[1]!.steps.map((s) => s.duration)).toEqual([200, 100]);
    // The steps the reporter received are left as they are.
    expect(goto.duration).toBe(5_200);
    expect(click.startTime.getTime()).toBe(6_300);
    expect(collectStepMetrics(out).slowestStep).toEqual({ title: 'Pay with a coupon', duration: 600 });
  });

  it('takes out the stop of a run of a line in a loop, and adds up two stops in one step', () => {
    const runs = [step('Click', 0, 50, 7), step('Click', 100, 3_050, 7), step('Click', 3_200, 40, 7)];
    const group = { ...step('Each item', 0, 3_300, 6, runs), category: 'test.step' };
    const out = withoutPausedTime([group], [pause(7, 110, 1_000), pause(7, 1_200, 1_900)]);
    expect(out[0]!.duration).toBe(400);
    expect(out[0]!.steps.map((s) => s.duration)).toEqual([50, 150, 40]);
  });

  it('takes a stop at a call Playwright shows no step for (a getter) out of the steps that ran across it', () => {
    // `inputValue()` stopped inside `test.step('read')`; Playwright lists no step for a getter.
    const click = step('Click', 1_010, 70, 15);
    const read = { ...step('read', 1_000, 2_653, 14, [click]), category: 'test.step' };
    const out = withoutPausedTime([read], [pause(16, 1_090, 2_557)]);
    expect(timings(out)).toEqual([
      ['read', 1_000, 96],
      ['Click', 1_010, 70],
    ]);
  });

  it('moves every step after a stop back by the time stopped before it, so the steps fit the test’s duration', () => {
    const before = step('Before Hooks', 0, 300, null);
    const goto = step('Navigate', 300, 4_100, 4);
    const click = step('Click', 4_450, 50, 5);
    const after = step('After Hooks', 4_550, 100, null, [step('Fixture "page"', 4_560, 20, null)]);
    const out = withoutPausedTime([before, goto, click, after], [pause(4, 350, 4_000)]);
    expect(timings(out)).toEqual([
      ['Before Hooks', 0, 300],
      ['Navigate', 300, 100],
      ['Click', 450, 50],
      ['After Hooks', 550, 100],
      ['Fixture "page"', 560, 20],
    ]);
    // The timeline's hook sections end within the test: here 650 ms after it started.
    const events = extractTestStepEvents(out, new Date(0));
    expect(events.map((e) => [e.title, e.startedAt, e.duration])).toEqual([
      ['Before Hooks', 0, 300],
      ['After Hooks', 550, 100],
    ]);
  });

  it('moves a step that began during a stop to the stop’s start, and joins overlapping stops', () => {
    // A wait the test started before the stop kept its own deadline: it ran out during the stop, and the test ended.
    const poll = { ...step('Expect "poll toBe"', 1_000, 1_000, 4), category: 'expect' };
    const after = step('After Hooks', 2_100, 200, null);
    const out = withoutPausedTime([poll, after], [pause(4, 1_200, 1_000), pause(4, 1_500, 1_000)]);
    expect(timings(out)).toEqual([
      ['Expect "poll toBe"', 1_000, 200],
      ['After Hooks', 1_200, 0],
    ]);
  });

  it('leaves the steps as they are when no stop came before or during them', () => {
    const steps = [step('Navigate', 1_000, 300, 4)];
    expect(withoutPausedTime(steps, [])).toBe(steps);
    expect(withoutPausedTime(steps, [pause(4, 1_300, 5_000)])).toBe(steps);
    expect(withoutPausedTime(steps, [pause(4, 1_100, 0)])).toBe(steps);
    // An unfinished step keeps Playwright's -1.
    const open = [step('Click', 500, -1, 5)];
    expect(withoutPausedTime(open, [pause(5, 600, 1_000)])).toBe(open);
  });
});

describe('readPauses', () => {
  it('reads the attachment’s stops and nothing else', () => {
    const stops = [pause(4, 1_050, 5_000)];
    expect(readPauses(Buffer.from(JSON.stringify(stops)))).toEqual(stops);
    expect(readPauses(Buffer.from(JSON.stringify([...stops, { title: 'x' }, null])))).toEqual(stops);
    expect(readPauses(Buffer.from('{'))).toEqual([]);
    expect(readPauses(Buffer.from('{}'))).toEqual([]);
    expect(readPauses(undefined)).toEqual([]);
  });
});
