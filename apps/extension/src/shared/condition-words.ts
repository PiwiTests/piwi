import { formatNumber, t, tNodes } from './i18n.js';
import type { IconName } from './icons.js';
import type { NetworkThrottle, RequestCondition } from './request-conditions.js';

/** The icon of each kind of condition, in front of its line. */
export const CONDITION_ICONS: Record<RequestCondition['kind'], IconName> = {
  delay: 'clock',
  error: 'server-error',
  abort: 'blocked',
};

/** A condition in words, its request (the method and the pattern) given as text or as a node that sets them apart. */
export function conditionWords(condition: RequestCondition, request: Node | string): Array<Node | string> {
  switch (condition.kind) {
    case 'delay':
      return tNodes('devtools_conditionDelay', { request, seconds: formatNumber(condition.delayMs / 1000) });
    case 'error':
      return tNodes('devtools_conditionError', { request });
    case 'abort':
      return tNodes('devtools_conditionAbort', { request });
  }
}

/** A condition in words, as the banner, the Piwi panel and the replay list it. */
export function conditionText(condition: RequestCondition): string {
  return conditionWords(condition, `${condition.method} ${condition.pattern}`).join('');
}

/** A whole-page network condition in words: "The whole page on slow 3G", "The whole page offline". */
export function throttleText(throttle: NetworkThrottle): string {
  switch (throttle) {
    case 'fast-3g':
      return t('devtools_throttleFast3g');
    case 'slow-3g':
      return t('devtools_throttleSlow3g');
    case 'offline':
      return t('devtools_throttleOffline');
  }
}

/** The CPU slowed down, in words: "The CPU 4 times slower". */
export function cpuText(rate: number): string {
  return t('devtools_cpuSlower', { rate: formatNumber(rate) });
}
