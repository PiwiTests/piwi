import { describe, test, expect } from 'vitest';
import {
  PASS_RATE_FAIR,
  PASS_RATE_GOOD,
  PASS_RATE_STEPS,
  PASS_RATE_TONES,
  passRateStep,
  passRateTextClass,
  passRateTone,
} from '../../app/utils/pass-rate';
import { STATUS_PALETTE } from '@piwitests/run-ui/status-palette';

describe('passRateTone', () => {
  test('splits the scale at 90% and 50%', () => {
    expect(PASS_RATE_GOOD).toBe(90);
    expect(PASS_RATE_FAIR).toBe(50);
    expect(passRateTone(100)).toBe('good');
    expect(passRateTone(90)).toBe('good');
    expect(passRateTone(89.9)).toBe('fair');
    expect(passRateTone(50)).toBe('fair');
    expect(passRateTone(49.9)).toBe('poor');
    expect(passRateTone(0)).toBe('poor');
  });
});

describe('PASS_RATE_TONES', () => {
  test('good and poor match the passed and failed outcome colors', () => {
    expect(PASS_RATE_TONES.good.color).toBe(STATUS_PALETTE.passed.color);
    expect(PASS_RATE_TONES.poor.color).toBe(STATUS_PALETTE.failed.color);
    expect(PASS_RATE_TONES.good.text).toBe(STATUS_PALETTE.passed.text);
    expect(PASS_RATE_TONES.poor.text).toBe(STATUS_PALETTE.failed.text);
    expect(PASS_RATE_TONES.fair.text).toContain('amber');
  });
});

describe('passRateTextClass', () => {
  test('colors a percentage by its band and mutes a missing one', () => {
    expect(passRateTextClass(95)).toBe(PASS_RATE_TONES.good.text);
    expect(passRateTextClass(70)).toBe(PASS_RATE_TONES.fair.text);
    expect(passRateTextClass(10)).toBe(PASS_RATE_TONES.poor.text);
    expect(passRateTextClass(null)).toBe('text-muted');
    expect(passRateTextClass(undefined)).toBe('text-muted');
  });
});

describe('passRateStep', () => {
  test('picks the five cell shades best first', () => {
    expect(passRateStep(100).label).toBe('100%');
    expect(passRateStep(99.5).label).toBe('100%');
    expect(passRateStep(95).label).toBe('≥ 90%');
    expect(passRateStep(80).label).toBe('≥ 75%');
    expect(passRateStep(60).label).toBe('≥ 50%');
    expect(passRateStep(0).label).toBe('< 50%');
  });

  test('keeps every shade inside its band', () => {
    for (const step of PASS_RATE_STEPS) {
      if (Number.isFinite(step.min)) expect(passRateTone(step.min)).toBe(step.tone);
      expect(step.color).toContain(PASS_RATE_TONES[step.tone].color);
    }
  });
});
