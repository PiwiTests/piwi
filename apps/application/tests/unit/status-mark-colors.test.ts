import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATUS_COLORS } from '#shared/status-colors';

/**
 * The outcome marks have one palette in the dashboard, the editors and Piwi Picker: the `fill` of `STATUS_COLORS`, which
 * the VS Code extension's outcome marks, the JetBrains plugin's flaky and running marks and Piwi Picker's dots restate,
 * since none of them can import it.
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
});
