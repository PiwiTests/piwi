import {
  assessLocatorChain,
  type LocatorStabilityLevel,
  type LocatorStabilityRuleId,
} from '@piwitests/core/locator-stability';
import { tryParseLocatorChain } from '@piwitests/core/locator-chain';
import type { LocatorVerdict } from '../content/verified-locators.js';
import { stabilityRulesText } from './core-words.js';
import { t, tn } from './i18n.js';

/**
 * How a checked locator is judged in words, the same in the pick results and
 * in the Elements sidebar: what the engine found with it on the page, then
 * what the stability rules say of it.
 */

/** What both the sidebar's `SelectionLocator` and a stability-assessed `CheckedLocator` carry. */
export interface VerdictInput {
  verdict: LocatorVerdict;
  /** The elements it finds on the page, by the engine; null when the engine cannot evaluate it. */
  count: number | null;
  stability: LocatorStabilityLevel;
  /** The stability rules it breaks, each once. */
  rules: readonly LocatorStabilityRuleId[];
}

export type VerdictTone = 'good' | 'warn';

export interface VerdictWords {
  /** One or two words: `stable`, `brittle`, `could break`, `unique by position`, `3 matches`, `not checked`. */
  word: string;
  /** Good for a locator finding the element alone that no rule calls brittle; a warning otherwise. */
  tone: VerdictTone;
  /** The verdict and the stability with their reasons: `unique · brittle: CSS class`. */
  explanation: string;
}

/** The stability level of `locator` and the rules it breaks, each once; `watch` with no rule when it does not parse. */
export function locatorStability(locator: string): {
  stability: LocatorStabilityLevel;
  rules: LocatorStabilityRuleId[];
} {
  const chain = tryParseLocatorChain(locator);
  const assessed = chain ? assessLocatorChain(chain) : null;
  const rules: LocatorStabilityRuleId[] = [];
  for (const finding of assessed?.findings ?? []) if (!rules.includes(finding.rule)) rules.push(finding.rule);
  return { stability: assessed?.level ?? 'watch', rules };
}

/** The word, the tone and the explanation for a checked locator. */
export function verdictWords(locator: VerdictInput): VerdictWords {
  const reasons = stabilityRulesText(locator.rules, ', ');
  const stability =
    locator.stability === 'stable'
      ? t('devtools_stable')
      : locator.stability === 'brittle'
        ? t('devtools_brittle', { rules: reasons })
        : t('devtools_watch', { rules: reasons });
  switch (locator.verdict) {
    case 'unique':
    case 'narrowed':
      return {
        word:
          locator.stability === 'stable'
            ? t('devtools_stable')
            : locator.stability === 'brittle'
              ? t('common_verdictBrittle')
              : t('common_verdictWatch'),
        tone: locator.stability === 'brittle' ? 'warn' : 'good',
        explanation: `${t('devtools_unique')} · ${stability}`,
      };
    case 'position':
      return {
        word: t('devtools_byPosition'),
        tone: 'warn',
        explanation: `${t('devtools_byPosition')} · ${stability}`,
      };
    case 'ambiguous': {
      const matches = tn('devtools_matches', locator.count ?? 0);
      return { word: matches, tone: 'warn', explanation: `${matches} · ${stability}` };
    }
    case 'unchecked':
      return {
        word: t('devtools_unchecked'),
        tone: 'warn',
        explanation: `${t('devtools_unchecked')} · ${stability}`,
      };
  }
}
