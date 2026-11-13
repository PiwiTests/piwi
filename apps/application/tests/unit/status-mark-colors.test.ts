import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATUS_COLORS } from '#shared/status-colors';

/**
 * The outcome marks have one palette in the dashboard, the editors and Piwi Picker: the `fill` of `STATUS_COLORS`, which
 * the VS Code extension's outcome marks and flaky word, the JetBrains plugin's flaky and running marks, Piwi Picker's
 * dots and Runs window counts, and the desktop tray's dot restate, since none of them can import it.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path: string) => readFileSync(`${REPO_ROOT}/${path}`, 'utf8');
/** The color a mark's disc is filled with: its first `fill`. */
const disc = (svg: string) => /fill="(#[0-9a-f]{6})"/i.exec(svg)?.[1]?.toLowerCase();

describe('the outcome marks', () => {
  test('are the dashboard’s outcome colors in VS Code', () => {
    for (const status of ['passed', 'failed', 'flaky', 'skipped'] as const) {
      expect(disc(read(`apps/vscode/media/test-${status}.svg`)), status).toBe(STATUS_COLORS[status].fill);
    }
    // A running test is a ring, drawn with the stroke.
    expect(/stroke="(#[0-9a-f]{6})"/.exec(read('apps/vscode/media/test-running.svg'))?.[1]).toBe(
      STATUS_COLORS.running.fill,
    );
  });

  test('draw flaky and running the same in both editors', () => {
    expect(read('apps/jetbrains/src/main/resources/icons/testFlaky.svg')).toBe(
      read('apps/vscode/media/test-flaky.svg'),
    );
    expect(read('apps/jetbrains/src/main/resources/icons/testRunning.svg')).toBe(
      read('apps/vscode/media/test-running.svg'),
    );
  });

  test('are Piwi Picker’s dots, in its results panel and its coverage view', () => {
    for (const file of [
      'apps/extension/src/content/results-panel.ts',
      'apps/extension/src/content/coverage-style.ts',
    ]) {
      const css = read(file);
      for (const status of ['passed', 'failed', 'flaky', 'skipped'] as const) {
        const dot = new RegExp(`\\.dot\\.${status} \\{ background: (#[0-9a-f]{6}); \\}`).exec(css)?.[1];
        expect(dot, `${file} ${status}`).toBe(STATUS_COLORS[status].fill);
      }
    }
  });

  test('are the desktop tray’s dot, a paused run in the pause bar’s violet', () => {
    const rust = read('apps/desktop/src-tauri/src/lib.rs');
    const rgb = (name: string) => {
      const m = new RegExp(`const ${name}: \\(u8, u8, u8\\) = \\((\\d+), (\\d+), (\\d+)\\);`).exec(rust);
      return m
        ? `#${m
            .slice(1, 4)
            .map((n) => Number(n).toString(16).padStart(2, '0'))
            .join('')}`
        : undefined;
    };
    expect(rgb('DOT_FAILED')).toBe(STATUS_COLORS.failed.fill);
    expect(rgb('DOT_PASSED')).toBe(STATUS_COLORS.passed.fill);
    expect(rgb('DOT_RUNNING')).toBe(STATUS_COLORS.running.fill);
    const resume = /'background:(#[0-9a-f]{6});color:#fff;border:1px solid/.exec(
      read('packages/picker-dom/src/overlay-pause.ts'),
    )?.[1];
    expect(rgb('DOT_PAUSED')).toBe(resume);
  });

  test('color the failed and flaky counts of Piwi Picker’s Runs window and VS Code’s flaky word', () => {
    const runs = read('apps/extension/runs.html');
    for (const status of ['failed', 'flaky'] as const) {
      const color = new RegExp(`\\.run-progress \\.${status} \\{\\s*color: (#[0-9a-f]{6});`).exec(runs)?.[1];
      expect(color, status).toBe(STATUS_COLORS[status].fill);
    }
    const colors = JSON.parse(read('apps/vscode/package.json')).contributes.colors as Array<{
      id: string;
      defaults: Record<string, string>;
    }>;
    const flaky = colors.find((c) => c.id === 'piwi.flakyForeground');
    expect(Object.values(flaky?.defaults ?? {})).toEqual(Array(4).fill(STATUS_COLORS.flaky.fill));
  });
});
