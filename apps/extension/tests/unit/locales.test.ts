import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describeCatalogs } from '../../../../shared/i18n-catalogs.js';
import { LANGUAGES, languageTag } from '../../src/shared/i18n.js';
import { readCatalog } from './setup-i18n.js';

/**
 * The catalogs in `public/_locales/`: English is the source, and every other
 * language must match it key for key, placeholder for placeholder, with the
 * plural forms its own rules need (`describeCatalogs`, the checks Piwi Runner's
 * catalogs pass too). See `i18n/README.md`.
 */

const root = path.resolve(import.meta.dirname, '..', '..');
const locales = readdirSync(path.join(root, 'public', '_locales')).sort();
const english = readCatalog('en');

describeCatalogs({
  name: "Piwi Picker's catalogs",
  catalogs: Object.fromEntries(locales.map((locale) => [locale, readCatalog(locale)])),
  // The keys of the manifest, older than the `<surface>_<name>` convention.
  unprefixed: ['extDescription', 'pickElementCommand'],
  surfaces: [
    'popup',
    'options',
    'pick',
    'console',
    'record',
    'bug',
    'replay',
    'coverage',
    'session',
    'multipick',
    'lint',
    'assert',
    'agent',
    'functions',
    'devtools',
    'view',
    'login',
    'runs',
    'stability',
    'codegen',
    'badge',
    'common',
  ],
});

describe.each(locales)('the %s catalog', (locale) => {
  it('keeps badges within 4 characters, the most a toolbar badge shows', () => {
    for (const [key, entry] of Object.entries(readCatalog(locale))) {
      if (key.startsWith('badge_')) expect([...entry.message].length, key).toBeLessThanOrEqual(4);
    }
  });
});

describe('the English catalog', () => {
  it('names its own language in common_languageTag, like every catalog', () => {
    for (const locale of locales) expect(readCatalog(locale).common_languageTag?.message).toBe(languageTag(locale));
  });
});

describe('languages', () => {
  it('ships a catalog for each language the Language setting offers, and no other', () => {
    expect([...LANGUAGES].sort()).toEqual(locales);
  });

  it('knows every key the HTML pages name', () => {
    for (const page of [
      'popup.html',
      'options.html',
      'devtools-sidebar.html',
      'devtools-panel.html',
      'login.html',
      'runs.html',
    ]) {
      const html = readFileSync(path.join(root, page), 'utf8');
      for (const match of html.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)) {
        expect(english[match[1]!], `${page}: ${match[1]}`).toBeDefined();
      }
    }
  });
});
