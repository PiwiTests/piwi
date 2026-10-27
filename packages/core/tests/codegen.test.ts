import { describe, test, expect } from 'vitest';
import ts from 'typescript';
import { isPageExpression, pageUrlPattern, renderSpec, safeLocator } from '../src/codegen';
import { buildSession } from '../src/recording';
import type { RecordedStep, RecordedTarget } from '../src/recording';
import type { TestFunctionEntry } from '../src/function-match';

function target(overrides: Partial<RecordedTarget> = {}): RecordedTarget {
  const merged = {
    tagName: 'button',
    role: 'button',
    accessibleName: 'Log in',
    testId: null as string | null,
    text: null as string | null,
    ...overrides,
  };
  const locator = merged.testId
    ? `getByTestId('${merged.testId}')`
    : `getByRole('${merged.role}', { name: '${merged.accessibleName}' })`;
  return {
    ...merged,
    alternatives: overrides.alternatives ?? [
      { locator, method: merged.testId ? 'getByTestId' : 'getByRole', score: 90 },
    ],
  };
}

function step(overrides: Partial<RecordedStep> = {}): RecordedStep {
  return {
    action: 'click',
    target: target(),
    value: null,
    redacted: false,
    pageUrl: 'https://x.test/login',
    timestamp: 0,
    ...overrides,
  };
}

