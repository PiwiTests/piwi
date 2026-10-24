import { describe, expect, test } from 'vitest';
import { declaredNamesAt, pageCandidates, placementBefore, recordingPlacement } from '../src/recorder/page-candidates';

const file = (...lines: string[]) => lines.join('\n');
/** The 0-based line holding `marker` (a comment such as `// here`), for a caret placed on it. */
const lineOf = (text: string, marker: string) => text.split(/\r?\n/).findIndex((l) => l.includes(marker));
const expressions = (text: string, line: number) => pageCandidates(text, line).candidates.map((c) => c.expression);

const SPEC = file(
  "import { test, expect } from '@playwright/test';",
  '',
  "test('pays', async ({ page }) => {",
  "  await page.goto('/cart');",
  '',
  '});',
  '',
  "test('signs in', async ({ page, request }) => {",
  "  await page.getByRole('button', { name: 'Sign in' }).click();",
  '});',
  '',
);

describe('pageCandidates', () => {
  test('in a test with page: the page it uses, as the test body context', () => {
    const result = pageCandidates(SPEC, 4);
    expect(result).toEqual({
      context: 'test',
      default: 'page',
      candidates: [{ expression: 'page', reason: 'used on line 4' }],
    });
  });

  test('a test with page and no call yet offers its page fixture', () => {
    const text = file("test('empty', async ({ page }) => {", '', '});');
    expect(pageCandidates(text, 1)).toEqual({
      context: 'test',
      default: 'page',
      candidates: [{ expression: 'page', reason: 'fixture of this test' }],
    });
  });

  test('with two fixtures: the receiver of the nearest page call before the caret, then the other', () => {
    const text = file(
      "test('approves', async ({ adminPage, userPage }) => {",
      "  await adminPage.goto('/admin');",
      "  await userPage.goto('/inbox');",
      "  await userPage.getByRole('button', { name: 'Request' }).click();",
      '  // here',
      "  await adminPage.getByText('Approve').click();",
      '});',
    );
    const result = pageCandidates(text, lineOf(text, '// here'));
    expect(result.context).toBe('test');
    expect(result.default).toBe('userPage');
    expect(result.candidates).toEqual([
      { expression: 'userPage', reason: 'used on line 4' },
      { expression: 'adminPage', reason: 'used on line 2' },
    ]);
  });

  test('with two fixtures and no call yet: page, then the fixtures, which may be page objects', () => {
    const text = file("test('approves', async ({ adminPage, userPage, request }) => {", '', '});');
    const result = pageCandidates(text, 1);
    expect(result.default).toBe('page');
    expect(result.candidates.map((c) => [c.expression, c.reason])).toEqual([
      ['page', "Playwright's page fixture"],
      ['adminPage', 'may be a page object'],
      ['userPage', 'may be a page object'],
    ]);
  });

  test('a renamed fixture is offered by its local name', () => {
    const text = file("test('t', async ({ adminPage: admin }) => {", "  await admin.goto('/admin');", '', '});');
    expect(pageCandidates(text, 2).default).toBe('admin');
    const unused = file("test('t', async ({ adminPage: admin }) => {", '', '});');
    expect(pageCandidates(unused, 1).candidates).toEqual([
      { expression: 'page', reason: "Playwright's page fixture" },
      { expression: 'admin', reason: 'may be a page object' },
    ]);
  });

  test('a fixture named like a page object: page first, until the test calls a page method on it', () => {
    const object = file(
      "import { test } from './fixtures';",
      "test('adds a todo', async ({ todoPage }) => {",
      "  await todoPage.addTodo('buy milk');",
      '  // here',
      '});',
      '',
    );
    expect(pageCandidates(object, lineOf(object, '// here'))).toEqual({
      context: 'test',
      default: 'page',
      candidates: [
        { expression: 'page', reason: "Playwright's page fixture" },
        { expression: 'todoPage', reason: 'may be a page object' },
      ],
    });
    expect(pageCandidates(object, 5).candidates).toEqual([
      { expression: 'page', reason: "Playwright's page fixture" },
      { expression: 'todoPage', reason: 'may be a page object' },
    ]);
    const page = file(
      "test('adds a todo', async ({ todoPage }) => {",
      "  await todoPage.goto('/todo');",
      "  await todoPage.getByRole('textbox').fill('buy milk');",
      '  // here',
      '});',
    );
    expect(pageCandidates(page, lineOf(page, '// here'))).toEqual({
      context: 'test',
      default: 'todoPage',
      candidates: [{ expression: 'todoPage', reason: 'used on line 3' }],
    });
  });

  test('a popup variable, opened from a waitForEvent promise, becomes the default once used', () => {
    const text = file(
      "test('opens the invoice', async ({ page }) => {",
      "  const popupPromise = page.waitForEvent('popup');",
      "  await page.getByRole('link', { name: 'Invoice' }).click();",
      '  const popup = await popupPromise;',
      "  await popup.getByRole('heading').isVisible();",
      '  // here',
      '});',
    );
    const result = pageCandidates(text, lineOf(text, '// here'));
    expect(result.default).toBe('popup');
    expect(result.candidates).toEqual([
      { expression: 'popup', reason: 'used on line 5' },
      { expression: 'page', reason: 'used on line 3' },
    ]);
  });

  test('a page variable not used yet is offered after the receivers, with where it was opened', () => {
    const text = file(
      "test('two tabs', async ({ page, context }) => {",
      "  await page.goto('/');",
      '  const second = await context.newPage();',
      '  const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("a")]);',
      '  let other: Page;',
      '  // here',
      '});',
    );
    const result = pageCandidates(text, lineOf(text, '// here'));
    expect(result.default).toBe('page');
    expect(result.candidates).toEqual([
      { expression: 'page', reason: 'used on line 4' },
      { expression: 'other', reason: 'declared on line 5' },
      { expression: 'popup', reason: 'opened on line 4' },
      { expression: 'second', reason: 'opened on line 3' },
    ]);
  });

  test('in a page object’s method: this.page, as a function context', () => {
    const text = file(
      "import type { Locator, Page } from '@playwright/test';",
      '',
      'export class SignInPage {',
      '  readonly email: Locator;',
      '',
      '  constructor(private readonly page: Page) {',
      "    this.email = page.getByLabel('Email');",
      '  }',
      '',
      '  async signIn() {',
      '    // here',
      '  }',
      '}',
    );
    const result = pageCandidates(text, lineOf(text, '// here'));
    expect(result).toEqual({
      context: 'function',
      default: 'this.page',
      candidates: [{ expression: 'this.page', reason: 'field of SignInPage' }],
    });
  });

  test('in a page object: the receiver used before the caret comes first, then the class fields', () => {
    const text = file(
      'export class CheckoutPage {',
      '  readonly page: Page;',
      '  readonly adminPage: Page;',
      '  constructor(page: Page, adminPage: Page) {',
      '    this.page = page;',
      '    this.adminPage = adminPage;',
      '  }',
      '  async approve() {',
      "    await this.adminPage.goto('/approve');",
      '    // here',
      '  }',
      '}',
    );
    const result = pageCandidates(text, lineOf(text, '// here'));
    expect(result.context).toBe('function');
    expect(result.candidates).toEqual([
      { expression: 'this.adminPage', reason: 'used on line 9' },
      { expression: 'this.page', reason: 'field of CheckoutPage' },
    ]);
  });

  test('a class whose constructor assigns this.page offers it', () => {
    const text = file(
      'class Cart {',
      '  constructor(page) {',
      '    this.page = page;',
      '  }',
      '  add() {',
      '    // here',
      '  }',
      '}',
    );
    expect(pageCandidates(text, lineOf(text, '// here')).default).toBe('this.page');
  });

  test('a fixture object: the member chain the test calls the page through', () => {
    const text = file(
      "test('orders', async ({ app }) => {",
      "  await app.page.goto('/orders');",
      '  await app.openOrders();',
      '',
      '});',
    );
    const result = pageCandidates(text, 3);
    expect(result.default).toBe('app.page');
    expect(result.candidates).toEqual([{ expression: 'app.page', reason: 'used on line 2' }]);
  });

  test('a page object fixture whose methods are not a page’s is not offered', () => {
    const text = file("test('t', async ({ page, cartPage }) => {", '  await cartPage.addProduct("mug");', '', '});');
    const result = pageCandidates(text, 2);
    expect(result.default).toBe('page');
    expect(result.candidates).toEqual([
      { expression: 'page', reason: 'fixture of this test' },
      { expression: 'cartPage', reason: 'may be a page object' },
    ]);
  });

  test('a page object fixture holding the page: offered through it, before its first use and between tests', () => {
    const text = file(
      "import { test, expect } from './fixtures-composed';",
      '',
      "test('sends a message', async ({ formPage }) => {",
      '',
      "  await formPage.sendMessage('mary@example.com', 'Hi');",
      "  await expect(formPage.page.locator('#result')).toHaveText('Sent!');",
      '});',
      '',
    );
    expect(pageCandidates(text, 3)).toEqual({
      context: 'test',
      default: 'formPage.page',
      candidates: [{ expression: 'formPage.page', reason: 'used on line 6' }],
    });
    expect(pageCandidates(text, 7)).toEqual({
      context: 'file',
      default: 'formPage.page',
      candidates: [
        { expression: 'formPage.page', reason: 'used on line 6' },
        { expression: 'page', reason: "Playwright's page fixture" },
      ],
    });
  });

  test('between tests, what the nearest test runs on most, named after its fixture', () => {
    const text = file(
      "test('a', async ({ adminPage: admin, userPage }) => {",
      "  await userPage.goto('/inbox');",
      "  await admin.goto('/admin');",
      "  await admin.getByText('Approve').click();",
      '});',
      '',
    );
    expect(pageCandidates(text, 5).candidates.map((c) => c.expression)).toEqual(['adminPage', 'userPage', 'page']);
  });

  test('a locator variable is not a page', () => {
    const text = file(
      "test('t', async ({ page }) => {",
      "  const form = page.locator('form');",
      "  await form.getByRole('button').click();",
      "  await form.fill('x');",
      '',
      '});',
    );
    expect(expressions(text, 4)).toEqual(['page']);
  });

  test('a property named like a page method is not a call to it', () => {
    const text = file(
      "test('t', async ({ page, request }) => {",
      "  const report = await (await request.get('/api/report')).json();",
      "  expect(report.title).toBe('Weekly');",
      '  expect(report.content.length).toBe(3);',
      "  expect(await page.title()).toBe('Reports');",
      '',
      '});',
    );
    expect(pageCandidates(text, 5).candidates).toEqual([{ expression: 'page', reason: 'used on line 5' }]);
  });

  test('a parameter typed as another Playwright object is not a page, whatever the function returns', () => {
    const text = file('async function pageWithScript(context: BrowserContext): Promise<Page> {', '  // here', '}');
    expect(pageCandidates(text, 1)).toEqual({
      context: 'function',
      default: 'page',
      candidates: [{ expression: 'page', reason: "Playwright's page fixture" }],
    });
  });

  test('between tests: a file context, with the fixtures of the tests around it', () => {
    const text = file(
      "test('a', async ({ adminPage }) => {",
      "  await adminPage.goto('/');",
      '});',
      '',
      "test('b', async ({ page }) => {});",
    );
    const result = pageCandidates(text, 3);
    expect(result.context).toBe('file');
    expect(result.default).toBe('adminPage');
    expect(result.candidates).toEqual([
      { expression: 'adminPage', reason: 'used on line 2' },
      { expression: 'page', reason: 'fixture in this file' },
    ]);
  });

  test('on the closing line of a test the block goes after it: between tests', () => {
    expect(pageCandidates(SPEC, 5).context).toBe('file');
    expect(pageCandidates(SPEC, 2).context).toBe('test');
  });

  test('at the top of the file: page', () => {
    expect(pageCandidates(SPEC, 0)).toEqual({
      context: 'file',
      default: 'page',
      candidates: [{ expression: 'page', reason: 'used on line 4' }],
    });
    expect(pageCandidates('', 0)).toEqual({
      context: 'file',
      default: 'page',
      candidates: [{ expression: 'page', reason: "Playwright's page fixture" }],
    });
  });

  test('inside a test.describe, between its tests', () => {
    const text = file(
      "test.describe('checkout', () => {",
      '  test.beforeEach(async ({ page }) => {',
      "    await page.goto('/checkout');",
      '  });',
      '',
      "  test('pays', async ({ page }) => {",
      '    // inside',
      '  });',
      '});',
    );
    expect(pageCandidates(text, 4)).toMatchObject({ context: 'file', default: 'page' });
    expect(pageCandidates(text, lineOf(text, '// inside'))).toMatchObject({ context: 'test', default: 'page' });
    // A hook's body counts as a test's.
    expect(pageCandidates(text, 2).context).toBe('test');
  });

  test('a module-level page from beforeAll is offered in a test that uses it', () => {
    const text = file(
      'let page: Page;',
      'test.beforeAll(async ({ browser }) => {',
      '  page = await browser.newPage();',
      '});',
      "test('a', async () => {",
      "  await page.goto('/');",
      '',
      '});',
    );
    expect(pageCandidates(text, 6)).toMatchObject({ context: 'test', default: 'page' });
  });

  test('in a helper function: its Page parameter', () => {
    const text = file(
      "import type { Page } from '@playwright/test';",
      'export async function signIn(target: Page, email: string) {',
      '  // here',
      '}',
    );
    expect(pageCandidates(text, 2)).toEqual({
      context: 'function',
      default: 'target',
      candidates: [{ expression: 'target', reason: 'declared on line 2' }],
    });
  });

  test('between the methods of a page object: a class context, with the class’s page fields', () => {
    const text = file(
      "import type { Page } from '@playwright/test';",
      'export class SignInPage {',
      '  constructor(readonly page: Page) {}',
      '',
      '  async open() {',
      "    await this.page.goto('/login');",
      '  }',
      '',
      '  async signIn() {',
      '    // in a method',
      '  }',
      '}',
    );
    expect(pageCandidates(text, 3)).toEqual({
      context: 'class',
      default: 'this.page',
      candidates: [{ expression: 'this.page', reason: 'field of SignInPage' }],
    });
    expect(pageCandidates(text, 7).context).toBe('class');
    expect(pageCandidates(text, lineOf(text, '// in a method'))).toMatchObject({
      context: 'function',
      default: 'this.page',
    });
    // On a method's opening line the block goes on a new line inside its body.
    expect(pageCandidates(text, lineOf(text, 'async signIn')).context).toBe('function');
  });

  test('in a function: its body, whatever kind of function; a describe or step callback is the code around it', () => {
    const text = file(
      "import { test } from '@playwright/test';",
      'async function login(page) {',
      '  // in login',
      '}',
      'const helpers = {',
      '  async logout(page: Page) {',
      '    // in logout',
      '  },',
      '};',
      "test.describe.serial('checkout', () => {",
      '  // in describe',
      "  test('pays', async ({ page }) => {",
      "    await test.step('fills the card', async () => {",
      '      // in step',
      '    });',
      '    [1, 2].forEach(async (n) => {',
      '      // in callback',
      '    });',
      '  });',
      '});',
    );
    const at = (marker: string) => pageCandidates(text, lineOf(text, marker));
    expect(at('// in login')).toMatchObject({ context: 'function', default: 'page' });
    expect(at('// in logout')).toMatchObject({ context: 'function', default: 'page' });
    expect(at('// in describe').context).toBe('file');
    expect(at('// in step')).toMatchObject({ context: 'test', default: 'page' });
    expect(at('// in callback').context).toBe('function');
  });

  test('a test called through another name: a fixture test, a renamed import, a name from a fixtures module', () => {
    const extended = file(
      "import { test as base } from '@playwright/test';",
      'const adminTest = base.extend<{ adminPage: Page }>({});',
      "adminTest('opens settings', async ({ adminPage }) => {",
      "  await adminPage.goto('/settings');",
      '  ',
      '});',
      'adminTest.beforeEach(async ({ adminPage }) => {',
      "  await adminPage.goto('/');",
      '  ',
      '});',
    );
    expect(pageCandidates(extended, 4)).toMatchObject({ context: 'test', default: 'adminPage' });
    expect(pageCandidates(extended, 8)).toMatchObject({ context: 'test', default: 'adminPage' });
    const renamed = file(
      "import { test as setup } from '@playwright/test';",
      "setup('authenticate', async ({ page }) => {",
      '  ',
      '});',
    );
    expect(pageCandidates(renamed, 2)).toMatchObject({ context: 'test', default: 'page' });
    const imported = file(
      "import { shopTest } from './fixtures';",
      "shopTest.describe('cart', () => {",
      "  shopTest('adds', async ({ shopPage, page }) => {",
      '    ',
      '  });',
      '  ',
      '});',
    );
    expect(pageCandidates(imported, 3).context).toBe('test');
    expect(pageCandidates(imported, 5).context).toBe('file');
    // A call with a title and a callback that takes no fixtures is not a test.
    const helper = file(
      'function withRetries(name: string, fn: () => Promise<void>) {}',
      "withRetries('x', async () => {",
      '  ',
      '});',
    );
    expect(pageCandidates(helper, 2).context).toBe('function');
  });

  test('with CRLF line endings', () => {
    const text = SPEC.replace(/\n/g, '\r\n');
    expect(pageCandidates(text, 4)).toMatchObject({ context: 'test', default: 'page' });
    expect(pageCandidates(text, 5).context).toBe('file');
  });

  test('code inside strings, template literals, regular expressions and comments does not count', () => {
    const text = file(
      "test('a ) { in the title', async ({ page, userPage }) => {",
      '  const s = "adminPage.goto(\'/\') }";',
      '  const t = `${userPage.url()} } adminPage.goto(`;',
      "  // adminPage.goto('/');",
      "  /* adminPage.goto('/') } */",
      '  await expect(page).toHaveURL(/\\/a(?:[?#]|$)\\)}/);',
      '  // here',
      '});',
    );
    const result = pageCandidates(text, lineOf(text, '// here'));
    expect(result.context).toBe('test');
    expect(result.candidates).toEqual([
      { expression: 'page', reason: 'used on line 6' },
      { expression: 'userPage', reason: 'may be a page object' },
    ]);
  });

  test('a page of another test is not offered', () => {
    const text = file(
      "test('a', async ({ adminPage }) => {",
      "  await adminPage.goto('/');",
      '});',
      "test('b', async ({ page }) => {",
      '',
      '});',
    );
    expect(expressions(text, 4)).toEqual(['page']);
  });
});

