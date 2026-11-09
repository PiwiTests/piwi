import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SHIPPED_LANGUAGES, TRANSLATION_ISSUE_URL } from '../../src/shared/languages.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const localesDir = path.join(root, 'public', '_locales');
const locales = readdirSync(localesDir).sort();
const messages = (locale: string): Record<string, { message: string }> =>
  JSON.parse(readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));

/** Every `__MSG_name__` the manifest refers to. */
const manifestMessages = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]!);

describe('store listing', () => {
  it('has the default locale among its translations', () => {
    expect(locales).toContain(manifest.default_locale);
  });

  it('defines every message the manifest uses, in every language', () => {
    for (const locale of locales) {
      for (const name of manifestMessages) expect(messages(locale)[name]?.message, `${locale}: ${name}`).toBeTruthy();
    }
  });

  it('keeps the summary within 132 characters, the Chrome Web Store’s limit', () => {
    // Longer is fine for AMO (250), but the Chrome Web Store rejects the upload.
    for (const locale of locales) expect([...messages(locale).extDescription!.message].length).toBeLessThanOrEqual(132);
  });

  it('has an AMO description for every language', () => {
    // `scripts/amo-metadata.mjs` pairs each `_locales/` directory with its file.
    for (const locale of locales)
      expect(existsSync(path.join(root, 'store', `amo-description.${locale}.md`))).toBe(true);
  });

  it('keeps the AMO reviewer notes within 3,000 characters, AMO’s limit for approval_notes', () => {
    // `scripts/amo-metadata.mjs` sends the file trimmed; AMO rejects the whole submission over the limit.
    const notes = readFileSync(path.join(root, 'store', 'amo-reviewer-notes.md'), 'utf8').trim();
    expect([...notes].length).toBeLessThanOrEqual(3000);
  });

  it.each(SHIPPED_LANGUAGES)('says in its first paragraph whether $code is a draft', ({ code, draft }) => {
    // A draft opens with a note, in its language, and the form for translation fixes; a reviewed language has none.
    const description = readFileSync(path.join(root, 'store', `amo-description.${code}.md`), 'utf8');
    const first = description.split(/\n\s*\n/)[0]!;
    if (draft) expect(first).toContain(TRANSLATION_ISSUE_URL);
    else expect(description).not.toContain(TRANSLATION_ISSUE_URL);
  });
});
