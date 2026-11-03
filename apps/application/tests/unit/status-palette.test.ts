import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { STATUS_PALETTE, statusPalette, statusPaletteKey } from '../../app/utils/status-palette';
import { formatExecutionStatus, statusChipLabel } from '../../app/utils/index';

describe('statusPaletteKey', () => {
  test('maps each outcome to its own palette entry', () => {
    expect(statusPaletteKey('passed')).toBe('passed');
    expect(statusPaletteKey('failed')).toBe('failed');
    expect(statusPaletteKey('flaky')).toBe('flaky');
    expect(statusPaletteKey('skipped')).toBe('skipped');
    expect(statusPaletteKey('fixme')).toBe('fixme');
    expect(statusPaletteKey('didnotrun')).toBe('didnotrun');
  });

  test('counts timed-out as failed', () => {
    expect(statusPaletteKey('timedout')).toBe('failed');
    expect(statusPaletteKey('timedOut')).toBe('failed');
  });

  test('draws interrupted in its own neutral entry, in no outcome', () => {
    expect(statusPaletteKey('interrupted')).toBe('interrupted');
    expect(statusPalette('interrupted')).toBe(STATUS_PALETTE.interrupted);
    expect(statusPalette('interrupted')).not.toBe(STATUS_PALETTE.failed);
    expect(statusChipLabel('interrupted')).toBe('Interrupted');
  });

  test('gives the three in-flight statuses one entry', () => {
    expect(statusPaletteKey('running')).toBe('running');
    expect(statusPaletteKey('initializing')).toBe('running');
    expect(statusPaletteKey('finalizing')).toBe('running');
  });

  test('reads a pass after a failed attempt (its verdict) as flaky', () => {
    expect(statusPaletteKey('passed', true)).toBe('flaky');
    expect(statusPaletteKey('passed', false)).toBe('passed');
    expect(statusPaletteKey('passed', null)).toBe('passed');
    expect(statusPaletteKey('failed', true)).toBe('failed');
  });

  test('falls back to the neutral skipped entry', () => {
    expect(statusPaletteKey('cancelled')).toBe('skipped');
    expect(statusPaletteKey('never-run')).toBe('skipped');
    expect(statusPaletteKey(null)).toBe('skipped');
  });
});

describe('STATUS_PALETTE', () => {
  test('backs every entry with its CSS token', () => {
    for (const [key, entry] of Object.entries(STATUS_PALETTE)) {
      expect(entry.color).toBe(`var(--color-status-${key})`);
      expect(entry.bg).toBe(`bg-status-${key}`);
      expect(entry.ring).toBe(`ring-status-${key}`);
      expect(entry.edge).toBe(`border-l-status-${key}`);
    }
  });

  test('edges an interrupted run in its own slate, apart from the skipped grey', () => {
    expect(statusPalette('interrupted').edge).toBe('border-l-status-interrupted');
    expect(statusPalette('interrupted').edge).not.toBe(STATUS_PALETTE.skipped.edge);
  });

  test('every entry has a row tint, light and dark', () => {
    for (const entry of Object.values(STATUS_PALETTE)) {
      expect(entry.tint).toMatch(/^bg-\w+-(50|100) dark:bg-\w+-\d+\/\d+$/);
    }
  });

  test('every entry has its token defined in main.css', () => {
    const css = readFileSync(new URL('../../app/assets/css/main.css', import.meta.url), 'utf8');
    for (const key of Object.keys(STATUS_PALETTE)) expect(css).toContain(`--color-status-${key}:`);
  });

  test('statusPalette returns the entry for a raw status', () => {
    expect(statusPalette('timedout')).toBe(STATUS_PALETTE.failed);
    expect(statusPalette('passed', true)).toBe(STATUS_PALETTE.flaky);
  });
});

describe('formatExecutionStatus', () => {
  test('names a pass after a failed attempt', () => {
    expect(formatExecutionStatus('passed', true)).toBe('passed on retry');
    expect(formatExecutionStatus('passed', false)).toBe('passed');
    expect(formatExecutionStatus('timedout')).toBe('timed out');
  });
});

describe('statusChipLabel', () => {
  test('reads the execution status in sentence case', () => {
    expect(statusChipLabel('passed', true)).toBe('Passed on retry');
    expect(statusChipLabel('passed')).toBe('Passed');
    expect(statusChipLabel('didnotrun')).toBe("Didn't run");
    expect(statusChipLabel('timedOut')).toBe('Timed out');
    expect(statusChipLabel('failed', true)).toBe('Failed');
  });
});
