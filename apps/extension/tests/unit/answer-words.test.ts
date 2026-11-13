import { describe, expect, it } from 'vitest';
import { HUB_ANSWER_CODES } from '@piwitests/core/run-hub';
import { LANGUAGES } from '../../src/shared/i18n.js';
import { ANSWER_KEYS } from '../../src/shared/runs.js';
import { readCatalog } from './setup-i18n.js';

/**
 * The Runs window says a hub's answer that carries a code in its own words (`ANSWER_KEYS`), under a key every catalog
 * holds. The editor service's tests hold its sentences to the English catalog.
 */
describe('the words of a hub’s answers', () => {
  it('name a key for every code', () => {
    expect(Object.keys(ANSWER_KEYS).sort()).toEqual([...HUB_ANSWER_CODES].sort());
  });

  it.each(LANGUAGES)('are keys of the %s catalog, Share live’s naming the instance', (code) => {
    const catalog = readCatalog(code);
    for (const key of Object.values(ANSWER_KEYS)) expect(catalog[key], `${code}: ${key}`).toBeDefined();
    for (const key of [ANSWER_KEYS['share-on'], ANSWER_KEYS['share-off']]) {
      expect(Object.keys(catalog[key]?.placeholders ?? {}), `${code}: ${key}`).toEqual(['instance']);
    }
  });
});