describe('renderSpec — raw mode (no catalog)', () => {
  test('writes a double click, a drag onto another element and a file choice', () => {
    const row = target({ role: 'row', accessibleName: 'Invoice 42' });
    const bin = target({ role: 'region', accessibleName: 'Archive' });
    const file = target({ tagName: 'input', role: 'button', accessibleName: 'Invoice', testId: 'invoice-file' });
    const session = buildSession(
      [
        step({ action: 'dblclick', target: row }),
        step({ action: 'dragTo', target: row, dropTarget: bin }),
        step({ action: 'setInputFiles', target: file, value: 'invoice.pdf' }),
        step({ action: 'setInputFiles', target: file, value: 'a.png\nb.png' }),
        step({ action: 'setInputFiles', target: file, value: '' }),
      ],
      0,
    );
    const { code, warnings } = renderSpec(session);
    expect(code).toContain(`  await page.getByRole('row', { name: 'Invoice 42' }).dblclick();`);
    expect(code).toContain(
      `  await page.getByRole('row', { name: 'Invoice 42' }).dragTo(page.getByRole('region', { name: 'Archive' }));`,
    );
    expect(code).toContain(`  await page.getByTestId('invoice-file').setInputFiles('invoice.pdf');`);
    expect(code).toContain(`  await page.getByTestId('invoice-file').setInputFiles(['a.png', 'b.png']);`);
    expect(code).toContain(`  await page.getByTestId('invoice-file').setInputFiles([]);`);
    expect(warnings.filter((w) => w.code === 'file-needed').map((w) => w.detail)).toEqual([
      'invoice.pdf',
      'a.png, b.png',
    ]);
  });

  test('writes a manual step as a comment, never as code, and warns about it', () => {
    const session = buildSession(
      [
        step({ action: 'click' }),
        step({
          action: 'manual',
          target: null,
          pageUrl: '',
          manual: {
            description: "Accept the banner'); process.exit(1); //\nand go on",
            location: 'tests/login.spec.ts:12',
            call: 'Click',
          },
        }),
        step({
          action: 'assert',
          pageUrl: '',
          assertion: { matcher: 'toHaveCount', expected: '3', actual: '1', negated: false, note: null },
        }),
      ],
      0,
    );
    const { code, warnings, stepLines } = renderSpec(session, { urlChecks: true });
    expect(code).toContain(
      "  // Manual step: Accept the banner'); process.exit(1); // and go on\n  //   Click at tests/login.spec.ts:12\n",
    );
    expect(code).toContain(
      "  await expect(page.getByRole('button', { name: 'Log in' })).toHaveCount(3); // recorded: '1'",
    );
    expect(code.split('\n')[stepLines[1]! - 1]).toBe(
      "  // Manual step: Accept the banner'); process.exit(1); // and go on",
    );
    expect(warnings.map((w) => w.code)).toEqual(['manual-step']);
    const output = ts.transpileModule(code, { reportDiagnostics: true });
    expect(output.diagnostics).toEqual([]);
  });

  test('writes a hover step as a hover on its locator', () => {
    const row = target({ role: 'row', accessibleName: 'Invoice 42' });
    const session = buildSession([step({ action: 'hover', target: row }), step({ action: 'click' })], 0);
    const { code } = renderSpec(session);
    expect(code).toContain(
      `  await page.getByRole('row', { name: 'Invoice 42' }).hover();\n  await page.getByRole('button', { name: 'Log in' }).click();`,
    );
  });

  test('emits an initial goto from startUrl, then one line per step', () => {
    const session = buildSession([step({ action: 'click' })], 0);
    session.startUrl = 'https://x.test/login';
    const { code } = renderSpec(session);
    expect(code).toContain(`await page.goto('https://x.test/login');`);
    expect(code).toContain(`.click();`);
    expect(code).toContain(`test('recorded flow'`);
  });

  test('a goto step in the recording is used as-is, without a duplicate leading goto', () => {
    const gotoStep = step({ action: 'goto', target: null, value: 'https://x.test/login' });
    const session = buildSession([gotoStep, step()], 0);
    const { code } = renderSpec(session);
    expect(code.match(/page\.goto\(/g)).toHaveLength(1);
  });

  test('fill emits the literal value', () => {
    const session = buildSession(
      [step({ action: 'fill', value: 'alice', target: target({ accessibleName: 'Username' }) })],
      0,
    );
    const { code } = renderSpec(session);
    expect(code).toContain(`.fill('alice');`);
  });

  test('a redacted fill emits a process.env placeholder, never the raw value', () => {
    const password = target({ role: 'textbox', tagName: 'input', accessibleName: 'Password' });
    const session = buildSession([step({ action: 'fill', value: null, redacted: true, target: password })], 0);
    const { code } = renderSpec(session);
    expect(code).toContain(`.fill(process.env.E2E_PASSWORD ?? '');`);
    expect(code).not.toContain('hunter2');
  });

  test('check/uncheck/selectOption/press render their own methods', () => {
    const session = buildSession(
      [
        step({ action: 'check' }),
        step({ action: 'uncheck' }),
        step({ action: 'selectOption', value: 'FR' }),
        step({ action: 'press', value: 'Enter' }),
      ],
      0,
    );
    const { code } = renderSpec(session);
    expect(code).toContain('.check();');
    expect(code).toContain('.uncheck();');
    expect(code).toContain(`.selectOption('FR');`);
    expect(code).toContain(`.press('Enter');`);
  });

  test('no matchedSpans are reported without a catalog', () => {
    const session = buildSession([step()], 0);
    const { matchedSpans } = renderSpec(session);
    expect(matchedSpans).toEqual([]);
  });
});

describe('renderSpec — steps that continue a test’s page', () => {
  test('leave out where the recording began: the first goto, the size then and the opening navigation', () => {
    const begun = step({ action: 'goto', target: null, value: 'https://x.test/cart', pageUrl: 'https://x.test/cart' });
    const viewports = [{ step: 0, width: 800, height: 600 }];
    const session = { ...buildSession([begun, step({ pageUrl: 'https://x.test/cart' })], 0), viewports };
    const continued = renderSpec(session, { format: 'body', continuePage: true }).code;
    expect(continued).not.toContain('goto(');
    expect(continued).not.toContain('setViewportSize');
    expect(continued).toContain(`await page.getByRole('button', { name: 'Log in' }).click();`);
    // Without the option, the recording opens where it began.
    expect(renderSpec(session, { format: 'body' }).code).toContain(`await page.goto('https://x.test/cart');`);
    // A page the steps reach later is still waited for, and a later goto still written.
    const later = buildSession(
      [
        begun,
        step({ pageUrl: 'https://x.test/cart' }),
        step({ action: 'goto', target: null, value: 'https://x.test/help', pageUrl: 'https://x.test/help' }),
      ],
      0,
    );
    expect(renderSpec(later, { format: 'body', continuePage: true }).code).toContain(
      `await page.goto('https://x.test/help');`,
    );
  });

  test('without a goto open on nothing either', () => {
    const session = buildSession([step({ pageUrl: 'https://x.test/cart' })], 0);
    expect(session.startUrl).toBe('https://x.test/cart');
    expect(renderSpec(session, { format: 'body', continuePage: true }).code).not.toContain('goto(');
  });
});

describe('renderSpec — value escaping', () => {
  test('a multi-line fill value stays on one line as an escaped literal', () => {
    const textarea = target({ role: 'textbox', tagName: 'textarea', accessibleName: 'Notes' });
    const session = buildSession([step({ action: 'fill', value: 'line one\nline two', target: textarea })], 0);
    const { code } = renderSpec(session);
    expect(code).toContain(`.fill('line one\\nline two');`);
    // The emitted line must not be split by the value it carries.
    expect(code.split('\n').filter((l) => l.includes('.fill('))).toHaveLength(1);
  });

  test('carriage returns and line/paragraph separators are escaped too', () => {
    const textarea = target({ role: 'textbox', tagName: 'textarea', accessibleName: 'Notes' });
    const value = 'a\r\nb\u2028c\u2029d';
    const session = buildSession([step({ action: 'fill', value, target: textarea })], 0);
    const { code } = renderSpec(session);
    expect(code).toContain(`.fill('a\\r\\nb\\u2028c\\u2029d');`);
  });

  test('a quote or backslash in a value is still escaped', () => {
    const textarea = target({ role: 'textbox', tagName: 'textarea', accessibleName: 'Notes' });
    const session = buildSession([step({ action: 'fill', value: `it's a\\path`, target: textarea })], 0);
    const { code } = renderSpec(session);
    expect(code).toContain(`.fill('it\\'s a\\\\path');`);
  });

  test('a newline in the test title does not break the test() line', () => {
    const session = buildSession([step()], 0);
    const { code } = renderSpec(session, { title: 'flow\nwith a newline' });
    expect(code).toContain(`test('flow\\nwith a newline'`);
  });
});

describe('renderSpec — with a catalog', () => {
  const loginEntry: TestFunctionEntry = {
    id: 1,
    name: 'login',
    kind: 'page-object-method',
    module: './pages/LoginPage',
    receiver: 'loginPage',
    importName: 'LoginPage',
    params: [
      { name: 'username', type: 'string' },
      { name: 'password', type: 'string' },
    ],
    urlPattern: '**/login',
    steps: [
      { action: 'fill', target: { role: 'textbox', name: 'Username' } },
      { action: 'fill', target: { role: 'textbox', name: 'Password' } },
      { action: 'click', target: { role: 'button', name: 'Log in' } },
    ],
    paramSources: [
      { param: 'username', stepIndex: 0, from: 'value' },
      { param: 'password', stepIndex: 1, from: 'value' },
    ],
  };

  function loginSteps(): RecordedStep[] {
    return [
      step({
        action: 'fill',
        value: 'alice',
        target: target({ role: 'textbox', accessibleName: 'Username', tagName: 'input' }),
      }),
      step({
        action: 'fill',
        value: 'secret',
        target: target({ role: 'textbox', accessibleName: 'Password', tagName: 'input' }),
      }),
      step({ action: 'click', target: target({ role: 'button', accessibleName: 'Log in' }) }),
    ];
  }

  test('a complete matching span collapses into one function call with imports and instantiation', () => {
    const session = buildSession(loginSteps(), 0);
    const { code, matchedSpans } = renderSpec(session, { catalog: [loginEntry] });
    expect(code).toContain(`import { LoginPage } from './pages/LoginPage';`);
    expect(code).toContain(`const loginPage = new LoginPage(page);`);
    expect(code).toContain(`await loginPage.login('alice', 'secret');`);
    expect(code).not.toContain('.fill(');
    expect(matchedSpans).toEqual([{ startStep: 0, endStep: 2, functionName: 'login' }]);
  });

  test('a page object whose receiver is already declared is neither imported nor instantiated again', () => {
    const session = buildSession(loginSteps(), 0);
    const body = renderSpec(session, {
      catalog: [loginEntry],
      format: 'body',
      bodyImports: 'none',
      declaredNames: new Set(['page', 'loginPage']),
    });
    expect(body.code).not.toContain('new LoginPage');
    expect(body.code).toContain(`  await loginPage.login('alice', 'secret');`);
    expect(body.imports).toEqual([]);
    expect(body.code.split('\n')[body.stepLines[0]! - 1]).toBe(`  await loginPage.login('alice', 'secret');`);
    const other = renderSpec(session, {
      catalog: [loginEntry],
      format: 'body',
      declaredNames: new Set(['signInPage']),
    });
    expect(other.code).toContain('  const loginPage = new LoginPage(page);');
  });

  test('the next page is waited for between two lines of the steps, not next to a call, which waits itself', () => {
    const cart = target({ role: 'link', accessibleName: 'Cart' });
    const checkout = target({ role: 'button', accessibleName: 'Checkout' });
    const steps = [
      ...loginSteps(),
      step({ action: 'click', target: cart, pageUrl: 'https://x.test/shop' }),
      step({ action: 'click', target: checkout, pageUrl: 'https://x.test/cart' }),
      ...loginSteps().map((s) => ({ ...s, pageUrl: 'https://x.test/checkout/login' })),
    ];
    const { code } = renderSpec(buildSession(steps, 0), {
      catalog: [{ ...loginEntry, urlPattern: null }],
      format: 'body',
      bodyImports: 'none',
      urlChecks: true,
    });
    expect(code).toBe(
      [
        '  const loginPage = new LoginPage(page);',
        "  await page.goto('https://x.test/login');",
        "  await loginPage.login('alice', 'secret');",
        "  await page.getByRole('link', { name: 'Cart' }).click();",
        '  await expect(page).toHaveURL(/\\/cart(?:[?#]|$)/);',
        "  await expect(page.getByRole('button', { name: 'Checkout' })).toHaveCount(1);",
        "  await page.getByRole('button', { name: 'Checkout' }).click();",
        "  await loginPage.login('alice', 'secret');",
        '',
      ].join('\n'),
    );
  });

  test('a new test takes a page object the file’s tests take as a fixture, after the page', () => {
    const session = buildSession(loginSteps(), 0);
    const result = renderSpec(session, {
      catalog: [loginEntry],
      format: 'test',
      title: 'signs in',
      fixtures: new Set(['page', 'loginPage', 'cart']),
    });
    expect(result.code).toBe(
      [
        "test('signs in', async ({ page, loginPage }) => {",
        "  await page.goto('https://x.test/login');",
        "  await loginPage.login('alice', 'secret');",
        '});',
        '',
      ].join('\n'),
    );
    expect(result.imports).toEqual([]);
    // In a test's body, the fixtures cannot be added to its parameters: the page object is instantiated there.
    const body = renderSpec(session, { catalog: [loginEntry], format: 'body', fixtures: new Set(['loginPage']) });
    expect(body.code).toContain('  const loginPage = new LoginPage(page);');
  });

  test('a call never stands for steps the viewport changes between, and one before its first step stays', () => {
    const resized = { ...buildSession(loginSteps(), 0), viewports: [{ step: 1, width: 390, height: 844 }] };
    const inside = renderSpec(resized, { catalog: [loginEntry] });
    expect(inside.code).not.toContain('loginPage.login');
    expect(inside.code).toContain('await page.setViewportSize({ width: 390, height: 844 });');
    const before = { ...buildSession(loginSteps(), 0), viewports: [{ step: 0, width: 390, height: 844 }] };
    const lines = renderSpec(before, { catalog: [loginEntry] }).code.split('\n');
    const resize = lines.findIndex((l) => l.includes('setViewportSize'));
    expect(resize).toBeGreaterThan(-1);
    expect(resize).toBeLessThan(lines.findIndex((l) => l.includes('loginPage.login')));
  });

  test('steps after a matched span that do not match anything stay raw', () => {
    const extra = step({ action: 'click', target: target({ accessibleName: 'Continue' }) });
    const session = buildSession([...loginSteps(), extra], 0);
    const { code } = renderSpec(session, { catalog: [loginEntry] });
    expect(code).toContain(`await loginPage.login('alice', 'secret');`);
    expect(code).toContain(`getByRole('button', { name: 'Continue' })`);
  });

  test('an incomplete match (fewer steps than the pattern needs) is left raw, not partially substituted', () => {
    const session = buildSession(loginSteps().slice(0, 2), 0);
    const { code, matchedSpans } = renderSpec(session, { catalog: [loginEntry] });
    expect(code).not.toContain('loginPage.login');
    expect(code).toContain(`.fill('alice');`);
    expect(matchedSpans).toEqual([]);
  });

  test('a step interleaved into an otherwise matching span is never swallowed by the call', () => {
    const [username, password, submit] = loginSteps();
    const interloper = step({ action: 'click', target: target({ role: 'button', accessibleName: 'Show password' }) });
    const session = buildSession([username!, interloper, password!, submit!], 0);
    const { code, matchedSpans } = renderSpec(session, { catalog: [loginEntry] });
    // Every recorded action has to survive into the spec — collapsing this span
    // would have dropped the "Show password" click entirely.
    expect(code).toContain(`getByRole('button', { name: 'Show password' })`);
    expect(code).toContain(`.fill('alice');`);
    expect(code).toContain(`.fill('secret');`);
    expect(matchedSpans).toEqual([]);
  });

  test('an entry whose identifiers are not identifiers is never emitted as a call', () => {
    // These fields land in the generated source unquoted. The API rejects them
    // on the way in; codegen refuses them on the way out as well, since an MCP
    // agent can also fill a catalog from repository source.
    const injected: TestFunctionEntry = {
      ...loginEntry,
      receiver: `loginPage); await page.goto('https://evil.test'); (0`,
      importName: `LoginPage } from 'node:child_process'; import { execSync`,
    };
    const session = buildSession(loginSteps(), 0);
    const { code, matchedSpans } = renderSpec(session, { catalog: [injected] });
    expect(code).not.toContain('evil.test');
    expect(code).not.toContain('child_process');
    expect(matchedSpans).toEqual([]);
    // The steps still come out — refusing the call must not lose the recording.
    expect(code).toContain(`.fill('alice');`);
  });

  test('a name that is not an identifier is refused for a helper too', () => {
    const injected: TestFunctionEntry = { ...loginEntry, kind: 'helper', receiver: null, name: 'do(); evil' };
    const session = buildSession(loginSteps(), 0);
    const { code } = renderSpec(session, { catalog: [injected] });
    expect(code).not.toContain('evil');
    expect(code).toContain(`.fill('alice');`);
  });

  test('a helper (no receiver) is imported and called directly with page as the first arg', () => {
    const helper: TestFunctionEntry = {
      ...loginEntry,
      id: 2,
      name: 'addItem',
      kind: 'helper',
      receiver: null,
      importName: null,
      module: './helpers/cart',
      params: [{ name: 'sku', type: 'string' }],
      steps: [{ action: 'click', target: { role: 'button', name: 'Add to cart' } }],
      paramSources: [{ param: 'sku', stepIndex: 0, from: 'testId' }],
    };
    const cartStep = step({ target: target({ role: 'button', accessibleName: 'Add to cart', testId: 'sku-42' }) });
    const session = buildSession([cartStep], 0);
    const { code } = renderSpec(session, { catalog: [helper] });
    expect(code).toContain(`import { addItem } from './helpers/cart';`);
    expect(code).toContain(`await addItem(page, 'sku-42');`);
    // A value read from the element, not typed, stays a literal with values from the environment too.
    expect(renderSpec(session, { catalog: [helper], values: 'env' }).code).toContain(`await addItem(page, 'sku-42');`);
  });

  /** The login steps, the password typed in a password field. */
  function redactedLoginSteps(): RecordedStep[] {
    const steps = loginSteps();
    steps[1] = { ...steps[1]!, value: null, redacted: true };
    return steps;
  }

  test('a password the call takes is read from the environment, as a fill reads it', () => {
    const { code, warnings } = renderSpec(buildSession(redactedLoginSteps(), 0), { catalog: [loginEntry] });
    expect(code).toContain(`await loginPage.login('alice', process.env.E2E_PASSWORD ?? '');`);
    expect(warnings).toEqual([
      {
        step: 1,
        code: 'redacted-value',
        detail: 'E2E_PASSWORD',
        message: 'A password was typed here; the spec reads it from E2E_PASSWORD.',
      },
    ]);
  });

  test('with values from the environment, every typed value the call takes is read from it', () => {
    const { code, warnings } = renderSpec(buildSession(loginSteps(), 0), { catalog: [loginEntry], values: 'env' });
    expect(code).toContain(`await loginPage.login(process.env.E2E_USERNAME ?? '', process.env.E2E_PASSWORD ?? '');`);
    expect(code).toContain('  // Typed values come from E2E_USERNAME, E2E_PASSWORD.\n');
    expect(code).not.toContain('alice');
    expect(code).not.toContain('secret');
    expect(warnings).toEqual([]);
  });

  test('a field of an object the call fills from a password is read from the environment', () => {
    const signIn: TestFunctionEntry = {
      ...loginEntry,
      name: 'signIn',
      kind: 'helper',
      receiver: null,
      importName: null,
      module: './helpers/auth',
      params: [{ name: 'credentials', type: 'object', fields: ['username', 'password'] }],
      paramSources: [
        { param: 'credentials', path: 'username', stepIndex: 0, from: 'value' },
        { param: 'credentials', path: 'password', stepIndex: 1, from: 'value' },
      ],
    };
    const { code, warnings } = renderSpec(buildSession(redactedLoginSteps(), 0), { catalog: [signIn] });
    expect(code).toContain(`await signIn(page, { username: 'alice', password: process.env.E2E_PASSWORD ?? '' });`);
    expect(warnings.map((w) => [w.step, w.code, w.detail])).toEqual([[1, 'redacted-value', 'E2E_PASSWORD']]);
  });

  test('a password and a raw fill of the same field read two variables', () => {
    const extra = step({
      action: 'fill',
      value: null,
      redacted: true,
      target: target({ role: 'textbox', accessibleName: 'Password', tagName: 'input' }),
    });
    const { code } = renderSpec(buildSession([...redactedLoginSteps(), extra], 0), { catalog: [loginEntry] });
    expect(code).toContain(`await loginPage.login('alice', process.env.E2E_PASSWORD ?? '');`);
    expect(code).toContain(`.fill(process.env.E2E_PASSWORD_2 ?? '');`);
  });
});

/**
 * The shape most real Playwright helpers actually take — an options bag
 * (`selectOption(page, { label }, { value })`) rather than positional
 * scalars. Before `object` params existed these could only be declared
 * `string`, and codegen emitted a bare `''` into a slot needing a literal.
 */
describe('renderSpec — object params', () => {
  const selectEntry: TestFunctionEntry = {
    id: 10,
    name: 'selectOption',
    kind: 'helper',
    module: './helpers/select',
    receiver: null,
    importName: null,
    urlPattern: null,
    params: [
      { name: 'source', type: 'object', fields: ['label'] },
      { name: 'option', type: 'object', fields: ['value'] },
    ],
    steps: [
      { action: 'click', target: { role: 'combobox' } },
      { action: 'click', target: { role: 'option' } },
    ],
    paramSources: [
      { param: 'source', path: 'label', stepIndex: 0, from: 'text' },
      { param: 'option', path: 'value', stepIndex: 1, from: 'text' },
    ],
  };

  function selectSteps(optionText: string | null): RecordedStep[] {
    return [
      step({ target: target({ role: 'combobox', accessibleName: 'Country', text: 'Country' }) }),
      step({ target: target({ role: 'option', accessibleName: 'France', text: optionText }) }),
    ];
  }

  test('each object param renders as a literal built from its resolved fields', () => {
    const session = buildSession(selectSteps('France'), 0);
    const { code } = renderSpec(session, { catalog: [selectEntry] });
    expect(code).toContain(`await selectOption(page, { label: 'Country' }, { value: 'France' });`);
  });

  test('a field that resolved to nothing is omitted, not emitted empty', () => {
    const session = buildSession(selectSteps(null), 0);
    const { code } = renderSpec(session, { catalog: [selectEntry] });
    // `option.value` had no text to read, so the bag renders empty rather than `{ value: '' }`.
    expect(code).toContain(`await selectOption(page, { label: 'Country' }, {});`);
  });

  test('a field name that is not a bare identifier is quoted as a key', () => {
    const quirky: TestFunctionEntry = {
      ...selectEntry,
      params: [
        { name: 'source', type: 'object', fields: ['data-label'] },
        { name: 'option', type: 'object', fields: ['value'] },
      ],
      paramSources: [
        { param: 'source', path: 'data-label', stepIndex: 0, from: 'text' },
        { param: 'option', path: 'value', stepIndex: 1, from: 'text' },
      ],
    };
    const session = buildSession(selectSteps('France'), 0);
    const { code } = renderSpec(session, { catalog: [quirky] });
    expect(code).toContain(`{ 'data-label': 'Country' }`);
  });
});

describe('renderSpec — options', () => {
  const origin = 'https://x.test';
  const at = (path: string) => `${origin}${path}`;
  const brittle = { locator: `locator('.btn').nth(1)`, method: 'locator', score: 20 };
  const byRole = { locator: `getByRole('button', { name: 'Log in' })`, method: 'getByRole', score: 90 };

  test('with no options the output is the plain recorder export', () => {
    const session = buildSession([step()], 0);
    session.startUrl = at('/login');
    const { code, warnings } = renderSpec(session);
    expect(code).toBe(
      [
        `import { test, expect } from '@playwright/test';`,
        ``,
        `test('recorded flow', async ({ page }) => {`,
        `  await page.goto('https://x.test/login');`,
        `  await page.getByRole('button', { name: 'Log in' }).click();`,
        `});`,
        ``,
      ].join('\n'),
    );
    expect(warnings).toEqual([]);
  });

  test('testImport replaces the module test and expect come from', () => {
    const { code } = renderSpec(buildSession([step()], 0), { testImport: '../fixtures' });
    expect(code).toContain(`import { test, expect } from '../fixtures';`);
    expect(code).not.toContain('@playwright/test');
  });

  test('relative urls write the recorded origin as paths and leave other origins alone', () => {
    const session = buildSession(
      [
        step({ action: 'goto', target: null, value: at('/login?next=%2Fcart'), pageUrl: at('/login') }),
        step({ action: 'goto', target: null, value: 'https://pay.example/checkout', pageUrl: at('/login') }),
      ],
      0,
    );
    const { code } = renderSpec(session, { urls: 'relative' });
    expect(code).toContain(`await page.goto('/login?next=%2Fcart');`);
    expect(code).toContain(`await page.goto('https://pay.example/checkout');`);
  });

  test('the leading goto from startUrl follows the url mode too', () => {
    const session = buildSession([step()], 0);
    session.startUrl = at('/login');
    expect(renderSpec(session, { urls: 'relative' }).code).toContain(`await page.goto('/login');`);
  });

  test('stable locators skip a brittle first alternative; the default keeps it and warns', () => {
    const session = buildSession([step({ target: target({ alternatives: [brittle, byRole] }) })], 0);
    const first = renderSpec(session);
    expect(first.code).toContain(`page.locator('.btn').nth(1).click()`);
    expect(first.warnings).toEqual([
      expect.objectContaining({ step: 0, code: 'brittle-locator', detail: `locator('.btn').nth(1)` }),
    ]);
    const stable = renderSpec(session, { locators: 'stable' });
    expect(stable.code).toContain(`page.getByRole('button', { name: 'Log in' }).click()`);
    expect(stable.warnings).toEqual([]);
  });

  test('a chain the suite already uses comes first, unless it is brittle', () => {
    const byTestId = { locator: `getByTestId('login')`, method: 'getByTestId', score: 100 };
    const session = buildSession([step({ target: target({ alternatives: [byTestId, byRole, brittle] }) })], 0);
    const preferred = renderSpec(session, { preferLocators: new Set([byRole.locator]) });
    expect(preferred.code).toContain(`page.getByRole('button', { name: 'Log in' }).click()`);
    const brittleKnown = renderSpec(session, { preferLocators: new Set([brittle.locator]) });
    expect(brittleKnown.code).toContain(`page.getByTestId('login').click()`);
  });

  test('url checks wait for the next page after a step that leads to it, then for its element alone', () => {
    const session = buildSession(
      [
        step({ pageUrl: at('/login') }),
        step({ pageUrl: at('/orders/42'), target: target({ accessibleName: 'Pay' }) }),
        step({ pageUrl: at('/orders/42?tab=items'), target: target({ accessibleName: 'Items' }) }),
      ],
      0,
    );
    const { code } = renderSpec(session, { urlChecks: true });
    const lines = code.split('\n').map((l) => l.trim());
    const login = lines.indexOf(`await page.getByRole('button', { name: 'Log in' }).click();`);
    expect(lines[login + 1]).toBe('await expect(page).toHaveURL(/\\/orders\\/[^/?#]+(?:[?#]|$)/);');
    // The page it left can still be on screen: an action would fail on a match there, the count waits it out.
    expect(lines[login + 2]).toBe(`await expect(page.getByRole('button', { name: 'Pay' })).toHaveCount(1);`);
    expect(lines[login + 3]).toBe(`await page.getByRole('button', { name: 'Pay' }).click();`);
    // The query changes, the page does not: no second check.
    expect(code.match(/toHaveURL/g)).toHaveLength(1);
    expect(code.match(/toHaveCount/g)).toHaveLength(1);
  });

  test('page url patterns match the page with any id and nothing else', () => {
    const regex = (url: string) => new Function(`return ${pageUrlPattern(url)}`)() as RegExp;
    const orders = regex('https://x.test/orders/42');
    expect(orders.test('http://localhost:3000/orders/7')).toBe(true);
    expect(orders.test('http://localhost:3000/orders/7?tab=items#top')).toBe(true);
    expect(orders.test('http://localhost:3000/orders/7/items')).toBe(false);
    const root = regex('https://x.test/');
    expect(root.test('http://localhost:3000/')).toBe(true);
    expect(root.test('http://localhost:3000')).toBe(true);
    expect(root.test('http://localhost:3000/cart')).toBe(false);
    const odd = regex('https://x.test/a.b(c)/d');
    expect(odd.test('https://x.test/a.b(c)/d')).toBe(true);
    expect(odd.test('https://x.test/aXb(c)/d')).toBe(false);
    expect(pageUrlPattern('mailto:someone@example.com')).toBeNull();
  });

  test('env values read every typed value from the environment', () => {
    const field = target({ role: 'textbox', accessibleName: 'Email' });
    const session = buildSession([step({ action: 'fill', value: 'ana@acme.test', target: field })], 0);
    const { code } = renderSpec(session, { values: 'env' });
    expect(code).toContain(`.fill(process.env.E2E_EMAIL ?? '');`);
    expect(code).toContain('// Typed values come from E2E_EMAIL.');
    expect(code).not.toContain('ana@acme.test');
  });

  test('a redacted value warns', () => {
    const password = target({ role: 'textbox', tagName: 'input', accessibleName: 'Password' });
    const session = buildSession([step({ action: 'fill', value: null, redacted: true, target: password })], 0);
    expect(renderSpec(session).warnings).toEqual([
      expect.objectContaining({
        code: 'redacted-value',
        detail: 'E2E_PASSWORD',
        message: 'A password was typed here; the spec reads it from E2E_PASSWORD.',
      }),
    ]);
  });

  test('expectFail, tags and annotations shape the test declaration', () => {
    const { code } = renderSpec(buildSession([step()], 0), {
      title: 'bug: coupon ignored',
      expectFail: { reason: 'SHOP-812: passes while\nthe bug exists' },
      tags: ['bug', '@checkout'],
      annotations: [{ type: 'piwi:bug', description: "37 'quoted'" }, { type: 'slow' }],
    });
    expect(code).toContain(
      [
        `test('bug: coupon ignored', {`,
        `  tag: ['@bug', '@checkout'],`,
        `  annotation: [`,
        `    { type: 'piwi:bug', description: '37 \\'quoted\\'' },`,
        `    { type: 'slow' },`,
        `  ],`,
        `}, async ({ page }) => {`,
        `  test.fail(); // SHOP-812: passes while the bug exists`,
      ].join('\n'),
    );
  });

  test('body format holds only the lines to paste, with the imports they need', () => {
    const logIn: TestFunctionEntry = {
      id: 9,
      name: 'logIn',
      kind: 'page-object-method',
      module: './pages/login',
      receiver: 'loginPage',
      importName: 'LoginPage',
      params: [],
      urlPattern: null,
      steps: [{ action: 'click', target: { role: 'button', name: 'Log in' } }],
      paramSources: [],
    };
    const search = target({ role: 'searchbox', tagName: 'input', accessibleName: 'Search' });
    const session = buildSession([step(), step({ action: 'fill', value: 'mug', target: search })], 0);
    const { code } = renderSpec(session, { format: 'body', catalog: [logIn] });
    expect(code).toBe(
      [
        `  // Needs: import { LoginPage } from './pages/login';`,
        `  const loginPage = new LoginPage(page);`,
        `  await page.goto('https://x.test/login');`,
        `  await loginPage.logIn();`,
        `  await page.getByRole('searchbox', { name: 'Search' }).fill('mug');`,
        ``,
      ].join('\n'),
    );
  });
});

describe('renderSpec — assertions', () => {
  const total = target({ role: null, tagName: 'output', accessibleName: null, testId: 'cart-total' });

  test('a value assertion writes the expected value and the recorded one beside it', () => {
    const session = buildSession(
      [
        step({
          action: 'assert',
          target: total,
          assertion: { matcher: 'toHaveText', expected: 'Total: 42', actual: 'Total: 40', negated: false, note: null },
        }),
      ],
      0,
    );
    expect(renderSpec(session).code).toContain(
      `await expect(page.getByTestId('cart-total')).toHaveText('Total: 42'); // recorded: 'Total: 40'`,
    );
  });

  test('state assertions, negation and notes', () => {
    const session = buildSession(
      [
        step({
          action: 'assert',
          target: total,
          assertion: { matcher: 'toBeVisible', expected: null, actual: null, negated: true, note: 'gone\nafter pay' },
        }),
      ],
      0,
    );
    const { code } = renderSpec(session);
    expect(code).toContain('  // gone after pay\n');
    expect(code).toContain(`await expect(page.getByTestId('cart-total')).not.toBeVisible();`);
  });

  test('toHaveURL checks the page and follows the url mode', () => {
    const assertion = { matcher: 'toHaveURL' as const, expected: '/thanks', actual: null, negated: false, note: null };
    const session = buildSession([step({ action: 'assert', target: null, assertion })], 0);
    session.startUrl = 'https://x.test/cart';
    expect(renderSpec(session, { urls: 'relative' }).code).toContain(`await expect(page).toHaveURL('/thanks');`);
    expect(renderSpec(session).code).toContain(`await expect(page).toHaveURL('https://x.test/thanks');`);
  });

  test('an assertion with nothing to check becomes a comment and a warning', () => {
    const session = buildSession(
      [
        step({ action: 'assert', target: total }),
        step({
          action: 'assert',
          target: total,
          assertion: { matcher: 'toHaveText', expected: null, actual: null, negated: false, note: null },
        }),
      ],
      0,
    );
    const { code, warnings } = renderSpec(session);
    expect(code).not.toContain('expect(page.getByTestId');
    expect(warnings.map((w) => w.code)).toEqual(['incomplete-assertion', 'incomplete-assertion']);
  });

  test('the legacy assertVisible step still renders', () => {
    const session = buildSession([step({ action: 'assertVisible', target: total })], 0);
    expect(renderSpec(session).code).toContain(`await expect(page.getByTestId('cart-total')).toBeVisible();`);
  });
});

describe('renderSpec — only steps, never code', () => {
  test('a locator that is not a Playwright chain is never written into the spec', () => {
    const evil = { locator: `getByRole('x')); process.exit(1); ((0`, method: 'getByRole', score: 99 };
    const session = buildSession([step({ target: target({ alternatives: [evil] }) })], 0);
    const { code, warnings } = renderSpec(session);
    expect(code).not.toContain('process.exit');
    expect(code).toContain(`page.locator('/* no locator captured */').click()`);
    expect(warnings).toEqual([expect.objectContaining({ code: 'no-locator' })]);
  });

  test('a regex argument must be a valid pattern on one line', () => {
    expect(safeLocator('getByText(/total/i)')?.text).toBe('getByText(/total/i)');
    expect(safeLocator('getByText(/a\nb/)')).toBeNull();
    expect(safeLocator('getByText(/(/)')).toBeNull();
    expect(safeLocator('getByText(/x/zz)')).toBeNull();
  });

  test('a locator is re-rendered in canonical form', () => {
    expect(safeLocator(`getByRole("button", {name: "Pay"})`)?.text).toBe(`getByRole('button', { name: 'Pay' })`);
  });

  test('a spec with every option parses as TypeScript', () => {
    const session = buildSession(
      [
        step({ action: 'goto', target: null, value: 'https://x.test/cart', pageUrl: 'https://x.test/cart' }),
        step({ action: 'fill', value: `it's "quoted"\n`, pageUrl: 'https://x.test/cart' }),
        step({ action: 'press', target: null, value: 'Enter', pageUrl: 'https://x.test/cart' }),
        step({ pageUrl: 'https://x.test/cart' }),
        step({
          action: 'assert',
          pageUrl: 'https://x.test/orders/9',
          target: target({ testId: 'total' }),
          assertion: { matcher: 'toHaveText', expected: 'a b', actual: `x'y`, negated: true, note: '*/ // note' },
        }),
      ],
      0,
    );
    const { code } = renderSpec(session, {
      title: `bug: it's \n broken`,
      testImport: `../fix'tures`,
      urls: 'relative',
      locators: 'stable',
      urlChecks: true,
      expectFail: { reason: 'SHOP-1 */' },
      tags: ['bug'],
      annotations: [{ type: 'piwi:link', description: 'https://x.test/a?b=1&c= ' }],
    });
    const out = ts.transpileModule(code, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    });
    expect(out.diagnostics ?? []).toEqual([]);
  });
});

