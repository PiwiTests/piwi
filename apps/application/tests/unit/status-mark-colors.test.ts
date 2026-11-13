import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATUS_COLORS } from '#shared/status-colors';

/**
 * The outcome marks have one palette in the dashboard and in the editors: the `fill` of `STATUS_COLORS`, which the VS
 * Code extension's outcome marks and the JetBrains plugin's flaky mark restate, since neither can import it.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path: string) => readFileSync(`${REPO_ROOT}/${path}`, 'utf8');
/** The color a mark's disc is filled with: its first `fill`. */
const disc = (svg: string) => /fill="(#[0-9a-f]{6})"/i.exec(svg)?.[1]?.toLowerCase();

describe('the outcome marks', () => {
  test('are the dashboard’s outcome colors in VS Code', () => {
    for (const status of ['passed', 'failed', 'flaky', 'skipped', 'running'] as const) {
      expect(disc(read(`apps/vscode/media/test-${status}.svg`)), status).toBe(STATUS_COLORS[status].fill);
    }
  });

  test('draw flaky the same in both editors, a lighter shade on a dark theme in JetBrains', () => {
    const vscode = read('apps/vscode/media/test-flaky.svg');
    expect(read('apps/jetbrains/src/main/resources/icons/testFlaky.svg')).toBe(vscode);
    expect(disc(read('apps/jetbrains/src/main/resources/icons/testFlaky_dark.svg'))).toBe(STATUS_COLORS.flaky.textDark);
  });
});
