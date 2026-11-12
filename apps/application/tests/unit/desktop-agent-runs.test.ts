import { describe, expect, test } from 'vitest';
import { desktopAgentRunAnswerOf, desktopAgentRunOf } from '#shared/desktop-agent-runs';
import { buildLocalRunPlan } from '../../app/utils/local-run-args';
import {
  desktopAgentRunInput,
  desktopAgentRunRef,
  desktopRunEnds,
  takeAgentRun,
} from '../../app/utils/desktop-agent-run';

/**
 * A run an agent asks the desktop app to start (`run_start`): what the desktop event stream carries to the window, how
 * the window starts it as a person's run of the spec, and the answer it sends back.
 */

const RUN = {
  id: 'a'.repeat(32),
  projectId: 3,
  file: 'tests/checkout.spec.ts',
  line: 3,
  headed: false,
  hold: true,
  title: 'Started by Claude Code',
};

describe('an agent’s run, as the window hears it', () => {
  test('is read field by field, and refused otherwise', () => {
    expect(desktopAgentRunOf(RUN)).toEqual(RUN);
    expect(desktopAgentRunOf({ ...RUN, line: null })).toEqual({ ...RUN, line: null });
    for (const bad of [
      { ...RUN, id: 'nope' },
      { ...RUN, projectId: 0 },
      { ...RUN, file: '' },
      { ...RUN, file: '--config=evil.ts' },
      { ...RUN, line: 0 },
      { ...RUN, headed: 'yes' },
      { ...RUN, title: '' },
      null,
      'run',
    ]) {
      expect(desktopAgentRunOf(bad)).toBeNull();
    }
  });

  test('starts as a person’s run of the spec: the test at its line, headed and holding failures as the agent asked', () => {
    const input = desktopAgentRunInput(RUN);
    expect(input).toEqual({
      projectId: 3,
      cases: [{ filePath: 'tests/checkout.spec.ts', title: '', line: 3 }],
      title: 'Started by Claude Code',
      options: { mode: 'file-line', runMode: 'normal', holdFailures: true, repeatEach: 1 },
    });
    // The project's saved options never make it a run nobody attends.
    const saved = { trace: true, repeatEach: 20, stopAtFirstFailure: false, runMode: 'ui' as const };
    const args = buildLocalRunPlan(input.cases, { ...saved, ...input.options })[0]!.args;
    expect(args).toEqual(['tests/checkout.spec.ts:3', '--trace=on']);
    expect(desktopAgentRunRef(9, args)).toBe('desktop-9');
    expect(buildLocalRunPlan(input.cases, input.options)[0]!.args).toEqual(['tests/checkout.spec.ts:3']);
    const whole = desktopAgentRunInput({ ...RUN, line: null, headed: true, hold: false });
    expect(buildLocalRunPlan(whole.cases, whole.options)[0]!.args).toEqual(['tests/checkout.spec.ts', '--headed']);
    expect(whole.options.holdFailures).toBe(false);
  });

  test('is answered with the name the hub knows the run by, marked when nobody attends it', () => {
    expect(desktopAgentRunRef(7, ['tests/checkout.spec.ts:3'])).toBe('desktop-7');
    expect(desktopAgentRunRef(8, ['tests/checkout.spec.ts', '--repeat-each=5'])).toBe('desktop-8-unattended');
    expect(desktopAgentRunAnswerOf({ id: RUN.id, ref: 'desktop-7' })).toEqual({ id: RUN.id, ref: 'desktop-7' });
    expect(desktopAgentRunAnswerOf({ id: RUN.id, error: 'No folder.' })).toEqual({ id: RUN.id, error: 'No folder.' });
    for (const bad of [
      { id: RUN.id, ref: 'ed-1' },
      { id: RUN.id, ref: 'desktop-7', error: 'both' },
      { id: RUN.id },
      { id: 'x', ref: 'desktop-7' },
    ]) {
      expect(desktopAgentRunAnswerOf(bad)).toBeNull();
    }
  });
});

describe('the window that starts agents’ runs', () => {
  test('takes each run once, through a reload too', () => {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    };
    expect(takeAgentRun(RUN.id, storage)).toBe(true);
    expect(takeAgentRun(RUN.id, storage)).toBe(false);
    expect(takeAgentRun('b'.repeat(32), storage)).toBe(true);
    // Unavailable storage: taken once in this page.
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(takeAgentRun('c'.repeat(32), broken)).toBe(true);
    expect(takeAgentRun('c'.repeat(32), broken)).toBe(false);
  });

  test('says each process of a run that ended ended, with its exit code', () => {
    expect(desktopRunEnds({ kind: 'tests', hubRefs: ['desktop-4', 'desktop-5'], exitCode: 1 })).toEqual([
      { ref: 'desktop-4', exitCode: 1 },
      { ref: 'desktop-5', exitCode: 1 },
    ]);
    expect(desktopRunEnds({ kind: 'tests', hubRefs: ['desktop-6'], exitCode: null })).toEqual([
      { ref: 'desktop-6', exitCode: null },
    ]);
    expect(desktopRunEnds({ kind: 'bisect', hubRefs: ['desktop-7'], exitCode: 0 })).toEqual([]);
  });
});
