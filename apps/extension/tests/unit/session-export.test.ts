import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import ts from 'typescript';
import {
  isReservedPickName,
  isValidPickName,
  pickNameProblem,
  renderFixture,
  renderMarkdown,
  renderJson,
} from '../../src/shared/session-export.js';
import type { SessionPick } from '../../src/shared/session-storage.js';

const PICKS: SessionPick[] = [
  { name: 'submitButton', locator: `getByRole('button', { name: 'Submit' })`, pageUrl: 'https://example.com/checkout' },
  { name: 'emailInput', locator: `getByTestId('email-input')`, pageUrl: 'https://example.com/checkout' },
];

describe('isValidPickName', () => {
  it('accepts a plain identifier', () => {
    expect(isValidPickName('submitButton')).toBe(true);
  });

  it('accepts leading underscore/dollar and digits after the first character', () => {
    expect(isValidPickName('_foo2')).toBe(true);
    expect(isValidPickName('$foo2')).toBe(true);
  });

  it('rejects a name starting with a digit', () => {
    expect(isValidPickName('2fast')).toBe(false);
  });

  it('rejects names with spaces or punctuation', () => {
    expect(isValidPickName('submit button')).toBe(false);
    expect(isValidPickName('submit-button')).toBe(false);
    expect(isValidPickName('')).toBe(false);
  });

  it('rejects the names the page object holds itself: its page, and constructor', () => {
    expect(isValidPickName('page')).toBe(false);
    expect(isValidPickName('constructor')).toBe(false);
    expect(isReservedPickName('page')).toBe(true);
    expect(isReservedPickName('pageTitle')).toBe(false);
    expect(isValidPickName('pageTitle')).toBe(true);
  });
});

/**
 * The page object as a test project compiles and runs it: for ES2022, where
 * class fields are the language's own, then constructed with `page`.
 */
function construct(source: string, page: unknown): Record<string, unknown> {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports: Record<string, unknown> = {};
  new Function('exports', 'require', outputText)(exports, () => ({}));
  const PickedElements = exports.PickedElements as new (page: unknown) => Record<string, unknown>;
  return new PickedElements(page);
}

describe('renderFixture', () => {
  it('renders one readonly field per pick, set from the page in the constructor', () => {
    expect(renderFixture(PICKS)).toBe(
      [
        `import type { Locator, Page } from '@playwright/test';`,
        ``,
        `export class PickedElements {`,
        `  readonly page: Page;`,
        `  readonly submitButton: Locator;`,
        `  readonly emailInput: Locator;`,
        ``,
        `  constructor(page: Page) {`,
        `    this.page = page;`,
        `    this.submitButton = page.getByRole('button', { name: 'Submit' });`,
        `    this.emailInput = page.getByTestId('email-input');`,
        `  }`,
        `}`,
      ].join('\n'),
    );
  });

  it('builds its locators from the page it is constructed with, with class fields compiled as the language’s own', () => {
    const page = {
      getByRole: (role: string, options: { name: string }) => `role ${role} ${options.name}`,
      getByTestId: (id: string) => `test id ${id}`,
    };
    const elements = construct(renderFixture(PICKS), page);
    expect(elements.page).toBe(page);
    expect(elements.submitButton).toBe('role button Submit');
    expect(elements.emailInput).toBe('test id email-input');
  });

  it('renders a class that compiles and runs for no picks, importing only Page', () => {
    const out = renderFixture([]);
    expect(out).toContain(`import type { Page } from '@playwright/test';`);
    expect(out).toContain(`export class PickedElements {`);
    const page = {};
    expect(construct(out, page).page).toBe(page);
  });
});

describe('renderMarkdown', () => {
  it('renders a table with one row per pick', () => {
    const out = renderMarkdown(PICKS);
    const lines = out.split('\n');
    expect(lines[0]).toBe('| Name | Locator | Page |');
    expect(lines[1]).toBe('|---|---|---|');
    expect(lines).toContain(
      "| submitButton | `getByRole('button', { name: 'Submit' })` | https://example.com/checkout |",
    );
    expect(lines).toContain("| emailInput | `getByTestId('email-input')` | https://example.com/checkout |");
  });

  it('escapes the | a locator or an address holds, which would end its cell', () => {
    const out = renderMarkdown([
      { name: 'either', locator: "locator('a | b')", pageUrl: 'https://example.com/x?q=a|b' },
    ]);
    expect(out.split('\n')[2]).toBe("| either | `locator('a \\| b')` | https://example.com/x?q=a\\|b |");
  });
});

describe('renderJson', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('wraps the picks with an exportedAt timestamp', () => {
    const out = JSON.parse(renderJson(PICKS));
    expect(out.exportedAt).toBe('2026-07-28T12:00:00.000Z');
    expect(out.picks).toEqual(PICKS);
  });
});

describe('pickNameProblem', () => {
  it('accepts a free identifier', () => {
    expect(pickNameProblem('totalOutput', PICKS)).toBeNull();
  });

  it('says what is wrong with a name, in the order the form checks it', () => {
    expect(pickNameProblem('', PICKS)).toBe('required');
    expect(pickNameProblem('page', PICKS)).toBe('reserved');
    expect(pickNameProblem('submit button', PICKS)).toBe('invalid');
    expect(pickNameProblem('emailInput', PICKS)).toBe('taken');
  });
});
