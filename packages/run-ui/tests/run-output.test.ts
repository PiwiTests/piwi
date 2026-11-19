import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  runOutputFirstError,
  runOutputLine,
  runOutputMatching,
  runOutputText,
  type RunOutputLine,
} from '../app/utils/run-output';
import {
  RUN_FORCE_STOP_GUARD_MS,
  RUN_STOP_GRACE_MS,
  runForceStopGuarded,
  runStopSecondsLeft,
} from '../app/utils/run-stop';

const ESC = '\u001b';
const lines = (...texts: string[]): RunOutputLine[] => texts.map((text, i) => runOutputLine(i + 1, text, false));

describe('runOutputLine', () => {
  test('keeps the colors of a line that has them, and the text without them', () => {
    expect(runOutputLine(3, `${ESC}[31m1 failed${ESC}[39m`, false)).toEqual({
      id: 3,
      text: '1 failed',
      error: false,
      ansi: `${ESC}[31m1 failed${ESC}[39m`,
    });
    expect(runOutputLine(4, 'plain', true)).toEqual({ id: 4, text: 'plain', error: true });
  });
});

describe('runOutputFirstError', () => {
  test('finds the first failure Playwright numbered, or the first thrown error', () => {
    const output = lines(
      'Running 2 tests using 1 worker',
      '  ✘  1 [chromium] › tests/cart.spec.ts:30:3 › applies a coupon',
      '',
      '  1) [chromium] › tests/cart.spec.ts:30:3 › cart › applies a coupon',
      '    Error: expect(locator).toHaveText(expected) failed',
    );
    expect(runOutputFirstError(output)?.id).toBe(4);
    expect(runOutputFirstError(lines('ok', 'TypeError: x is not a function'))?.id).toBe(2);
  });

  test('takes a failed test’s result line when the output holds no failure of its own', () => {
    const output = lines(
      'Running 1 test using 1 worker',
      '  ✘  1 [chromium] › tests/cart.spec.ts:3:1 › pays',
      '  1 failed',
    );
    expect(runOutputFirstError(output)?.id).toBe(2);
  });

  test('finds none in a run that passed, its warnings on stderr included', () => {
    const output = [runOutputLine(1, 'Running', false), runOutputLine(2, 'npm warn exec', true)];
    expect(runOutputFirstError(output)).toBeNull();
    expect(runOutputFirstError(lines('Running 1 test', '  1 passed'))).toBeNull();
  });
});

describe('runOutputMatching', () => {
  test('keeps the lines holding the text, case and accents ignored', () => {
    const output = lines('Résumé page', 'checkout', 'RESUME again');
    expect(runOutputMatching(output, 'resume').map((line) => line.id)).toEqual([1, 3]);
    expect(runOutputMatching(output, '  ')).toBe(output);
  });
});

describe('runOutputText', () => {
  test('copies every line without colors', () => {
    expect(runOutputText(lines(`${ESC}[32m✓${ESC}[39m one`, 'two'))).toBe('✓ one\ntwo');
  });
});

describe('a run’s stop', () => {
  test('counts down the shell’s grace period, the desktop crate’s STOP_GRACE', () => {
    const rust = readFileSync(
      path.resolve(import.meta.dirname, '../../../apps/desktop/src-tauri/src/interrupt.rs'),
      'utf8',
    );
    const seconds = /const STOP_GRACE: Duration = Duration::from_secs\((\d+)\);/.exec(rust)?.[1];
    expect(Number(seconds) * 1000).toBe(RUN_STOP_GRACE_MS);
    expect(runStopSecondsLeft(1_000, 1_000)).toBe(10);
    expect(runStopSecondsLeft(1_000, 1_001)).toBe(10);
    expect(runStopSecondsLeft(1_000, 10_500)).toBe(1);
    expect(runStopSecondsLeft(1_000, 11_000)).toBe(0);
    expect(runStopSecondsLeft(1_000, 60_000)).toBe(0);
  });

  test('takes no Force stop for a moment after the stop was asked', () => {
    expect(runForceStopGuarded(1_000, 1_000)).toBe(true);
    expect(runForceStopGuarded(1_000, 1_000 + RUN_FORCE_STOP_GUARD_MS - 1)).toBe(true);
    expect(runForceStopGuarded(1_000, 1_000 + RUN_FORCE_STOP_GUARD_MS)).toBe(false);
  });
});