const search = target({ role: 'searchbox', tagName: 'input', accessibleName: 'Search' });

const logIn: TestFunctionEntry = {
  id: 9,
  name: 'logIn',
  kind: 'page-object-method',
  module: './pages/login',
  receiver: 'loginPage',
  importName: 'LoginPage',
  params: [],
  urlPattern: null,
  steps: [{ action: 'click', target: { role: 'button', name: 'Log in' } }],
  paramSources: [],
};

const checkout: TestFunctionEntry = {
  id: 11,
  name: 'checkout',
  kind: 'helper',
  module: './helpers/cart',
  receiver: null,
  importName: null,
  params: [],
  urlPattern: null,
  steps: [
    { action: 'click', target: { role: 'button', name: 'Add to cart' } },
    { action: 'click', target: { role: 'button', name: 'Checkout' } },
  ],
  paramSources: [],
};

const addToCart = target({ accessibleName: 'Add to cart' });
const checkoutButton = target({ accessibleName: 'Checkout' });
const IMPORT_LINES = [`import { LoginPage } from './pages/login';`, `import { checkout } from './helpers/cart';`];

describe('renderSpec — formats', () => {
  test('the test format is the test call alone: details, test.fail(), the environment comment and the body', () => {
    const session = buildSession([step(), step({ action: 'fill', value: 'mug', target: search })], 0);
    const { code, imports } = renderSpec(session, {
      format: 'test',
      catalog: [logIn],
      title: 'search a mug',
      tags: ['smoke'],
      expectFail: { reason: 'SHOP-1' },
      values: 'env',
      testImport: '../fixtures',
    });
    expect(code).toBe(
      [
        `// Needs: import { LoginPage } from './pages/login';`,
        `test('search a mug', {`,
        `  tag: ['@smoke'],`,
        `}, async ({ page }) => {`,
        `  test.fail(); // SHOP-1`,
        `  // Typed values come from E2E_SEARCH.`,
        `  const loginPage = new LoginPage(page);`,
        `  await page.goto('https://x.test/login');`,
        `  await loginPage.logIn();`,
        `  await page.getByRole('searchbox', { name: 'Search' }).fill(process.env.E2E_SEARCH ?? '');`,
        `});`,
        ``,
      ].join('\n'),
    );
    expect(imports).toEqual([`import { LoginPage } from './pages/login';`]);
  });

  test('without a catalog call the test format has no comment before the test', () => {
    const { code } = renderSpec(buildSession([step()], 0), { format: 'test' });
    expect(code).toBe(
      [
        `test('recorded flow', async ({ page }) => {`,
        `  await page.goto('https://x.test/login');`,
        `  await page.getByRole('button', { name: 'Log in' }).click();`,
        `});`,
        ``,
      ].join('\n'),
    );
  });

  test('each format gives the line every step starts on, the steps of a call sharing it', () => {
    const shop = 'https://x.test/shop';
    const session = {
      ...buildSession(
        [
          step({ action: 'goto', target: null, value: 'https://x.test/login' }),
          step(),
          step({ target: addToCart }),
          step({ target: checkoutButton }),
          step({ action: 'fill', value: 'mug', target: search, pageUrl: shop }),
          step({ action: 'press', target: null, value: 'Enter', pageUrl: shop }),
        ],
        0,
      ),
      viewports: [
        { step: 0, width: 1280, height: 720 },
        { step: 5, width: 390, height: 844 },
      ],
    };
    const expected = [
      `await page.goto('https://x.test/login');`,
      `await loginPage.logIn();`,
      `await checkout(page);`,
      `await checkout(page);`,
      `await page.getByRole('searchbox', { name: 'Search' }).fill('mug');`,
      `await page.keyboard.press('Enter');`,
    ];
    for (const format of ['file', 'test', 'body'] as const) {
      for (const bodyImports of ['comments', 'none'] as const) {
        const { code, stepLines } = renderSpec(session, {
          format,
          bodyImports,
          catalog: [logIn, checkout],
          urlChecks: true,
          tags: ['smoke'],
          annotations: [{ type: 'piwi:bug', description: '7' }],
          expectFail: true,
        });
        const lines = code.split('\n');
        expect(
          stepLines.map((line) => lines[line - 1]!.trim()),
          `${format}, ${bodyImports}`,
        ).toEqual(expected);
      }
    }
  });

  test('imports come back in every format, deduped, in first-use order, and never the test import', () => {
    const session = buildSession([step(), step({ target: addToCart }), step({ target: checkoutButton }), step()], 0);
    const options = { catalog: [logIn, checkout], testImport: '../fixtures' };
    for (const format of ['file', 'test', 'body'] as const) {
      expect(renderSpec(session, { ...options, format }).imports, format).toEqual(IMPORT_LINES);
    }
    const file = renderSpec(session, options).code.split('\n');
    expect(file.slice(0, 4)).toEqual([`import { test, expect } from '../fixtures';`, ...IMPORT_LINES, '']);
    const test = renderSpec(session, { ...options, format: 'test' }).code.split('\n');
    expect(test.slice(0, 3)).toEqual([
      ...IMPORT_LINES.map((line) => `// Needs: ${line}`),
      `test('recorded flow', async ({ page }) => {`,
    ]);
    const body = renderSpec(session, { ...options, format: 'body' }).code.split('\n');
    expect(body.slice(0, 2)).toEqual(IMPORT_LINES.map((line) => `  // Needs: ${line}`));
  });

  test('no catalog call, no imports', () => {
    const session = buildSession([step(), step({ action: 'fill', value: 'mug', target: search })], 0);
    for (const format of ['file', 'test', 'body'] as const) {
      expect(renderSpec(session, { format }).imports, format).toEqual([]);
    }
  });

  test('bodyImports none leaves the imports out of the code of the body and test formats, not out of the file', () => {
    const session = buildSession([step(), step({ action: 'fill', value: 'mug', target: search })], 0);
    const options = { catalog: [logIn], bodyImports: 'none' as const };
    const body = renderSpec(session, { ...options, format: 'body' });
    expect(body.code).toBe(
      [
        `  const loginPage = new LoginPage(page);`,
        `  await page.goto('https://x.test/login');`,
        `  await loginPage.logIn();`,
        `  await page.getByRole('searchbox', { name: 'Search' }).fill('mug');`,
        ``,
      ].join('\n'),
    );
    expect(body.imports).toEqual([`import { LoginPage } from './pages/login';`]);
    expect(body.stepLines).toEqual([3, 4]);
    const test = renderSpec(session, { ...options, format: 'test' });
    expect(test.code.split('\n')[0]).toBe(`test('recorded flow', async ({ page }) => {`);
    expect(test.imports).toEqual([`import { LoginPage } from './pages/login';`]);
    expect(test.stepLines).toEqual([4, 5]);
    const file = renderSpec(session, options).code;
    expect(file).toContain(`\nimport { LoginPage } from './pages/login';\n`);
    expect(file).not.toContain('Needs:');
  });
});

