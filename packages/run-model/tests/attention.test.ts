import { describe, expect, test } from 'vitest';
import { runAttention, runsAttention } from '../src/attention';

describe('what a run asks of the person', () => {
  const running = { state: 'running', stop: null };
  const at = (reason: string, driver?: { kind: string }) => ({ state: 'stopped', stop: { reason, driver } });
  const progress = (failed: number) => ({ failed });

  test('waits for them at a stop, else is failing, else runs; nothing once it ended', () => {
    expect(runAttention({ ended: false, workers: [running] })).toEqual({
      state: 'running',
      waiting: 0,
      heldFailures: 0,
      failed: 0,
    });
    expect(runAttention({ ended: false, workers: [running], progress: progress(2) })).toEqual({
      state: 'failing',
      waiting: 0,
      heldFailures: 0,
      failed: 2,
    });
    // A stop waits for the person whatever failed before it: a breakpoint, and a failure held at its line.
    expect(
      runAttention({ ended: false, workers: [at('breakpoint'), at('failure'), running], progress: progress(1) }),
    ).toEqual({ state: 'waiting', waiting: 2, heldFailures: 1, failed: 1 });
    expect(runAttention({ ended: true, workers: [at('pause')] })).toBeNull();
  });

  test('leaves a stop an agent drives to the agent, and a person’s to the person', () => {
    expect(runAttention({ ended: false, workers: [at('pause', { kind: 'agent' })] })).toMatchObject({
      state: 'running',
      waiting: 0,
    });
    expect(runAttention({ ended: false, workers: [at('pause', { kind: 'picker' })] })).toMatchObject({
      state: 'waiting',
      waiting: 1,
    });
  });

  test('takes the most pressing state of the live runs, each count summed', () => {
    const failing = { ended: false, workers: [running], progress: progress(1) };
    const waiting = { ended: false, workers: [at('failure')] };
    const ended = { ended: true, workers: [at('pause')], progress: progress(5) };
    expect(runsAttention([])).toBeNull();
    expect(runsAttention([ended])).toBeNull();
    expect(runsAttention([failing, ended])).toEqual({ state: 'failing', waiting: 0, heldFailures: 0, failed: 1 });
    expect(runsAttention([failing, waiting])).toEqual({ state: 'waiting', waiting: 1, heldFailures: 1, failed: 1 });
  });
});
