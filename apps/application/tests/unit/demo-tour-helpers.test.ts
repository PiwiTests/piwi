import { describe, expect, test } from 'vitest';
import { isTourLanguage, pickTourLanguage } from '../../app/utils/demo-tour/languages';
import {
  readTourPromptState,
  shouldAutoPrompt,
  TOUR_PROMPT_STORAGE_KEY,
  TOUR_SNOOZE_MS,
} from '../../app/utils/demo-tour/prompt-state';

describe('pickTourLanguage', () => {
  test('takes the first preferred language the tour speaks, on its primary subtag', () => {
    expect(pickTourLanguage(['fr-CA', 'en-US'])).toBe('fr');
    expect(pickTourLanguage(['pt-BR', 'de-AT', 'es'])).toBe('de');
    expect(pickTourLanguage(['en-GB', 'fr'])).toBe('en');
  });

  test('ignores case', () => {
    expect(pickTourLanguage(['ES-mx'])).toBe('es');
  });

  test('falls back to English', () => {
    expect(pickTourLanguage(['zh-CN', 'ja'])).toBe('en');
    expect(pickTourLanguage([])).toBe('en');
    expect(pickTourLanguage([''])).toBe('en');
  });
});

describe('isTourLanguage', () => {
  test('accepts the tour languages only', () => {
    expect(isTourLanguage('fr')).toBe(true);
    expect(isTourLanguage('FR')).toBe(false);
    expect(isTourLanguage('pt')).toBe(false);
    expect(isTourLanguage(null)).toBe(false);
  });
});

describe('readTourPromptState', () => {
  test('reads a stored state', () => {
    expect(TOUR_PROMPT_STORAGE_KEY).toBe('piwi-demo-tour');
    expect(readTourPromptState('{"decision":"snoozed","decidedAt":1700000000000,"language":"fr"}')).toEqual({
      decision: 'snoozed',
      decidedAt: 1700000000000,
      language: 'fr',
    });
    expect(readTourPromptState('{"language":"de"}')).toEqual({ language: 'de' });
  });

  test('is empty for nothing stored, or for what is not a state', () => {
    for (const raw of [null, '', 'not json', '[]', '"snoozed"', '42', 'null', '{']) {
      expect(readTourPromptState(raw)).toEqual({});
    }
  });

  test('drops the fields it does not recognize', () => {
    expect(readTourPromptState('{"decision":"maybe","decidedAt":"yesterday","language":"pt","extra":true}')).toEqual(
      {},
    );
    expect(readTourPromptState('{"decision":"dismissed","decidedAt":1e400}')).toEqual({ decision: 'dismissed' });
  });
});

describe('shouldAutoPrompt', () => {
  const now = 1_800_000_000_000;

  test('asks a browser that never decided', () => {
    expect(shouldAutoPrompt({}, now)).toBe(true);
    expect(shouldAutoPrompt({ language: 'fr' }, now)).toBe(true);
  });

  test('never asks again after × or a started tour', () => {
    expect(shouldAutoPrompt({ decision: 'dismissed', decidedAt: now - 365 * TOUR_SNOOZE_MS }, now)).toBe(false);
    expect(shouldAutoPrompt({ decision: 'started', decidedAt: now - 365 * TOUR_SNOOZE_MS }, now)).toBe(false);
  });

  test('asks again a day after Later', () => {
    expect(TOUR_SNOOZE_MS).toBe(24 * 60 * 60 * 1000);
    expect(shouldAutoPrompt({ decision: 'snoozed', decidedAt: now - 60_000 }, now)).toBe(false);
    expect(shouldAutoPrompt({ decision: 'snoozed', decidedAt: now - TOUR_SNOOZE_MS + 1 }, now)).toBe(false);
    expect(shouldAutoPrompt({ decision: 'snoozed', decidedAt: now - TOUR_SNOOZE_MS }, now)).toBe(true);
    expect(shouldAutoPrompt({ decision: 'snoozed', decidedAt: now - 3 * TOUR_SNOOZE_MS }, now)).toBe(true);
  });

  test('asks again after a Later with no time', () => {
    expect(shouldAutoPrompt({ decision: 'snoozed' }, now)).toBe(true);
  });
});