describe('renderSpec — the page expression', () => {
  const shop = 'https://x.test/shop';
  const evil = { locator: `getByRole('x')); process.exit(1); ((0`, method: 'getByRole', score: 99 };

  /** Every kind of line codegen writes: a page object, a helper, a URL check, a resize, a key, a URL assertion, no locator. */
  function everyReceiver() {
    return {
      ...buildSession(
        [
          step(),
          step({ target: addToCart }),
          step({ target: checkoutButton }),
          step({ action: 'fill', value: 'mug', target: search, pageUrl: shop }),
          step({ action: 'press', target: null, value: 'Enter', pageUrl: shop }),
          step({
            action: 'assert',
            target: null,
            pageUrl: shop,
            assertion: { matcher: 'toHaveURL', expected: '/thanks', actual: null, negated: false, note: null },
          }),
          step({ target: target({ role: 'link', accessibleName: 'Help', alternatives: [evil] }), pageUrl: shop }),
        ],
        0,
      ),
      viewports: [
        { step: 0, width: 1280, height: 720 },
        { step: 4, width: 390, height: 844 },
      ],
    };
  }

  test('every line runs on it, and its fixture is the test’s parameter', () => {
    const { code, warnings } = renderSpec(everyReceiver(), {
      page: 'adminPage',
      catalog: [logIn, checkout],
      urlChecks: true,
    });
    expect(code).toBe(
      [
        `import { test, expect } from '@playwright/test';`,
        `import { LoginPage } from './pages/login';`,
        `import { checkout } from './helpers/cart';`,
        ``,
        `test('recorded flow', async ({ adminPage }) => {`,
        `  const loginPage = new LoginPage(adminPage);`,
        `  await adminPage.setViewportSize({ width: 1280, height: 720 });`,
        `  await adminPage.goto('https://x.test/login');`,
        `  await loginPage.logIn();`,
        `  await checkout(adminPage);`,
        `  await adminPage.getByRole('searchbox', { name: 'Search' }).fill('mug');`,
        `  await adminPage.setViewportSize({ width: 390, height: 844 });`,
        `  await adminPage.keyboard.press('Enter');`,
        `  await expect(adminPage).toHaveURL('https://x.test/thanks');`,
        `  await adminPage.locator('/* no locator captured */').click();`,
        `});`,
        ``,
      ].join('\n'),
    );
    expect(code).not.toMatch(/\bpage\b/);
    expect(warnings).toEqual([expect.objectContaining({ step: 6, code: 'no-locator' })]);
  });

  test('a goto step and a drag run on it too', () => {
    const bin = target({ role: 'region', accessibleName: 'Archive' });
    const session = buildSession(
      [
        step({ action: 'goto', target: null, value: 'https://x.test/inbox' }),
        step({ action: 'dragTo', target: target({ role: 'row', accessibleName: 'Invoice 42' }), dropTarget: bin }),
      ],
      0,
    );
    const { code } = renderSpec(session, { page: 'userPage', format: 'body' });
    expect(code).toBe(
      [
        `  await userPage.goto('https://x.test/inbox');`,
        `  await userPage.getByRole('row', { name: 'Invoice 42' }).dragTo(userPage.getByRole('region', { name: 'Archive' }));`,
        ``,
      ].join('\n'),
    );
  });

  test('a member chain is written whole, and its first segment is the test’s parameter', () => {
    const session = buildSession([step()], 0);
    const file = renderSpec(session, { page: 'app.page' }).code;
    expect(file).toContain(
      `test('recorded flow', async ({ app }) => {\n  await app.page.goto('https://x.test/login');`,
    );
    expect(file).toContain(`  await app.page.getByRole('button', { name: 'Log in' }).click();`);
    const test = renderSpec(session, { page: 'app.page', format: 'test', tags: ['smoke'] }).code;
    expect(test.split('\n').slice(0, 3)).toEqual([
      `test('recorded flow', {`,
      `  tag: ['@smoke'],`,
      `}, async ({ app }) => {`,
    ]);
    expect(test).toContain(`  await app.page.getByRole('button', { name: 'Log in' }).click();`);
  });

  test('the default is page, the same as naming it', () => {
    const session = everyReceiver();
    const options = { catalog: [logIn, checkout], urlChecks: true };
    expect(renderSpec(session, { ...options, page: 'page' })).toEqual(renderSpec(session, options));
  });

  test('the body format writes this.page as it is, in a page object’s method', () => {
    const session = buildSession([step(), step({ action: 'fill', value: 'mug', target: search })], 0);
    const { code } = renderSpec(session, { format: 'body', page: 'this.page', catalog: [logIn] });
    expect(code).toBe(
      [
        `  // Needs: import { LoginPage } from './pages/login';`,
        `  const loginPage = new LoginPage(this.page);`,
        `  await this.page.goto('https://x.test/login');`,
        `  await loginPage.logIn();`,
        `  await this.page.getByRole('searchbox', { name: 'Search' }).fill('mug');`,
        ``,
      ].join('\n'),
    );
    expect(renderSpec(buildSession([step()], 0), { format: 'body', page: 'this' }).code).toContain(
      `  await this.getByRole('button', { name: 'Log in' }).click();`,
    );
  });

  test('the file and test formats refuse an expression that starts with this: a test has no this', () => {
    const session = buildSession([step()], 0);
    for (const page of ['this', 'this.page', 'this.app.page']) {
      expect(() => renderSpec(session, { page }), page).toThrow(RangeError);
      expect(() => renderSpec(session, { page, format: 'file' }), page).toThrow(RangeError);
      expect(() => renderSpec(session, { page, format: 'test' }), page).toThrow(RangeError);
      expect(() => renderSpec(session, { page, format: 'body' }), page).not.toThrow();
    }
    expect(renderSpec(session, { page: 'thisPage' }).code).toContain(`async ({ thisPage }) =>`);
  });

  test('anything but an identifier or a member chain is refused, in every format', () => {
    const session = buildSession([step()], 0);
    const refused = [
      '',
      ' page',
      'page ',
      'page.',
      '.page',
      'app..page',
      'page()',
      'pages[0]',
      'app?.page',
      'app.my-page',
      '1page',
      'app.2nd',
      'pagé',
      'page;process.exit(1)',
      "page'",
      'new',
      'class.page',
      'null',
      'true.page',
      'await',
      'yield.page',
      'super.page',
    ];
    for (const page of refused) {
      for (const format of ['file', 'test', 'body'] as const) {
        expect(() => renderSpec(session, { page, format }), JSON.stringify(page)).toThrow(RangeError);
      }
    }
  });

  test('isPageExpression: this or an identifier, then .identifier segments, never a reserved word first', () => {
    for (const text of ['page', 'this', 'this.page', 'adminPage', 'app.page', 'a.b.c', '$page', '_page', 'page2']) {
      expect(isPageExpression(text), text).toBe(true);
    }
    // A property may have a reserved word's name; only the first segment is a variable.
    expect(isPageExpression('app.default')).toBe(true);
    expect(isPageExpression('this.new')).toBe(true);
    for (const text of ['', 'page.', 'a b', 'a-b', 'page()', '0', 'default', 'import', 'let', 'enum.page', 'false']) {
      expect(isPageExpression(text), text).toBe(false);
    }
  });
});

