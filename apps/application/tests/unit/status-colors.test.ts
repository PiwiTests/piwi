import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PASS_RATE_COLORS,
  PASS_RATE_FAIR,
  PASS_RATE_GOOD,
  PASS_RATE_STEP_DEFS,
  STATUS_COLORS,
  passRateStepHex,
  passRateTone,
} from '#shared/status-colors';
import { PASS_RATE_STEPS, PASS_RATE_TONES } from '../../app/utils/pass-rate';
import { STATUS_PALETTE } from '@piwitests/run-ui/status-palette';

const css = readFileSync(resolve(__dirname, '../../app/assets/css/main.css'), 'utf8');

describe('shared status colors', () => {
  test('every --color-status-* token in main.css points at the shared palette entry', () => {
    const tokens = new Map<string, string>();
    // The first definition is the light one; `.dark` restates some tokens further down.
    for (const match of css.matchAll(/--color-status-([a-z]+):\s*var\(--color-([a-z]+-\d+)\)/g)) {
      if (!tokens.has(match[1]!)) tokens.set(match[1]!, match[2]!);
    }
    expect([...tokens.keys()].sort()).toEqual(Object.keys(STATUS_COLORS).sort());
    for (const [key, color] of Object.entries(STATUS_COLORS)) expect(tokens.get(key)).toBe(color.token);
  });

  test('the app palette paints through the same tokens', () => {
    for (const key of Object.keys(STATUS_COLORS)) {
      expect(STATUS_PALETTE[key as keyof typeof STATUS_PALETTE].color).toBe(`var(--color-status-${key})`);
    }
    expect(PASS_RATE_TONES.fair.color).toBe(`var(--color-${PASS_RATE_COLORS.fair.token})`);
  });

  test('the pass-rate thresholds and steps are the shared ones', () => {
    expect(PASS_RATE_GOOD).toBe(90);
    expect(PASS_RATE_FAIR).toBe(50);
    expect(passRateTone(90)).toBe('good');
    expect(passRateTone(89.9)).toBe('fair');
    expect(passRateTone(49.9)).toBe('poor');
    expect(PASS_RATE_STEPS.map((s) => s.min)).toEqual(PASS_RATE_STEP_DEFS.map((s) => s.min));
    expect(PASS_RATE_STEPS.map((s) => s.label)).toEqual(['100%', '≥ 90%', '≥ 75%', '≥ 50%', '< 50%']);
  });

  test('a step over white keeps the band hue', () => {
    expect(passRateStepHex(100)).toMatch(/^#[0-9a-f]{6}$/);
    expect(passRateStepHex(100)).not.toBe(passRateStepHex(10));
  });
});
