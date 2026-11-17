import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeCatalogs, type Catalog } from '../../../shared/i18n-catalogs';
import { uiSourceFiles, uiTextFindings } from '../../../shared/ui-text-scan';

/**
 * The layer's catalogs (`locales/<code>.json`), in Piwi Picker's shape and held to its rules, and the scan that keeps
 * the layer's texts in them.
 */

const root = path.resolve(import.meta.dirname, '..');
const localesDir = path.join(root, 'locales');

const catalogs: Record<string, Catalog> = Object.fromEntries(
  readdirSync(localesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => [name.slice(0, -'.json'.length), JSON.parse(readFileSync(path.join(localesDir, name), 'utf8'))]),
);

describeCatalogs({ name: "The run layer's catalogs", catalogs, surfaces: ['runui'] });

describe('no text written straight into the layer', () => {
  it.each(uiSourceFiles(root, 'app'))('%s takes its texts from the catalogs', (file) => {
    expect(uiTextFindings(path.join(root, file))).toEqual([]);
  });
});
