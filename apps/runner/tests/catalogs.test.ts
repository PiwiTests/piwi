import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeCatalogs, readCatalogs } from '../../../shared/i18n-catalogs';
import { describeUiTextScan } from '../../../shared/ui-text-scan';
import { RUNNER_LANGUAGES } from '../app/utils/runner-language';

/**
 * Piwi Runner's catalogs (`locales/<code>.json`: the window's words and the shell's), in Piwi Picker's shape and held to
 * its rules, and the scan that keeps the window's texts in them.
 */

const root = path.resolve(import.meta.dirname, '..');
const catalogs = readCatalogs(path.join(root, 'locales'));

describeCatalogs({ name: "Piwi Runner's catalogs", catalogs, surfaces: ['runner', 'shell'] });

describeUiTextScan('no text written straight into the window', root, 'app');

describe('Piwi Runner’s languages', () => {
  const codes = Object.keys(catalogs).sort();

  it('are the languages of its catalogs, of the layer’s and of the run model’s words', () => {
    expect(RUNNER_LANGUAGES.map((language) => language.code).sort()).toEqual(codes);
    expect(Object.keys(readCatalogs(path.resolve(root, '../../packages/run-ui/locales'))).sort()).toEqual(codes);
    const words = readdirSync(path.resolve(root, '../../packages/run-model/src/words')).map((name) =>
      name.replace(/\.json$/, ''),
    );
    expect(['en', ...words].sort()).toEqual(codes);
  });
});
