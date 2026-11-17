import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The checks every catalog set in Piwi Picker's shape passes (`apps/extension/i18n/README.md`): Piwi Picker's
 * `public/_locales/`, and Piwi Runner's and its layer's `locales/`. English is the source, and every other language
 * matches it key for key and placeholder for placeholder, with the plural forms its own rules need.
 */

/** A message as a catalog holds it. */
export interface CatalogEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

export type Catalog = Record<string, CatalogEntry>;

export interface CatalogSet {
  /** What the tests call the set: `Piwi Runner's catalogs`. */
  name: string;
  /** Each language's catalog by its code (`en`, `fr`, `pt_BR`), English among them. */
  catalogs: Record<string, Catalog>;
  /** The prefixes a key starts with, before its `_`: the surfaces that show its message. */
  surfaces: readonly string[];
  /** Keys that carry no surface prefix (Piwi Picker's manifest keys). */
  unprefixed?: readonly string[];
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** The catalogs of a folder of `<code>.json` files, by code. */
export function readCatalogs(dir: string): Record<string, Catalog> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => [name.slice(0, -'.json'.length), JSON.parse(readFileSync(path.join(dir, name), 'utf8'))]),
  );
}

/** `pt_BR` → `pt-BR`: a catalog's code as a BCP 47 tag. */
export function catalogLanguageTag(code: string): string {
  return code.replace(/_/g, '-');
}

/** The plural categories `tag` uses for counts from 0 to 999,999, plus `other`, the fallback. */
function requiredCategories(tag: string): Set<string> {
  const rules = new Intl.PluralRules(tag);
  const seen = new Set<string>(['other']);
  for (let n = 0; n < 1_000_000; n++) seen.add(rules.select(n));
  return seen;
}

function placeholderNames(entry: CatalogEntry): string[] {
  return Object.keys(entry.placeholders ?? {})
    .map((name) => name.toLowerCase())
    .sort();
}

function referencedNames(message: string): string[] {
  return [...new Set([...message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1]!.toLowerCase()))].sort();
}

/** Declares the tests of a catalog set. */
export function describeCatalogs(set: CatalogSet): void {
  const english = set.catalogs.en;
  if (!english) throw new Error(`${set.name}: no English catalog`);
  const codes = Object.keys(set.catalogs).sort();

  /** English keys ending `_other` name a counted message: `<base>_one`, `<base>_other`, … */
  const pluralBases = new Set(
    Object.keys(english)
      .filter((key) => key.endsWith('_other'))
      .map((key) => key.slice(0, -'_other'.length)),
  );
  const pluralBase = (key: string): string | null => {
    const base = key.replace(PLURAL_SUFFIX, '');
    return base !== key && pluralBases.has(base) ? base : null;
  };

  describe.each(codes)(`${set.name}: the %s catalog`, (code) => {
    const catalog = set.catalogs[code]!;
    const keys = Object.keys(catalog);

    it('names its keys with ASCII letters, digits and _, with no two differing only in case', () => {
      for (const key of keys) expect(key, key).toMatch(/^[A-Za-z0-9_]+$/);
      const lower = keys.map((key) => key.toLowerCase());
      expect(lower.filter((key, i) => lower.indexOf(key) !== i)).toEqual([]);
    });

    it('has every English message, and nothing else', () => {
      const tag = catalogLanguageTag(code);
      const categories = requiredCategories(tag);
      const allowed = new Set<string>(new Intl.PluralRules(tag).resolvedOptions().pluralCategories);
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

    it('puts the count in every form of a counted message', () => {
      for (const [key, entry] of Object.entries(catalog)) {
        if (pluralBase(key)) expect(placeholderNames(entry), key).toContain('count');
      }
    });
  });

  describe(`${set.name}: the English catalog`, () => {
    it('describes every message for the translator', () => {
      for (const [key, entry] of Object.entries(english)) expect(entry.description?.trim(), key).toBeTruthy();
    });

    it('names each key after the surface that shows it', () => {
      const pattern = new RegExp(`^(${set.surfaces.join('|')})_[A-Za-z0-9_]+$`);
      for (const key of Object.keys(english)) {
        if (!set.unprefixed?.includes(key)) expect(key, key).toMatch(pattern);
      }
    });

    it('numbers placeholders in the alphabetical order of their names, at most nine', () => {
      // Piwi Picker's `t()` passes named arguments to `chrome.i18n.getMessage` in that order.
      for (const [key, entry] of Object.entries(english)) {
        const names = Object.keys(entry.placeholders ?? {});
        expect(names.length, key).toBeLessThanOrEqual(9);
        const sorted = [...names].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
        sorted.forEach((name, i) => expect(entry.placeholders![name]!.content, `${key}: $${name}$`).toBe(`$${i + 1}`));
      }
    });
  });

  const french = set.catalogs.fr;
  if (!french) return;
  describe(`${set.name}: French typography`, () => {
    // The rules of the dashboard's French reports (`apps/application/shared/reports/sentences.fr.ts`).
    it('puts a no-break space (U+00A0) before a colon', () => {
      for (const [key, entry] of Object.entries(french)) {
        expect(entry.message, key).not.toMatch(/[^\S\u00A0]:/u);
        expect(entry.message, key).not.toMatch(/[^\s\u00A0]:(\s|$)/u);
      }
    });

    it('puts a narrow no-break space (U+202F) before ; ! and ?', () => {
      for (const [key, entry] of Object.entries(french)) {
        expect(entry.message, key).not.toMatch(/[^\S\u202F][;!?]/u);
        expect(entry.message, key).not.toMatch(/[^\s\u202F][;!?](\s|$)/u);
      }
    });
  });
}
