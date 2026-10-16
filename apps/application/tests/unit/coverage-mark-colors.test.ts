import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COVERAGE_MARK_COLORS } from '@piwitests/core/coverage';

/**
 * The coverage marks have one pair of colors in the dashboard and in the editors: the `COVERAGE_MARK_COLORS` of
 * `@piwitests/core/coverage`, restated by the dashboard's tokens, the VS Code extension's color defaults and the
 * JetBrains plugin's color schemes, none of which can import it.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path: string) => readFileSync(`${REPO_ROOT}/${path}`, 'utf8');
const { light, dark } = COVERAGE_MARK_COLORS;

describe('the coverage mark colors', () => {
  test('are the dashboard’s tokens, light and dark', () => {
    const css = read('apps/application/app/assets/css/main.css');
    const theme = css.slice(css.indexOf('@theme static'), css.indexOf('}', css.indexOf('--color-coverage-run')));
    const darkBlock = css.slice(css.indexOf('.dark {'), css.indexOf('}', css.indexOf('.dark {')));
    expect(theme).toContain(`--color-coverage-run: ${light.run};`);
    expect(theme).toContain(`--color-coverage-not-run: ${light.notRun};`);
    expect(darkBlock).toContain(`--color-coverage-run: ${dark.run};`);
    expect(darkBlock).toContain(`--color-coverage-not-run: ${dark.notRun};`);
  });

  test('are the VS Code extension’s defaults, its high contrast themes included', () => {
    const colors = (
      JSON.parse(read('apps/vscode/package.json')) as {
        contributes: { colors: Array<{ id: string; defaults: Record<string, string> }> };
      }
    ).contributes.colors;
    const defaults = (id: string) => colors.find((c) => c.id === id)?.defaults;
    expect(defaults('piwi.coverageRunBorder')).toEqual({
      dark: dark.run,
      light: light.run,
      highContrast: dark.run,
      highContrastLight: light.run,
    });
    expect(defaults('piwi.coverageNotRunBorder')).toEqual({
      dark: dark.notRun,
      light: light.notRun,
      highContrast: dark.notRun,
      highContrastLight: light.notRun,
    });
  });

  test('are the JetBrains color schemes’ marks, Default light and Darcula dark', () => {
    const stripe = (scheme: string, key: string) => {
      const xml = read(`apps/jetbrains/src/main/resources/colorSchemes/${scheme}.xml`);
      const option = xml.slice(xml.indexOf(`<option name="${key}">`), xml.indexOf('</option>', xml.indexOf(key)));
      return `#${/name="ERROR_STRIPE_COLOR" value="([0-9a-f]{6})"/.exec(option)?.[1]}`;
    };
    expect(stripe('PiwiDefault', 'PIWI_COVERAGE_RUN')).toBe(light.run);
    expect(stripe('PiwiDefault', 'PIWI_COVERAGE_NOT_RUN')).toBe(light.notRun);
    expect(stripe('PiwiDarcula', 'PIWI_COVERAGE_RUN')).toBe(dark.run);
    expect(stripe('PiwiDarcula', 'PIWI_COVERAGE_NOT_RUN')).toBe(dark.notRun);
  });
});
