import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectStepMetrics } from '@piwitests/core/step-analysis';
import { readPauses, withoutPausedTime } from '../src/internal/collect/paused-steps.js';
import type { PauseRecord } from '../src/internal/capture/pause-at.js';

const cwd = path.resolve('/work/shop');
const spec = path.join(cwd, 'tests', 'checkout.spec.ts');

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

describe('withoutPausedTime', () => {
  it('takes a stop out of its call’s step and of every step around it, and leaves the rest', () => {
    const goto = step('Navigate', 1_000, 5_200, 4);
    const click = step('Click', 6_300, 100, 5);
    const group = { ...step('Pay with a coupon', 900, 5_600, 3, [goto, click]), category: 'test.step' };
    const hooks = step('Before Hooks', 0, 80, null);
    const steps = [hooks, group];
    const out = withoutPausedTime(steps, [pause(4, 1_050, 5_000)], cwd);

    expect(out[0]).toBe(hooks);
    expect(out[1]!.duration).toBe(600);
    expect(out[1]!.steps.map((s) => s.duration)).toEqual([200, 100]);
    expect(out[1]!.steps[1]).toBe(click);
    // The steps the reporter received are left as they are.
    expect(goto.duration).toBe(5_200);
    expect(collectStepMetrics(out).slowestStep).toEqual({ title: 'Pay with a coupon', duration: 600 });
  });

  it('finds the run of a line the stop held among its runs in a loop, and adds up two stops in one step', () => {
    const runs = [step('Click', 0, 50, 7), step('Click', 100, 3_050, 7), step('Click', 3_200, 40, 7)];
    const group = { ...step('Each item', 0, 3_300, 6, runs), category: 'test.step' };
    const out = withoutPausedTime([group], [pause(7, 110, 1_000), pause(7, 1_200, 1_900)], cwd);
    expect(out[0]!.duration).toBe(400);
    expect(out[0]!.steps.map((s) => s.duration)).toEqual([50, 150, 40]);
  });

  it('leaves the steps as they are when no step was running at the stop’s place for the whole stop', () => {
    const steps = [step('Navigate', 1_000, 300, 4)];
    expect(withoutPausedTime(steps, [], cwd)).toBe(steps);
    expect(withoutPausedTime(steps, [pause(4, 1_100, 5_000)], cwd)).toBe(steps);
    expect(withoutPausedTime(steps, [pause(9, 1_010, 100)], cwd)).toBe(steps);
    expect(withoutPausedTime(steps, [{ ...pause(4, 1_010, 100), location: 'nowhere' }], cwd)).toBe(steps);
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
