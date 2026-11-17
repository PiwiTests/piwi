import { describe, expect, it } from 'vitest';
import type { HubPresence } from '@piwitests/core/run-hub';
import { presenceLine } from '@piwitests/run-model/presence';
import { loadRunSpeaker } from '@piwitests/run-model/speakers';
import { RUN_WORDS_EN, englishRunSpeaker, type RunWordKey } from '@piwitests/run-model/words';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  it('count as the run model’s do in English, and in the plural form of the Runs window’s language', () => {
    for (const count of [1, 2, 1200]) {
      expect(runsSpeaker.count('runs_progressEndedAtStop', count)).toBe(
        englishRunSpeaker.count('runs_progressEndedAtStop', count),
      );
    }
    expect(runsSpeaker.count('runs_progress', 9, { done: '3' })).toBe(
      englishRunSpeaker.count('runs_progress', 9, { done: '3' }),
    );
    setBrowserLanguage('fr');
    expect(runsSpeaker.count('runs_progressEndedAtStop', 2)).toBe('2 terminés à un arrêt');
    expect(runsSpeaker.count('runs_progressEndedAtStop', 1)).toBe('1 terminé à un arrêt');
  });

  it('are said in the Runs window’s language, an editor by its own name', () => {
    const desktop: HubPresence = { kind: 'desktop', name: 'the desktop app' };
    const code: HubPresence = { kind: 'editor', name: 'Visual Studio Code' };
    setBrowserLanguage('de');
    expect(presenceLine([desktop, code], runsSpeaker)).toBe('Auch geöffnet in der Desktop-App und Visual Studio Code');
  });

  it.each(LANGUAGES.filter((code) => code !== 'en'))(
    'are the %s catalog’s in the run model’s copy for surfaces without the catalogs (`npm run run-model:words`)',
    (code) => {
      const file = path.resolve(import.meta.dirname, '../../../../packages/run-model/src/words', `${code}.json`);
      const copy = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      const catalog = readCatalog(code);
      const plural = /_(zero|one|two|few|many|other)$/;
      const expected = Object.fromEntries(
        Object.entries(catalog)
          .filter(
            ([key]) =>
              keys.includes(key as RunWordKey) || keys.includes(`${key.replace(plural, '')}_other` as RunWordKey),
          )
          .map(([key, entry]) => [key, entry.message]),
      );
      expect(copy).toEqual(expected);
    },
  );

  it('are said in a surface’s own language by the run model’s copy, as the Runs window says them', async () => {
    setBrowserLanguage('fr');
    const french = await loadRunSpeaker('fr');
    for (const count of [1, 2, 1200]) {
      expect(french.count('runs_progressEndedAtStop', count)).toBe(
        runsSpeaker.count('runs_progressEndedAtStop', count),
      );
    }
    expect(french.say('runs_failedAt', { place: 'cart.spec.ts:12' })).toBe(
      runsSpeaker.say('runs_failedAt', { place: 'cart.spec.ts:12' }),
    );
  });
});