describe('renderSpec — environment variable names', () => {
  const field = (overrides: Partial<RecordedTarget>) => target({ role: 'textbox', tagName: 'input', ...overrides });
  const fill = (fieldTarget: RecordedTarget | null, extra: Partial<RecordedStep> = {}) =>
    step({ action: 'fill', value: 'x', target: fieldTarget, ...extra });
  const envNames = (code: string) => [...code.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]);

  test('a value is named after its field’s accessible name, else its test id, else its text, else VALUE', () => {
    const session = buildSession(
      [
        fill(field({ accessibleName: 'Email' })),
        fill(field({ accessibleName: null, testId: 'billing-zip' })),
        fill(field({ accessibleName: null, testId: null, text: 'Card number' })),
        fill(field({ accessibleName: null, testId: null, text: null })),
        fill(null),
      ],
      0,
    );
    const { code } = renderSpec(session, { values: 'env' });
    expect(envNames(code)).toEqual(['E2E_EMAIL', 'E2E_BILLING_ZIP', 'E2E_CARD_NUMBER', 'E2E_VALUE', 'E2E_VALUE_2']);
  });

  test('diacritics go, letters go upper case, every other run becomes one underscore, none at either end', () => {
    const names = ['Prénom', 'Adresse e-mail (pro)', ' Straße ', 'Código  postal', '¿Número?', 'ＰＩＮ', '2FA code'];
    const session = buildSession(
      names.map((accessibleName) => fill(field({ accessibleName }))),
      0,
    );
    expect(envNames(renderSpec(session, { values: 'env' }).code)).toEqual([
      'E2E_PRENOM',
      'E2E_ADRESSE_E_MAIL_PRO',
      'E2E_STRASSE',
      'E2E_CODIGO_POSTAL',
      'E2E_NUMERO',
      'E2E_PIN',
      'E2E_2FA_CODE',
    ]);
  });

  test('a name with no letter or digit falls back to the next source', () => {
    const session = buildSession(
      [fill(field({ accessibleName: '***', testId: 'pin' })), fill(field({ accessibleName: '密码', testId: null }))],
      0,
    );
    expect(envNames(renderSpec(session, { values: 'env' }).code)).toEqual(['E2E_PIN', 'E2E_VALUE']);
  });

  test('a long name keeps at most 40 characters after the prefix, and no trailing underscore', () => {
    const session = buildSession(
      [
        fill(field({ accessibleName: 'Please enter the email address you used to sign up' })),
        fill(field({ accessibleName: 'A'.repeat(60) })),
      ],
      0,
    );
    const [cut, long] = envNames(renderSpec(session, { values: 'env' }).code);
    expect(cut).toBe('E2E_PLEASE_ENTER_THE_EMAIL_ADDRESS_YOU_USED');
    expect(long).toBe(`E2E_${'A'.repeat(40)}`);
  });

  test('the second and third step that would take a name get _2 and _3, in step order', () => {
    const password = field({ accessibleName: 'Password' });
    const session = buildSession(
      [
        fill(password, { redacted: true, value: null }),
        fill(field({ accessibleName: 'Email' })),
        fill(password, { redacted: true, value: null }),
        fill(field({ accessibleName: 'password' }), { redacted: true, value: null }),
      ],
      0,
    );
    const { code, warnings } = renderSpec(session, { values: 'env' });
    expect(envNames(code)).toEqual(['E2E_PASSWORD', 'E2E_EMAIL', 'E2E_PASSWORD_2', 'E2E_PASSWORD_3']);
    expect(code).toContain('  // Typed values come from E2E_PASSWORD, E2E_EMAIL, E2E_PASSWORD_2, E2E_PASSWORD_3.\n');
    expect(warnings.map((w) => [w.step, w.code, w.detail])).toEqual([
      [0, 'redacted-value', 'E2E_PASSWORD'],
      [2, 'redacted-value', 'E2E_PASSWORD_2'],
      [3, 'redacted-value', 'E2E_PASSWORD_3'],
    ]);
    expect(warnings[1]!.message).toBe('A password was typed here; the spec reads it from E2E_PASSWORD_2.');
  });

  test('a field whose own name ends like a suffix still reads a variable of its own', () => {
    const session = buildSession(
      [
        fill(field({ accessibleName: 'Password' })),
        fill(field({ accessibleName: 'Password' })),
        fill(field({ accessibleName: 'Password 2' })),
      ],
      0,
    );
    expect(envNames(renderSpec(session, { values: 'env' }).code)).toEqual([
      'E2E_PASSWORD',
      'E2E_PASSWORD_2',
      'E2E_PASSWORD_2_2',
    ]);
  });

  test('a step added before the field leaves its name as it was', () => {
    const password = fill(field({ accessibleName: 'Password' }), { redacted: true, value: null });
    const before = renderSpec(buildSession([password], 0)).warnings.map((w) => w.detail);
    const after = renderSpec(buildSession([step({ target: target({ accessibleName: 'Sign in' }) }), password], 0));
    expect(before).toEqual(['E2E_PASSWORD']);
    expect(after.warnings.map((w) => w.detail)).toEqual(['E2E_PASSWORD']);
    expect(after.code).toContain(`.fill(process.env.E2E_PASSWORD ?? '');`);
  });

  test('a redacted value is read from the environment without values env, and its name has no comment', () => {
    const session = buildSession(
      [
        fill(field({ accessibleName: 'Email' }), { value: 'ana@acme.test' }),
        fill(field({ accessibleName: 'Password' }), { redacted: true, value: null }),
      ],
      0,
    );
    const { code } = renderSpec(session);
    expect(code).toContain(`.fill('ana@acme.test');`);
    expect(code).toContain(`.fill(process.env.E2E_PASSWORD ?? '');`);
    expect(code).not.toContain('Typed values come from');
  });

  test('envPrefix replaces E2E_, and an invalid prefix leaves E2E_', () => {
    const session = buildSession(
      [
        fill(field({ accessibleName: 'Email' })),
        fill(field({ accessibleName: 'Password' }), { redacted: true, value: null }),
      ],
      0,
    );
    const { code, warnings } = renderSpec(session, { values: 'env', envPrefix: 'SHOP_' });
    expect(envNames(code)).toEqual(['SHOP_EMAIL', 'SHOP_PASSWORD']);
    expect(warnings[0]!.message).toBe('A password was typed here; the spec reads it from SHOP_PASSWORD.');
    for (const envPrefix of ['shop_', '1_', 'A-B', '']) {
      expect(envNames(renderSpec(session, { values: 'env', envPrefix }).code)).toEqual(['E2E_EMAIL', 'E2E_PASSWORD']);
    }
  });
});

