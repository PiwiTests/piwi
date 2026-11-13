import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATUS_COLORS } from '#shared/status-colors';

/**
 * The outcome marks have one palette in the dashboard, the editors and Piwi Picker: the `fill` of `STATUS_COLORS`, which
 * the VS Code extension's outcome marks, flaky word, failing and recording tints and held failure's arrow, the JetBrains
 * plugin's flaky and running marks and color schemes, Piwi Picker's dots and Runs window counts, and the desktop tray's
 * dot restate, since none of them can import it.
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

  test('mark a recording with the same glyphs in both editors', () => {
    for (const [vscode, jetbrains] of [
      ['recording', 'recording'],
      ['recording-dark', 'recording_dark'],
      ['recording-paused', 'recordPaused'],
      ['recording-paused-dark', 'recordPaused_dark'],
    ]) {
      expect(read(`apps/vscode/media/${vscode}.svg`), vscode).toBe(
        read(`apps/jetbrains/src/main/resources/icons/${jetbrains}.svg`),
      );
    }
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

  test('are the desktop tray’s dot, a run that waits in the pause bar’s violet', () => {
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
    expect(rgb('DOT_INTERRUPTED')).toBe(STATUS_COLORS.interrupted.fill);
    const resume = /'background:(#[0-9a-f]{6});color:#fff;border:1px solid/.exec(
      read('packages/picker-dom/src/overlay-pause.ts'),
    )?.[1];
    expect(resume).toMatch(/^#[0-9a-f]{6}$/);
    expect(rgb('DOT_PAUSED')).toBe(resume);
  });

  test('count a test that waits for you in Piwi Picker in the pause bar’s violet, as the tray does', () => {
    const resume = /'background:(#[0-9a-f]{6});color:#fff;border:1px solid/.exec(
      read('packages/picker-dom/src/overlay-pause.ts'),
    )?.[1];
    // The bar's border, the violet it shows on its dark ground.
    const onDark = /border-bottom:2px solid (#[0-9a-f]{6})/.exec(read('packages/picker-dom/src/overlay-pause.ts'))?.[1];
    expect(
      /const RUNS_WAITING_COLOR = '(#[0-9a-f]{6})'/.exec(read('apps/extension/src/background/runs-window.ts'))?.[1],
    ).toBe(resume);
    for (const [file, variable] of [
      ['apps/extension/popup.html', 'wait'],
      ['apps/extension/runs.html', 'stopped'],
    ] as const) {
      const html = read(file);
      const light = /:root \{([^}]*)\}/.exec(html)?.[1] ?? '';
      const dark = /prefers-color-scheme: dark\)[^{]*\{\s*:root \{([^}]*)\}/.exec(html)?.[1] ?? '';
      expect(new RegExp(`--${variable}: (#[0-9a-f]{6});`).exec(light)?.[1], `${file} light`).toBe(resume);
      expect(new RegExp(`--${variable}: (#[0-9a-f]{6});`).exec(dark)?.[1], `${file} dark`).toBe(onDark);
    }
  });

  test('color the failed and flaky counts of Piwi Picker’s Runs window and VS Code’s flaky word as text', () => {
    const runs = read('apps/extension/runs.html');
    const light = /:root \{([^}]*)\}/.exec(runs)?.[1] ?? '';
    const dark = /prefers-color-scheme: dark\)[^{]*\{\s*:root \{([^}]*)\}/.exec(runs)?.[1] ?? '';
    for (const status of ['failed', 'flaky'] as const) {
      expect(runs, status).toContain(`.run-progress .${status} {\n        color: var(--${status});`);
      expect(new RegExp(`--${status}: (#[0-9a-f]{6});`).exec(light)?.[1], `${status} light`).toBe(
        STATUS_COLORS[status].text,
      );
      expect(new RegExp(`--${status}: (#[0-9a-f]{6});`).exec(dark)?.[1], `${status} dark`).toBe(
        STATUS_COLORS[status].textDark,
      );
    }
    const colors = JSON.parse(read('apps/vscode/package.json')).contributes.colors as Array<{
      id: string;
      defaults: Record<string, string>;
    }>;
    expect(colors.find((c) => c.id === 'piwi.flakyForeground')?.defaults).toEqual({
      dark: STATUS_COLORS.flaky.textDark,
      light: STATUS_COLORS.flaky.text,
      highContrast: STATUS_COLORS.flaky.textDark,
      highContrastLight: STATUS_COLORS.flaky.print,
    });
  });

  test('tint a failing test, its failing line and a recording in the failed and running fills, in both editors', () => {
    const colors = JSON.parse(read('apps/vscode/package.json')).contributes.colors as Array<{
      id: string;
      defaults: Record<string, string>;
    }>;
    // VS Code's tints: the fill at the alphas the JetBrains schemes blend it at, stronger in high contrast.
    const faint = (fill: string) => ({
      dark: `${fill}26`,
      light: `${fill}1a`,
      highContrast: `${fill}40`,
      highContrastLight: `${fill}26`,
    });
    const strong = (fill: string) => ({
      dark: `${fill}40`,
      light: `${fill}33`,
      highContrast: `${fill}66`,
      highContrastLight: `${fill}40`,
    });
    const tinted: Record<string, Record<string, string>> = {
      'piwi.failingTestBackground': faint(STATUS_COLORS.failed.fill),
      'piwi.failingLineBackground': strong(STATUS_COLORS.failed.fill),
      'piwi.failurePointBackground': strong(STATUS_COLORS.failed.fill),
      'piwi.recordingBlockBackground': faint(STATUS_COLORS.running.fill),
    };
    for (const [id, defaults] of Object.entries(tinted)) {
      expect(colors.find((c) => c.id === id)?.defaults, id).toEqual(defaults);
    }
    // A held failure's arrow in VS Code's gutter: the failed fill, outlined in its print color.
    expect(disc(read('apps/vscode/media/failure-point.svg'))).toBe(STATUS_COLORS.failed.fill);
    expect(read('apps/vscode/media/failure-point.svg')).toContain(`stroke="${STATUS_COLORS.failed.print}"`);
    // A JetBrains scheme takes no alpha: the fill blended over classic Default's or Darcula's background, which the
    // schemes derived from them inherit.
    const blend = (fill: string, ground: string, alpha: number) =>
      [1, 3, 5]
        .map((i) => {
          const f = parseInt(fill.slice(i, i + 2), 16);
          const g = parseInt(ground.slice(i, i + 2), 16);
          return Math.round(f * alpha + g * (1 - alpha))
            .toString(16)
            .padStart(2, '0');
        })
        .join('');
    const option = (xml: string, name: string, key: string) =>
      new RegExp(`<option name="${name}">[\\s\\S]*?<option name="${key}" value="([0-9a-f]{6})"`).exec(xml)?.[1];
    for (const [scheme, ground, faint, strong] of [
      ['PiwiDefault', '#ffffff', 0.1, 0.2],
      ['PiwiDarcula', '#2b2b2b', 0.15, 0.25],
    ] as const) {
      const xml = read(`apps/jetbrains/src/main/resources/colorSchemes/${scheme}.xml`);
      const failed = STATUS_COLORS.failed.fill;
      const running = STATUS_COLORS.running.fill;
      expect(option(xml, 'PIWI_FAILING_TEST', 'BACKGROUND'), scheme).toBe(blend(failed, ground, faint));
      expect(option(xml, 'PIWI_FAILING_TEST', 'ERROR_STRIPE_COLOR'), scheme).toBe(blend(failed, ground, 0.5));
      expect(option(xml, 'PIWI_FAILING_LINE', 'BACKGROUND'), scheme).toBe(blend(failed, ground, strong));
      expect(option(xml, 'PIWI_FAILING_LINE', 'ERROR_STRIPE_COLOR'), scheme).toBe(failed.slice(1));
      expect(option(xml, 'PIWI_RECORDING_BLOCK', 'BACKGROUND'), scheme).toBe(blend(running, ground, faint));
      expect(option(xml, 'PIWI_RECORDING_BLOCK', 'ERROR_STRIPE_COLOR'), scheme).toBe(running.slice(1));
    }
  });
});