describe('declaredNamesAt', () => {
  test('the parameters and declarations around the caret, before it, out to the top of the file', () => {
    const text = file(
      "import { SignInPage } from './pages/sign-in.page';",
      'const base = 1;',
      "test('signs in', async ({ page, cartPage: cart }) => {",
      '  const signInPage = new SignInPage(page);',
      '  if (base) {',
      '    const hidden = 2;',
      '  }',
      '',
      '  const later = 3;',
      '});',
      'function other(user) {}',
    );
    expect([...declaredNamesAt(text, 7)].sort()).toEqual(['base', 'cart', 'page', 'signInPage']);
    expect([...declaredNamesAt(text, 0)]).toEqual([]);
  });
});

describe('recordingPlacement', () => {
  test('a blank caret line takes the block; a line with text gets a new line after it', () => {
    expect(recordingPlacement(SPEC, 4, 'steps')).toEqual({ line: 4, newLine: false, indent: '  ' });
    expect(recordingPlacement(SPEC, 3, 'steps')).toEqual({ line: 4, newLine: true, indent: '  ' });
  });

  test('a new test between tests goes at the top-level indentation', () => {
    expect(recordingPlacement(SPEC, 6, 'test')).toEqual({ line: 6, newLine: false, indent: '' });
    expect(recordingPlacement(SPEC, 5, 'test')).toEqual({ line: 6, newLine: true, indent: '' });
  });

  test('a new test inside a test.describe follows the tests around it', () => {
    const text = file(
      "test.describe('checkout', () => {",
      "    test('pays', async ({ page }) => {",
      '    });',
      '',
      '});',
    );
    expect(recordingPlacement(text, 3, 'test')).toEqual({ line: 3, newLine: false, indent: '    ' });
  });

  test('an empty describe or test body takes its opening line’s indentation plus the file’s step', () => {
    const fourSpaces = file(
      'function helper() {',
      '    return 1;',
      '}',
      "test.describe('empty', () => {",
      "    test('t', async ({ page }) => {",
      '    });',
      '});',
    );
    expect(recordingPlacement(fourSpaces, 4, 'steps')).toEqual({ line: 5, newLine: true, indent: '        ' });
    const tabs = file("test('t', async ({ page }) => {", '\tawait page.goto("/");', '});', "test('u', () => {", '});');
    expect(recordingPlacement(tabs, 3, 'steps')).toEqual({ line: 4, newLine: true, indent: '\t' });
  });

  test('a body’s first lines set the indentation, past continuation lines and strings', () => {
    const text = file(
      "test('t', async ({ page }) => {",
      '   await page',
      "       .goto('/');",
      '   const s = `',
      'text',
      '`;',
      '',
      '});',
    );
    expect(recordingPlacement(text, 6, 'steps')).toEqual({ line: 6, newLine: false, indent: '   ' });
  });

  test('a page object’s method body', () => {
    const text = file('class A {', '  async go() {', '    await this.page.goto("/");', '  }', '}');
    expect(recordingPlacement(text, 2, 'steps')).toEqual({ line: 3, newLine: true, indent: '    ' });
  });

  test('with CRLF line endings', () => {
    expect(recordingPlacement(SPEC.replace(/\n/g, '\r\n'), 3, 'steps')).toEqual({
      line: 4,
      newLine: true,
      indent: '  ',
    });
  });

  test('a new file starts at its first line', () => {
    expect(recordingPlacement('', 0, 'file')).toEqual({ line: 0, newLine: false, indent: '' });
  });

  test('a caret past the end of the file stays on its last line', () => {
    expect(recordingPlacement(SPEC, 99, 'test')).toEqual({
      line: SPEC.split('\n').length - 1,
      newLine: false,
      indent: '',
    });
  });

  test('a caret inside the brackets of a statement puts the block after the statement', () => {
    const text = file(
      "test('t', async ({ page }) => {",
      '  await expect(',
      "    page.getByRole('heading', {",
      "      name: 'Cart',",
      '    }),',
      '  ).toBeVisible();',
      "  await page.goto('/');",
      '});',
    );
    for (const line of [1, 2, 3, 4, 5]) {
      expect(recordingPlacement(text, line, 'steps')).toEqual({ line: 6, newLine: true, indent: '  ' });
    }
    expect(pageCandidates(text, 2)).toMatchObject({ context: 'test', default: 'page' });
    const array = file("test('t', async ({ page }) => {", '  const items = [', "    'a',", '  ];', '});');
    expect(recordingPlacement(array, 2, 'steps')).toEqual({ line: 4, newLine: true, indent: '  ' });
    expect(declaredNamesAt(array, 2).has('items')).toBe(true);
    // A blank line inside the brackets too.
    const blank = file("test('t', async ({ page }) => {", '  await page.goto(', '', "    '/',", '  );', '});');
    expect(recordingPlacement(blank, 2, 'steps')).toEqual({ line: 5, newLine: true, indent: '  ' });
  });

  test('a caret inside a bracket the file never closes is refused', () => {
    const text = file("test('t', async ({ page }) => {", '  await expect(', "    page.getByRole('heading')", '});');
    expect(recordingPlacement(text, 2, 'steps')).toEqual({
      refusal:
        'The cursor is inside a ( opened on line 2 and not closed: close it, or put the cursor after the statement.',
    });
    expect(recordingPlacement("test('t', async ({ page }) => {\n  const items = [\n    'a',", 2, 'steps')).toEqual({
      refusal:
        'The cursor is inside a [ opened on line 2 and not closed: close it, or put the cursor after the statement.',
    });
  });
});

