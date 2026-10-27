import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LANGUAGES, languageTag, type RawCatalog } from '../../src/shared/i18n.js';
import { readCatalog } from './setup-i18n.js';

/**
 * The catalogs in `public/_locales/`: English is the source, and every other
 * language must match it key for key, placeholder for placeholder, with the
 * plural forms its own rules need. See `i18n/README.md`.
 */

const root = path.resolve(import.meta.dirname, '..', '..');
const locales = readdirSync(path.join(root, 'public', '_locales')).sort();
const english = readCatalog('en');

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
/** The keys of the manifest, older than the `<surface>_<name>` convention. */
const MANIFEST_KEYS = ['extDescription', 'pickElementCommand'];
const SURFACES = [
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
];

/** English keys ending `_other` name a counted message: `<base>_one`, `<base>_other`, … */
const pluralBases = new Set(
  Object.keys(english)
    .filter((key) => key.endsWith('_other'))
    .map((key) => key.slice(0, -'_other'.length)),
);

function pluralBase(key: string): string | null {
  const base = key.replace(PLURAL_SUFFIX, '');
  return base !== key && pluralBases.has(base) ? base : null;
}

/** The plural categories `lang` uses for counts from 0 to 999,999, plus `other`, the fallback. */
function requiredCategories(lang: string): Set<string> {
  const rules = new Intl.PluralRules(lang);
  const seen = new Set<string>(['other']);
  for (let n = 0; n < 1_000_000; n++) seen.add(rules.select(n));
  return seen;
}

function placeholderNames(entry: RawCatalog[string]): string[] {
  return Object.keys(entry.placeholders ?? {})
    .map((name) => name.toLowerCase())
    .sort();
}

function referencedNames(message: string): string[] {
  return [...new Set([...message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1]!.toLowerCase()))].sort();
}

describe.each(locales)('the %s catalog', (locale) => {
  const catalog = readCatalog(locale);
  const keys = Object.keys(catalog);

  it('names its keys with ASCII letters, digits and _, with no two differing only in case', () => {
    for (const key of keys) expect(key, key).toMatch(/^[A-Za-z0-9_]+$/);
    const lower = keys.map((key) => key.toLowerCase());
    expect(lower.filter((key, i) => lower.indexOf(key) !== i)).toEqual([]);
  });

  it('has every English message, and nothing else', () => {
    const categories = requiredCategories(languageTag(locale));
    const allowed = new Set<string>(new Intl.PluralRules(languageTag(locale)).resolvedOptions().pluralCategories);
    allowed.add('other');
    const expected = new Set<string>();
    for (const key of Object.keys(english)) {
      const base = pluralBase(key);
      if (base) for (const category of categories) expected.add(`${base}_${category}`);
      else expected.add(key);
    }
    const missing = [...expected].filter((key) => !(key in catalog));
    const extra = keys.filter((key) => {
      if (expected.has(key)) return false;
      const base = pluralBase(key);
      return !(base && allowed.has(key.slice(base.length + 1)));
    });
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('keeps the English order, so two catalogs compare line by line', () => {
    const order = Object.keys(english);
    const shared = keys.filter((key) => key in english);
    expect(shared).toEqual(order.filter((key) => key in catalog));
  });

  it('has the placeholders of the English message, each used, and no stray $', () => {
    for (const [key, entry] of Object.entries(catalog)) {
      const source = english[key] ?? english[`${pluralBase(key)}_other`];
      if (!source) continue;
      expect(placeholderNames(entry), key).toEqual(placeholderNames(source));
      for (const [name, value] of Object.entries(entry.placeholders ?? {})) {
        const sourceValue = Object.entries(source.placeholders ?? {}).find(
          ([n]) => n.toLowerCase() === name.toLowerCase(),
        );
        expect(value.content, `${key}: $${name}$`).toBe(sourceValue?.[1].content);
      }
      expect(referencedNames(entry.message), key).toEqual(placeholderNames(entry));
      const rest = entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, '').replace(/\$\$/g, '');
      expect(rest, `${key}: a $ that is neither $name$ nor $$`).not.toContain('$');
    }
  });

  it('writes no markup and no empty message', () => {
    for (const [key, entry] of Object.entries(catalog)) {
      expect(entry.message, key).not.toContain('<');
      expect(entry.message.trim(), key).not.toBe('');
    }
  });

  it('keeps badges within 4 characters, the most a toolbar badge shows', () => {
    for (const [key, entry] of Object.entries(catalog)) {
      if (key.startsWith('badge_')) expect([...entry.message].length, key).toBeLessThanOrEqual(4);
    }
  });

  it('puts the count in every form of a counted message', () => {
    for (const [key, entry] of Object.entries(catalog)) {
      if (pluralBase(key)) expect(placeholderNames(entry), key).toContain('count');
    }
  });
});

describe('the English catalog', () => {
  it('describes every message for the translator', () => {
    for (const [key, entry] of Object.entries(english)) expect(entry.description?.trim(), key).toBeTruthy();
  });

  it('names each key after the surface that shows it', () => {
    const pattern = new RegExp(`^(${SURFACES.join('|')})_[A-Za-z0-9_]+$`);
    for (const key of Object.keys(english)) if (!MANIFEST_KEYS.includes(key)) expect(key, key).toMatch(pattern);
  });

  it('numbers placeholders in the alphabetical order of their names, at most nine', () => {
    // `t()` passes named arguments to `chrome.i18n.getMessage` in that order.
    for (const [key, entry] of Object.entries(english)) {
      const names = Object.keys(entry.placeholders ?? {});
      expect(names.length, key).toBeLessThanOrEqual(9);
      const sorted = [...names].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
      sorted.forEach((name, i) => expect(entry.placeholders![name]!.content, `${key}: $${name}$`).toBe(`$${i + 1}`));
    }
  });

  it('names its own language in common_languageTag, like every catalog', () => {
    for (const locale of locales) expect(readCatalog(locale).common_languageTag?.message).toBe(languageTag(locale));
  });
});

describe('French typography', () => {
  // The rules of the dashboard's French reports (`apps/application/shared/reports/sentences.fr.ts`).
  const french = readCatalog('fr');

  it('puts a no-break space (U+00A0) before a colon', () => {
    for (const [key, entry] of Object.entries(french)) {
      expect(entry.message, key).not.toMatch(/[^\S ]:/u);
      expect(entry.message, key).not.toMatch(/[^\s ]:(\s|$)/u);
    }
  });

  it('puts a narrow no-break space (U+202F) before ; ! and ?', () => {
    for (const [key, entry] of Object.entries(french)) {
      expect(entry.message, key).not.toMatch(/[^\S ][;!?]/u);
      expect(entry.message, key).not.toMatch(/[^\s ][;!?](\s|$)/u);
    }
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
