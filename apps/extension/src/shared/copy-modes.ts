import { quoteJsString } from '@piwitests/core/locator-chain';
import { t, type MessageKey } from './i18n.js';
import type { IconName } from './icons.js';

export const COPY_MODES = ['bare', 'action', 'expect'] as const;
export type CopyMode = (typeof COPY_MODES)[number];

const COPY_MODE_KEYS = {
  bare: 'common_copyModeBare',
  action: 'common_copyModeAction',
  expect: 'common_copyModeExpect',
} as const satisfies Record<CopyMode, MessageKey>;

/** The icon of a copy mode's button. */
export const COPY_MODE_ICONS: Record<CopyMode, IconName> = { bare: 'code', action: 'pointer', expect: 'check-circle' };

/** What fills a `fill` or a `selectOption` whose value is empty or must not be copied. */
export const VALUE_PLACEHOLDER = 'value';

/** How a test acts on the element. A null `value` is written as {@link VALUE_PLACEHOLDER}. */
export type CopyAction =
  | { method: 'click' }
  | { method: 'check' }
  | { method: 'fill'; value: string | null }
  | { method: 'selectOption'; values: string[] };

/** What a test asserts about the element, whatever locator finds it. */
export type CopyAssertion =
  | { method: 'toHaveValue' | 'toHaveText' | 'toContainText' | 'toHaveAccessibleName'; value: string }
  | { method: 'toHaveValues'; values: string[] }
  | { method: 'toBeChecked'; checked: boolean }
  | { method: 'toHaveCount'; count: number }
  | { method: 'toBeVisible' };

/**
 * What the Action and Assertion copy modes write for an element: read from the
 * element in the page, plain data so it crosses to the DevTools page.
 */
export interface ElementFacts {
  action: CopyAction;
  /** The element's top assertion suggestion. */
  assertion: CopyAssertion;
}

/** A locator to copy; `count`, the elements it finds when known, makes the assertion a `toHaveCount` above one. */
export interface CopySource {
  locator: string;
  count?: number | null;
}

function valueArgument(values: string[]): string {
  if (values.length === 0) return quoteJsString(VALUE_PLACEHOLDER);
  if (values.length === 1) return quoteJsString(values[0]!);
  return `[${values.map((v) => quoteJsString(v)).join(', ')}]`;
}

/** `toHaveText`, or `not.toBeChecked` for an unchecked box: the call an assertion makes, as written after `expect(…).`. */
export function assertionMethod(assertion: CopyAssertion): string {
  return assertion.method === 'toBeChecked' && !assertion.checked ? 'not.toBeChecked' : assertion.method;
}

/** `await expect(page.<locator>).<matcher>(…);` for an assertion. */
export function renderAssertion(locator: string, assertion: CopyAssertion): string {
  let argument = '';
  switch (assertion.method) {
    case 'toHaveValue':
    case 'toHaveText':
    case 'toContainText':
    case 'toHaveAccessibleName':
      argument = quoteJsString(assertion.value);
      break;
    case 'toHaveValues':
      argument = `[${assertion.values.map((v) => quoteJsString(v)).join(', ')}]`;
      break;
    case 'toHaveCount':
      argument = String(assertion.count);
      break;
  }
  return `await expect(page.${locator}).${assertionMethod(assertion)}(${argument});`;
}

/** `await page.<locator>.<method>(…);` for an action. */
export function renderAction(locator: string, action: CopyAction): string {
  switch (action.method) {
    case 'click':
    case 'check':
      return `await page.${locator}.${action.method}();`;
    case 'fill':
      return `await page.${locator}.fill(${quoteJsString(action.value || VALUE_PLACEHOLDER)});`;
    case 'selectOption':
      return `await page.${locator}.selectOption(${valueArgument(action.values)});`;
  }
}

/** The assertion the Assertion mode writes: a count for a locator finding several elements, else the element's top one. */
function copyAssertion(source: CopySource, facts: ElementFacts | null | undefined): CopyAssertion | null {
  if (source.count != null && source.count > 1) return { method: 'toHaveCount', count: source.count };
  return facts?.assertion ?? null;
}

/**
 * Render a locator as source in the requested copy mode. Without `facts`, the
 * Action mode clicks and the Assertion mode checks visibility; with them, they
 * act and assert as the element calls for (`fill`, `check`, `selectOption`;
 * its top assertion).
 */
export function renderCopyMode(source: CopySource, mode: CopyMode, facts?: ElementFacts | null): string {
  switch (mode) {
    case 'bare':
      return `page.${source.locator}`;
    case 'action':
      return renderAction(source.locator, facts?.action ?? { method: 'click' });
    case 'expect':
      return renderAssertion(source.locator, copyAssertion(source, facts) ?? { method: 'toBeVisible' });
  }
}

/** The method a copy mode writes (`fill`, `toHaveText`), or null when it is the mode's default and nothing says more. */
export function copyModeMethod(source: CopySource, mode: CopyMode, facts?: ElementFacts | null): string | null {
  if (mode === 'action') return facts ? facts.action.method : null;
  if (mode === 'expect') {
    const assertion = copyAssertion(source, facts);
    return assertion ? assertionMethod(assertion) : null;
  }
  return null;
}

/** The label of a copy mode's button, in the interface language: `Action (fill)` once the method is known. */
export function copyModeLabel(mode: CopyMode, method: string | null = null): string {
  const label = t(COPY_MODE_KEYS[mode]);
  return method ? t('common_copyModeWithMethod', { mode: label, method }) : label;
}
