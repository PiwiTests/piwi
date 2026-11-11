import { describe, expect, it } from 'vitest';
import type { HubPresence } from '@piwitests/core/run-hub';
import { presenceLine } from '@piwitests/run-model/presence';
import { RUN_WORDS_EN, englishRunSpeaker, type RunWordKey } from '@piwitests/run-model/words';
import { LANGUAGES } from '../../src/shared/i18n.js';
import { runsSpeaker } from '../../src/shared/run-words.js';
import { readCatalog, setBrowserLanguage } from './setup-i18n.js';

/**
 * The run model's English words (`RUN_WORDS_EN`), which a surface without the catalogs says (`englishRunSpeaker`), are
 * the English catalog's: the same message, with the same placeholders, under a key every catalog holds.
 */

const keys = Object.keys(RUN_WORDS_EN) as RunWordKey[];
const placeholdersOf = (message: string) =>
  [...message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map(([, name]) => name!.toLowerCase()).sort();

describe('the run model’s words', () => {
  it('are the English catalog’s messages', () => {
    const english = readCatalog('en');
    for (const key of keys) expect(RUN_WORDS_EN[key], key).toBe(english[key]?.message);
  });

  it.each(LANGUAGES)('are keys of the %s catalog, with the same placeholders', (code) => {
    const catalog = readCatalog(code);
    for (const key of keys) {
      const entry = catalog[key];
      expect(entry, `${code}: ${key}`).toBeDefined();
      const names = Object.keys(entry?.placeholders ?? {})
        .map((name) => name.toLowerCase())
        .sort();
      expect(names, `${code}: ${key}`).toEqual(placeholdersOf(RUN_WORDS_EN[key]));
    }
  });

  it('read the same in the Runs window’s English as in the run model’s', () => {
    for (const key of keys) {
      const args = Object.fromEntries(placeholdersOf(RUN_WORDS_EN[key]).map((name) => [name, `<${name}>`]));
      expect(runsSpeaker.say(key, args), key).toBe(englishRunSpeaker.say(key, args));
    }
  });

  it('are said in the Runs window’s language, an editor by its own name', () => {
    const desktop: HubPresence = { kind: 'desktop', name: 'the desktop app' };
    const code: HubPresence = { kind: 'editor', name: 'Visual Studio Code' };
    setBrowserLanguage('de');
    expect(presenceLine([desktop, code], runsSpeaker)).toBe('Auch geöffnet in der Desktop-App und Visual Studio Code');
  });
});
