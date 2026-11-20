import { describe, expect, test } from 'vitest';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import {
  ENGLISH_RUN_UI_WORDS,
  fillRunUiMessage,
  runUiTranslator,
  runUiWords,
  type RunUiRawCatalog,
} from '../app/utils/run-ui-words';

const english = {
  greet: { message: 'Hello $name$', placeholders: { name: { content: '$1' } } },
  bye: { message: 'Bye' },
  apples_one: { message: '$count$ apple', placeholders: { count: { content: '$1' } } },
  apples_other: { message: '$count$ apples', placeholders: { count: { content: '$1' } } },
} as const;

describe('fillRunUiMessage', () => {
  test('fills each placeholder by name, whatever its case, and writes $$ as $', () => {
    expect(fillRunUiMessage({ message: 'Pay $Amount$ $$ now' }, { amount: 3 })).toBe('Pay 3 $ now');
  });

  test('leaves a placeholder without a value as it is', () => {
    expect(fillRunUiMessage({ message: 'Hello $name$' })).toBe('Hello $name$');
  });
});

describe('runUiTranslator', () => {
  const french: RunUiRawCatalog = {
    greet: { message: 'Bonjour $name$' },
    apples_one: { message: '$count$ pomme' },
    apples_other: { message: '$count$ pommes' },
  };
  const translator = runUiTranslator(() => ({ language: 'fr', catalog: french }), english);

  test('reads the language’s catalog, and English for a key it lacks', () => {
    expect(translator.t('greet', { name: 'Dana' })).toBe('Bonjour Dana');
    expect(translator.t('bye')).toBe('Bye');
  });

  test('picks the plural form with the language’s rules and formats the count', () => {
    // French puts 0 with 1.
    expect(translator.tn('apples', 0)).toBe('0 pomme');
    expect(translator.tn('apples', 2)).toBe('2 pommes');
    expect(translator.tn('apples', 1500)).toBe('1 500 pommes');
  });

  test('falls back to the other form a catalog lacks', () => {
    const polish = runUiTranslator(
      () => ({ language: 'pl', catalog: { apples_other: { message: '$count$ jabłek' } } }),
      english,
    );
    expect(polish.tn('apples', 5)).toBe('5 jabłek');
  });

  test('reads its catalog again on each call', () => {
    let language = 'en';
    const switching = runUiTranslator(
      () => ({ language, catalog: language === 'fr' ? french : (english as RunUiRawCatalog) }),
      english,
    );
    expect(switching.t('greet', { name: 'Dana' })).toBe('Hello Dana');
    language = 'fr';
    expect(switching.t('greet', { name: 'Dana' })).toBe('Bonjour Dana');
  });
});

describe('the layer’s words', () => {
  test('speak English, and the run model’s words, when the host provides none', () => {
    expect(ENGLISH_RUN_UI_WORDS.language).toBe('en');
    expect(ENGLISH_RUN_UI_WORDS.t('runui_requestRun')).toBe('Run');
    expect(ENGLISH_RUN_UI_WORDS.tn('runui_tests', 3)).toBe('3 tests');
    expect(ENGLISH_RUN_UI_WORDS.say('runs_resume')).toBe('Resume');
  });

  test('write times in the locale the host gives', () => {
    const words = runUiWords(() => ({ language: 'fr', catalog: {}, run: englishRunSpeaker, timeLocale: 'fr' }));
    expect(words.time(new Date(2026, 0, 1, 15, 4, 5))).toBe('15:04:05');
  });
});
