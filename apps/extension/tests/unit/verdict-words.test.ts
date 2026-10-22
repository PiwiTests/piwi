import { describe, it, expect } from 'vitest';
import { locatorStability, verdictWords, type VerdictInput } from '../../src/shared/verdict-words.js';
import { setBrowserLanguage } from './setup-i18n.js';

const unique = (stability: VerdictInput['stability'], rules: VerdictInput['rules'] = []): VerdictInput => ({
  verdict: 'unique',
  count: 1,
  stability,
  rules,
});

describe('verdictWords', () => {
  it('calls a locator finding the element alone by its stability', () => {
    expect(verdictWords(unique('stable'))).toEqual({
      word: 'stable',
      tone: 'good',
      explanation: 'unique · stable',
    });
    expect(verdictWords(unique('watch', ['long-text']))).toEqual({
      word: 'could break',
      tone: 'good',
      explanation: 'unique · could break: long text',
    });
    expect(verdictWords(unique('brittle', ['css-class', 'css-structure']))).toEqual({
      word: 'brittle',
      tone: 'warn',
      explanation: 'unique · brittle: CSS class, CSS structure',
    });
    expect(verdictWords({ ...unique('stable'), verdict: 'narrowed' }).word).toBe('stable');
  });

  it('warns about a locator by position, one finding others, and one the engine cannot evaluate', () => {
    expect(verdictWords({ verdict: 'position', count: 1, stability: 'brittle', rules: ['position'] })).toEqual({
      word: 'unique by position',
      tone: 'warn',
      explanation: 'unique by position · brittle: position',
    });
    expect(verdictWords({ verdict: 'ambiguous', count: 3, stability: 'stable', rules: [] })).toEqual({
      word: '3 matches',
      tone: 'warn',
      explanation: '3 matches · stable',
    });
    expect(verdictWords({ verdict: 'unchecked', count: null, stability: 'watch', rules: [] })).toMatchObject({
      word: 'not checked',
      tone: 'warn',
    });
  });

  it('speaks the interface language', () => {
    setBrowserLanguage('fr');
    try {
      expect(verdictWords(unique('brittle', ['css-class'])).word).toBe('fragile');
      expect(verdictWords({ verdict: 'ambiguous', count: 2, stability: 'stable', rules: [] }).word).toBe(
        '2 correspondances',
      );
    } finally {
      setBrowserLanguage('en');
    }
  });
});

describe('locatorStability', () => {
  it('lists each rule a locator breaks once', () => {
    expect(locatorStability(`getByRole('button', { name: 'Join now' })`)).toEqual({ stability: 'stable', rules: [] });
    const brittle = locatorStability(`locator('.btn > span').nth(2)`);
    expect(brittle.stability).toBe('brittle');
    expect(brittle.rules).toEqual(expect.arrayContaining(['position', 'css-class', 'css-structure']));
    expect(new Set(brittle.rules).size).toBe(brittle.rules.length);
  });

  it('watches a locator it cannot read', () => {
    expect(locatorStability('not a locator(')).toEqual({ stability: 'watch', rules: [] });
  });
});
