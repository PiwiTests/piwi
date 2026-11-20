import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeCatalogs, readCatalogs } from '../../../shared/i18n-catalogs';
import { describeUiTextScan } from '../../../shared/ui-text-scan';
import { RUN_UI_LANGUAGES } from '../app/utils/run-ui-words';

/**
 * The layer's catalogs (`locales/<code>.json`), in Piwi Picker's shape and held to its rules, and the scan that keeps
 * the layer's texts in them.
 */

const root = path.resolve(import.meta.dirname, '..');
const catalogs = readCatalogs(path.join(root, 'locales'));

describeCatalogs({ name: "The run layer's catalogs", catalogs, surfaces: ['runui'] });

describeUiTextScan('no text written straight into the layer', root, 'app');

describe('the layer’s languages', () => {
  it('are the languages of its catalogs', () => {
    expect([...RUN_UI_LANGUAGES].sort()).toEqual(Object.keys(catalogs).sort());
  });
});