describe('placementBefore', () => {
  const text = [
    "test('pays', async ({ page }) => {",
    "  await page.goto('/cart');",
    '  await page',
    "    .getByRole('button', { name: 'Pay' })",
    '    .click();',
    '  await expect(',
    "    page.getByText('Paid'),",
    '  ).toBeVisible();',
    '  await page.pause();',
    '});',
  ].join('\n');

  test('goes above the statement a test is paused before, as indented', () => {
    expect(placementBefore(text, 1)).toEqual({ line: 1, newLine: true, indent: '  ' });
    expect(placementBefore(text, 8)).toEqual({ line: 8, newLine: true, indent: '  ' });
  });

  test('goes above the first line of a statement broken over lines', () => {
    // The click of a chain broken over lines, paused at its call.
    expect(placementBefore(text, 4)).toEqual({ line: 2, newLine: true, indent: '  ' });
    // A line inside the brackets of a multi-line `expect(`.
    expect(placementBefore(text, 6)).toEqual({ line: 5, newLine: true, indent: '  ' });
  });

  test('goes above an assignment or an expression broken after an operator, not above the statement before', () => {
    const broken = [
      "test('reads', async ({ page }) => {",
      "  await page.goto('/cart');",
      '  const total =',
      "    await page.getByTestId('total').textContent();",
      '  const paid = ready &&',
      "    (await page.getByRole('button', { name: 'Pay' }).isEnabled());",
      '  count--',
      "  await page.getByRole('button', { name: 'Pay' }).click();",
      '  // note: paid by card',
      "  await page.getByText('Paid').waitFor();",
      '});',
    ].join('\n');
    expect(placementBefore(broken, 3)).toEqual({ line: 2, newLine: true, indent: '  ' });
    expect(placementBefore(broken, 5)).toEqual({ line: 4, newLine: true, indent: '  ' });
    expect(placementBefore(broken, 7)).toEqual({ line: 7, newLine: true, indent: '  ' });
    expect(placementBefore(broken, 9)).toEqual({ line: 9, newLine: true, indent: '  ' });
  });
});
