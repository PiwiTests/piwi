import { describe, it, expect, beforeEach } from 'vitest';
import {
  LANGUAGE_KEY,
  chosenLanguage,
  formatNumber,
  initI18n,
  languageName,
  substitutePlaceholders,
  t,
  tn,
  tNodes,
  uiLanguage,
} from '../../src/shared/i18n.js';
import { refreshLanguageChoice, storeLanguageChoice } from '../../src/background/language-choice.js';
import { readCatalog, setBrowserLanguage } from './setup-i18n.js';

function fakeLocalStorage(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (values: Record<string, unknown>) => Object.assign(store, values),
        remove: async (key: string) => {
          delete store[key];
        },
      },
    },
  };
  return store;
}

beforeEach(async () => {
  fakeLocalStorage();
  await initI18n();
});

describe('t', () => {
  it('reads the browser’s catalog and fills named placeholders', () => {
    expect(t('popup_finishRecording', { count: 3 })).toBe('Finish (3)');
    expect(t('options_cached', { functions: '12 functions', projects: '2 projects' })).toBe(
      'Catalog saved: 12 functions from 2 projects.',
    );
    setBrowserLanguage('fr', 'fr-FR');
    expect(t('options_cached', { functions: '12 fonctions', projects: '2 projets' })).toBe(
      'Catalogue enregistré : 12 fonctions de 2 projets.',
    );
  });
});

describe('tn', () => {
  it('picks the plural form with the interface language’s rules', () => {
    expect(tn('options_saved', 1)).toBe('Saved 1 line.');
    expect(tn('options_saved', 0)).toBe('Saved 0 lines.');
    expect(tn('options_saved', 1234)).toBe('Saved 1,234 lines.');
    setBrowserLanguage('fr', 'fr-FR');
    // French counts 0 with 1, and groups thousands with a narrow no-break space.
    expect(tn('options_saved', 0)).toBe('0 ligne enregistrée.');
    expect(tn('options_saved', 1234)).toBe('1 234 lignes enregistrées.');
  });

  it('counts with the rules of the catalog shown, not of an unshipped browser language', () => {
    // A Polish browser is shown the English catalog, which has no `_few`.
    setBrowserLanguage('en', 'pl');
    expect(uiLanguage()).toBe('en');
    expect(tn('options_saved', 3)).toBe('Saved 3 lines.');
  });
});

describe('uiLanguage', () => {
  it('keeps the browser’s region when its catalog is shown, else names the catalog shown', () => {
    setBrowserLanguage('fr', 'fr-CH');
    expect(uiLanguage()).toBe('fr-CH');
    setBrowserLanguage('en', 'de-DE');
    expect(uiLanguage()).toBe('en');
    expect(formatNumber(1234)).toBe('1,234');
  });
});

describe('the Options override', () => {
  it('shows the chosen catalog whatever the browser’s language', async () => {
    fakeLocalStorage({ [LANGUAGE_KEY]: { code: 'fr', messages: readCatalog('fr') } });
    await initI18n();
    expect(chosenLanguage()).toBe('fr');
    expect(uiLanguage()).toBe('fr');
    expect(t('popup_pick')).toBe('Choisir un élément');
    expect(t('popup_finishRecording', { count: 3 })).toBe('Terminer (3)');
    expect(tn('options_saved', 1)).toBe('1 ligne enregistrée.');
  });

  it('ignores a stored choice it cannot read', async () => {
    fakeLocalStorage({ [LANGUAGE_KEY]: { code: 'xx', messages: {} } });
    await initI18n();
    expect(chosenLanguage()).toBeNull();
    expect(t('popup_pick')).toBe('Pick an element');
  });

  it('is stored with its catalog, refreshed from the package, and cleared', async () => {
    const store = fakeLocalStorage();
    const read = async (code: string) => ({ popup_pick: { message: `pick in ${code}` } });
    await storeLanguageChoice('fr', read);
    expect(store[LANGUAGE_KEY]).toEqual({ code: 'fr', messages: { popup_pick: { message: 'pick in fr' } } });

    await refreshLanguageChoice(async () => ({ popup_pick: { message: 'newer' } }));
    expect(store[LANGUAGE_KEY]).toEqual({ code: 'fr', messages: { popup_pick: { message: 'newer' } } });

    // A language no longer shipped goes back to the browser's.
    store[LANGUAGE_KEY] = { code: 'xx', messages: {} };
    await refreshLanguageChoice(read);
    expect(store[LANGUAGE_KEY]).toBeUndefined();

    await storeLanguageChoice('en', read);
    await storeLanguageChoice(null, read);
    expect(store[LANGUAGE_KEY]).toBeUndefined();
  });
});

describe('substitutePlaceholders', () => {
  const entry = {
    message: 'Step $step$: $$5, $Expected$ then $found$.',
    placeholders: { expected: { content: '$1' }, found: { content: '$2' }, step: { content: '$3' } },
  };

  it('follows the browser: names are case-insensitive, $$ is a dollar, and values are not read again', () => {
    expect(substitutePlaceholders(entry, ['“$1”', '$$', '4'])).toBe('Step 4: $5, “$1” then $$.');
  });

  it('leaves a missing substitution empty', () => {
    expect(substitutePlaceholders(entry, ['a'])).toBe('Step : $5, a then .');
  });
});

describe('tNodes', () => {
  it('returns text around the nodes that fill placeholders', () => {
    const key = { cloneNode: () => key } as unknown as Node;
    expect(tNodes('popup_pickShortcut', { shortcut: key })).toEqual([key, ' picks an element without the popup']);
  });
});

describe('languageName', () => {
  it('names a language in itself, capitalized', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('fr')).toBe('Français');
    expect(languageName('pt_BR')).toBe('Português (Brasil)');
  });
});
