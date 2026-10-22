import { describe, it, expect } from 'vitest';
import {
  copyModeLabel,
  copyModeMethod,
  renderCopyMode,
  VALUE_PLACEHOLDER,
  type ElementFacts,
} from '../../src/shared/copy-modes.js';
import type { RankedLocator } from '@piwitests/picker-dom';

const locator: RankedLocator = {
  locator: `getByRole('button', { name: 'Pay now' })`,
  method: 'getByRole',
  args: { role: 'button', name: 'Pay now' },
  score: 90,
};

describe('renderCopyMode', () => {
  it('renders the bare locator prefixed with page.', () => {
    expect(renderCopyMode(locator, 'bare')).toBe(`page.getByRole('button', { name: 'Pay now' })`);
  });

  it('renders a full click action line', () => {
    expect(renderCopyMode(locator, 'action')).toBe(`await page.getByRole('button', { name: 'Pay now' }).click();`);
  });

  it('renders a visibility assertion skeleton', () => {
    expect(renderCopyMode(locator, 'expect')).toBe(
      `await expect(page.getByRole('button', { name: 'Pay now' })).toBeVisible();`,
    );
  });
});

describe('renderCopyMode with the element facts', () => {
  const field = { locator: `getByLabel('Email')` };
  const visible = { method: 'toBeVisible' } as const;

  it('fills a text field with what it holds, and a placeholder when it holds nothing or a secret', () => {
    expect(renderCopyMode(field, 'action', { action: { method: 'fill', value: "it's me" }, assertion: visible })).toBe(
      `await page.getByLabel('Email').fill('it\\'s me');`,
    );
    expect(renderCopyMode(field, 'action', { action: { method: 'fill', value: null }, assertion: visible })).toBe(
      `await page.getByLabel('Email').fill('${VALUE_PLACEHOLDER}');`,
    );
  });

  it('checks a box and selects an option, one value or several', () => {
    const box = { locator: `getByRole('checkbox', { name: 'Remember me' })` };
    expect(renderCopyMode(box, 'action', { action: { method: 'check' }, assertion: visible })).toBe(
      `await page.getByRole('checkbox', { name: 'Remember me' }).check();`,
    );
    const select = { locator: `getByLabel('Size')` };
    const facts = (values: string[]): ElementFacts => ({
      action: { method: 'selectOption', values },
      assertion: visible,
    });
    expect(renderCopyMode(select, 'action', facts(['m']))).toBe(`await page.getByLabel('Size').selectOption('m');`);
    expect(renderCopyMode(select, 'action', facts(['m', 'l']))).toBe(
      `await page.getByLabel('Size').selectOption(['m', 'l']);`,
    );
    expect(renderCopyMode(select, 'action', facts([]))).toBe(
      `await page.getByLabel('Size').selectOption('${VALUE_PLACEHOLDER}');`,
    );
  });

  it("asserts the element's top suggestion", () => {
    const cases: Array<[ElementFacts['assertion'], string]> = [
      [{ method: 'toHaveText', value: 'Pay now' }, `toHaveText('Pay now')`],
      [{ method: 'toHaveValue', value: 'a@b.c' }, `toHaveValue('a@b.c')`],
      [{ method: 'toHaveValues', values: ['a', 'b'] }, `toHaveValues(['a', 'b'])`],
      [{ method: 'toContainText', value: 'Free shipping' }, `toContainText('Free shipping')`],
      [{ method: 'toHaveAccessibleName', value: 'Pay' }, `toHaveAccessibleName('Pay')`],
      [{ method: 'toBeChecked', checked: true }, `toBeChecked()`],
      [{ method: 'toBeChecked', checked: false }, `not.toBeChecked()`],
      [{ method: 'toHaveCount', count: 3 }, `toHaveCount(3)`],
      [visible, `toBeVisible()`],
    ];
    for (const [assertion, call] of cases) {
      expect(renderCopyMode(locator, 'expect', { action: { method: 'click' }, assertion })).toBe(
        `await expect(page.getByRole('button', { name: 'Pay now' })).${call};`,
      );
    }
  });

  it('asserts the count of a locator that finds several elements', () => {
    const facts: ElementFacts = { action: { method: 'click' }, assertion: { method: 'toHaveText', value: 'Show' } };
    expect(renderCopyMode({ locator: `getByRole('button')`, count: 2 }, 'expect', facts)).toBe(
      `await expect(page.getByRole('button')).toHaveCount(2);`,
    );
    expect(renderCopyMode({ locator: `getByRole('button')`, count: 2 }, 'expect')).toBe(
      `await expect(page.getByRole('button')).toHaveCount(2);`,
    );
    expect(renderCopyMode({ locator: `getByRole('button')`, count: 1 }, 'expect', facts)).toBe(
      `await expect(page.getByRole('button')).toHaveText('Show');`,
    );
  });
});

describe('copyModeLabel', () => {
  const facts: ElementFacts = {
    action: { method: 'fill', value: 'x' },
    assertion: { method: 'toBeChecked', checked: false },
  };

  it('names the method once the element is known', () => {
    expect(copyModeLabel('bare', copyModeMethod(locator, 'bare', facts))).toBe('Locator');
    expect(copyModeLabel('action', copyModeMethod(locator, 'action', facts))).toBe('Action (fill)');
    expect(copyModeLabel('expect', copyModeMethod(locator, 'expect', facts))).toBe('Assertion (not.toBeChecked)');
  });

  it('keeps the plain label without the element', () => {
    expect(copyModeLabel('action', copyModeMethod(locator, 'action'))).toBe('Action');
    expect(copyModeLabel('expect', copyModeMethod(locator, 'expect'))).toBe('Assertion');
  });
});