describe('renderSpec — a test.step per page', () => {
  const origin = 'https://x.test';
  const at = (path: string) => `${origin}${path}`;
  const session = buildSession(
    [
      step({ action: 'goto', target: null, value: at('/login'), pageUrl: at('/login') }),
      step({ pageUrl: at('/login') }),
      step({ pageUrl: at('/orders/42'), target: target({ accessibleName: 'Pay' }) }),
      step({ pageUrl: at('/orders/42?tab=items'), target: target({ accessibleName: 'Items' }) }),
      step({ pageUrl: 'https://pay.example/checkout', target: target({ accessibleName: 'Confirm' }) }),
    ],
    0,
  );

  test('each page’s lines, its wait included, go into a step titled after its path', () => {
    const { code, stepLines } = renderSpec(session, { testSteps: 'page', urlChecks: true, urls: 'relative' });
    expect(code).toContain(
      [
        `  await test.step('/login', async () => {`,
        `    await page.goto('/login');`,
        `    await page.getByRole('button', { name: 'Log in' }).click();`,
        `  });`,
        `  await test.step('/orders/42', async () => {`,
        `    await expect(page).toHaveURL(/\\/orders\\/[^/?#]+(?:[?#]|$)/);`,
        `    await expect(page.getByRole('button', { name: 'Pay' })).toHaveCount(1);`,
        `    await page.getByRole('button', { name: 'Pay' }).click();`,
        `    await page.getByRole('button', { name: 'Items' }).click();`,
        `  });`,
        `  await test.step('pay.example/checkout', async () => {`,
      ].join('\n'),
    );
    const lines = code.split('\n');
    expect(stepLines.map((n) => lines[n - 1]!.trim())).toEqual([
      `await page.goto('/login');`,
      `await page.getByRole('button', { name: 'Log in' }).click();`,
      `await page.getByRole('button', { name: 'Pay' }).click();`,
      `await page.getByRole('button', { name: 'Items' }).click();`,
      `await page.getByRole('button', { name: 'Confirm' }).click();`,
    ]);
    expect(() => ts.transpileModule(code, { reportDiagnostics: true })).not.toThrow();
  });

  test('the start page opened before the steps is in the first step, and none is written by default', () => {
    const noGoto = buildSession([step({ pageUrl: at('/login') })], 0);
    const { code, stepLines } = renderSpec(noGoto, { testSteps: 'page', urls: 'relative', format: 'body' });
    expect(code.split('\n').slice(0, 4)).toEqual([
      `  await test.step('/login', async () => {`,
      `    await page.goto('/login');`,
      `    await page.getByRole('button', { name: 'Log in' }).click();`,
      `  });`,
    ]);
    expect(stepLines).toEqual([3]);
    expect(renderSpec(session).code).not.toContain('test.step');
  });
});
