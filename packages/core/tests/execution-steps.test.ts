import { describe, expect, test } from 'vitest';
import { bugReportFromFiles, renderBugMarkdown, renderBugSpec, type BugReport } from '../src/bug-report';
import { bugReportFromExecution, type ExecutionElementSnapshot } from '../src/execution-steps';
import { flattenSteps } from '../src/step-analysis';
import { parseSteps } from '../src/steps';
import {
  afterAllFailure,
  beforeAllFailure,
  beforeEachFailure,
  bodyFailure,
  caughtProbeFailure,
  caughtProbeTimeout,
  teardownAfterBodyFailure,
  toPassFailure,
  type RecordedStep as StoredStep,
} from './fixtures/playwright-steps';

const ORIGIN = 'http://localhost:3000';

function convert(
  steps: StoredStep[],
  error: string | null,
  extra: Partial<Parameters<typeof bugReportFromExecution>[0]> = {},
) {
  return bugReportFromExecution({ title: 'checkout', steps, error, testFilePath: 'tests/checkout.spec.ts', ...extra });
}

/** The steps of a report in short: the action, the locator or value, and what a manual step asks. */
function outline(report: BugReport): string[] {
  return report.steps.steps.map((s) => {
    if (s.action === 'manual') return `manual: ${s.manual?.description}`;
    if (s.action === 'assert') {
      const a = s.assertion!;
      const subject = s.target?.alternatives[0]?.locator ?? 'page';
      return `assert ${subject} ${a.negated ? 'not.' : ''}${a.matcher}${a.expected != null ? ` ${a.expected}` : ''}`;
    }
    const subject = s.target?.alternatives[0]?.locator;
    return [s.action, subject, s.redacted ? '(redacted)' : s.value].filter((p) => p != null).join(' ');
  });
}

let clock = 1790000000000;
/** A stored test-body step, one level deep under nothing, as the reporter records it. */
function body(step: Partial<StoredStep> & { title: string; category: string }): StoredStep {
  clock += 10;
  return { depth: 0, startTime: clock, duration: 5, location: '/work/shop/tests/checkout.spec.ts:10:5', ...step };
}

function failingAssertion(title: string, locator: string, message: string): StoredStep {
  return body({
    title,
    subtitle: locator,
    category: 'assertion',
    failed: true,
    error: { message },
    params: { locator },
  });
}

describe('bugReportFromExecution', () => {
  test('keeps the setup and body steps up to the failing one, which it keeps as it failed', () => {
    const { report, manualSteps } = convert(bodyFailure.steps, bodyFailure.error);
    expect(outline(report)).toEqual([
      'goto /login',
      "fill getByLabel('Email') ada@example.com",
      "fill getByLabel('Password') (redacted)",
      "click getByRole('button', { name: 'Sign in' })",
      "assert getByRole('heading', { name: 'Welcome back' }) toBeVisible",
      "click getByRole('link', { name: 'Go to checkout' })",
      "assert getByRole('heading', { name: 'Checkout' }) toBeVisible",
      "fill getByLabel('Email address') ada@example.com",
    ]);
    expect(manualSteps).toBe(0);
    expect(report.export).toMatchObject({ source: 'execution', testTitle: 'checkout', failedStep: 7 });
    // The teardown's own steps (an Evaluate in afterEach) and Piwi's capture steps are left out.
    expect(report.export!.notes).toEqual([
      {
        title: 'GET /',
        location: 'tests/checkout.spec.ts:7',
        reason: 'An API request the test sends itself; Replay sends none.',
      },
      { title: 'Expect "toBe"', location: 'tests/checkout.spec.ts:30', reason: 'A check on a value, not on the page.' },
    ]);
  });

  test('never writes a password, even into a manual step or a note', () => {
    const { report } = convert(bodyFailure.steps, bodyFailure.error);
    const files = [JSON.stringify(report), renderBugMarkdown(report), renderBugSpec(report).code].join('\n');
    expect(files).not.toContain('s3cret');
    expect(report.steps.steps[2]).toMatchObject({ action: 'fill', value: null, redacted: true });
  });

  test('keeps a page while nothing may have left it, and forgets it after an action that may have', () => {
    const { report } = convert(bodyFailure.steps, bodyFailure.error);
    expect(report.steps.steps.map((s) => s.pageUrl)).toEqual(['/login', '/login', '/login', '/login', '', '', '', '']);
  });

  test('takes the origin from the first absolute navigation and writes URLs on it as paths', () => {
    const steps = [
      body({ title: 'Navigate', subtitle: `${ORIGIN}/cart?from=mail`, category: 'navigation' }),
      body({ title: 'Navigate', params: { url: 'https://other.test/x' }, category: 'navigation' }),
    ];
    const { report } = convert(steps, null);
    expect(report.steps.origin).toBe(ORIGIN);
    expect(report.steps.steps.map((s) => s.value)).toEqual(['/cart?from=mail', 'https://other.test/x']);
    expect(report.export!.failedStep).toBeNull();
  });

  test('takes the origin from where the test started, not from the page it ended on', () => {
    const steps = [body({ title: 'Navigate', params: { url: `${ORIGIN}/cart` }, category: 'navigation' })];
    const { report } = convert(steps, null, { origin: 'https://pay.example/checkout' });
    expect(report.steps.origin).toBe(ORIGIN);
    expect(report.steps.steps[0]!.value).toBe('/cart');
    expect(convert([], null, { origin: 'https://pay.example/checkout' }).report.steps.origin).toBe(
      'https://pay.example',
    );
  });

  test('a locator too long for a steps file is left out, and a step left with none is done by hand', () => {
    const long = `getByText('${'Lorem ipsum '.repeat(50)}')`;
    const steps = [body({ title: 'Click', params: { locator: long }, category: 'action' })];
    const { report } = convert(steps, null);
    expect(parseSteps(report.steps).ok).toBe(true);
    expect(report.steps.steps[0]!.action).toBe('manual');
    const snapshots: ExecutionElementSnapshot[] = [
      {
        location: 'tests/checkout.spec.ts:10:5',
        used: null,
        tagName: 'P',
        attributes: { role: 'x'.repeat(100) },
        text: 'Lorem ipsum',
        accessibleName: null,
        alternatives: [{ locator: "getByTestId('intro')", method: 'getByTestId', score: 90 }],
      },
    ];
    const step = convert(steps, null, { snapshots }).report.steps.steps[0]!;
    expect(step.action).toBe('click');
    expect(step.target!.alternatives.map((a) => a.locator)).toEqual(["getByTestId('intro')"]);
    expect(step.target!.role).toHaveLength(64);
  });

  test('a snapshot from another run only says a field takes a secret, never what the element is', () => {
    const steps = [body({ title: 'Fill "hunter2"', subtitle: "locator('#pw')", category: 'input' })];
    const snapshot: ExecutionElementSnapshot = {
      location: 'tests/checkout.spec.ts:10:5',
      used: { method: 'locator', args: ['#pw'] },
      tagName: 'INPUT',
      attributes: { type: 'password' },
      text: null,
      accessibleName: 'Your secret',
      alternatives: [{ locator: "getByLabel('Your secret')", method: 'getByLabel', score: 90 }],
      otherRun: true,
    };
    const step = convert(steps, null, { snapshots: [snapshot] }).report.steps.steps[0]!;
    expect(step).toMatchObject({ action: 'fill', value: null, redacted: true });
    expect(step.target).toMatchObject({ tagName: '', accessibleName: null });
    expect(step.target!.alternatives.map((a) => a.locator)).toEqual(["locator('#pw')"]);
  });

  test('a failure in a beforeEach hook keeps the hook’s steps', () => {
    const { report } = convert(beforeEachFailure.steps, beforeEachFailure.error);
    expect(outline(report)).toEqual(['goto /account', "click getByRole('button', { name: 'Edit profile' })"]);
    expect(report.export!.failedStep).toBe(1);
  });

  test('a failing check on a value becomes a manual step with what the run expected and received', () => {
    const { report } = convert(beforeAllFailure.steps, beforeAllFailure.error, {
      testFilePath: 'tests/seed-hook.spec.ts',
    });
    expect(outline(report)).toEqual(['manual: Check what the test checked: seeding the report fixtures']);
    expect(report.steps.steps[0]!.manual).toMatchObject({
      location: 'tests/seed-hook.spec.ts:6',
      call: 'seeding the report fixtures',
    });
    expect(report.export!.failedStep).toBe(0);
    expect(report.export!.notes.map((n) => n.title)).toEqual(['POST /api/seed']);
  });

  test('leaves the teardown out, and a failure there names no step', () => {
    const afterAll = convert(afterAllFailure.steps, afterAllFailure.error).report;
    expect(outline(afterAll)).toEqual([
      'goto /account',
      "assert getByRole('heading', { name: 'Welcome back' }) toBeVisible",
    ]);
    expect(afterAll.export!.failedStep).toBeNull();
    const teardown = convert(teardownAfterBodyFailure.steps, teardownAfterBodyFailure.error).report;
    expect(outline(teardown).slice(-1)[0]).toBe("assert getByRole('button', { name: 'Nope' }) toBeVisible");
  });

  test('a check the test caught is a note, never a check Replay makes', () => {
    const { report } = convert(caughtProbeFailure.steps, caughtProbeFailure.error);
    expect(outline(report)).toEqual([
      'manual: Open the page the test writes itself (`page.setContent`)',
      "click getByRole('button', { name: 'Save' })",
      "assert locator('.carousel').getByRole('link', { name: '' }) toBeEnabled",
    ]);
    expect(report.export!.notes).toHaveLength(1);
    expect(report.export!.notes[0]!.reason).toBe('Failed, and the test caught the error and went on.');
    expect(convert(caughtProbeTimeout.steps, caughtProbeTimeout.error).report.export!.failedStep).toBe(1);
  });

  test('a block retried with toPass is one manual step, its attempts with it', () => {
    const { report } = convert(toPassFailure.steps, toPassFailure.error);
    expect(outline(report)).toEqual([
      'manual: Open the page the test writes itself (`page.setContent`)',
      'manual: Check what the test checked again and again (toPass); in the run it expected 100 and received 5',
    ]);
    expect(report.export!.notes).toEqual([]);
    expect(report.export!.failedStep).toBe(1);
  });

  test('names the block a failure happened in as the failed step when the block is taken whole', () => {
    const block = body({ title: 'Expect "toPass"', category: 'assertion', failed: true, error: { message: 'boom' } });
    const inner = { ...failingAssertion('Expect "toBe"', '', 'expect(received).toBe(expected)'), depth: 1 };
    const { report } = convert([block, inner], 'expect(received).toBe(expected)');
    expect(report.steps.steps).toHaveLength(1);
    expect(report.export!.failedStep).toBe(0);
  });

  test('a failing value assertion keeps the expected and received values of its error', () => {
    const steps = [
      body({ title: 'Navigate', subtitle: '/cart', category: 'navigation' }),
      failingAssertion(
        'Expect "toHaveText"',
        "getByTestId('total')",
        'Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId(\'total\')\nExpected string: "Total: 42"\nReceived string: "Total: 50"\nTimeout: 5000ms',
      ),
    ];
    const { report } = convert(steps, null);
    expect(report.steps.steps[1]!.assertion).toEqual({
      matcher: 'toHaveText',
      expected: 'Total: 42',
      actual: 'Total: 50',
      negated: false,
      note: null,
    });
    expect(report.export!.failedStep).toBe(1);
    expect(renderBugMarkdown(report)).toContain(
      '- Step 2: the element with test id `total` should read "Total: 42". It shows "Total: 50".',
    );
  });

  test('reads toContainText, toHaveCount, toBeChecked and toHaveURL from their errors', () => {
    const contains = convert(
      [
        failingAssertion(
          'Expect "toContainText"',
          "getByRole('alert')",
          'Error: expect(locator).toContainText(expected) failed\n\nExpected substring: "Saved"\nReceived string: "Error"',
        ),
      ],
      null,
    ).report.steps.steps[0]!.assertion;
    expect(contains).toMatchObject({ matcher: 'toContainText', expected: 'Saved', actual: 'Error' });

    const count = convert(
      [
        failingAssertion(
          'Expect "toHaveCount"',
          "getByRole('listitem')",
          'Error: expect(locator).toHaveCount(expected) failed\n\nExpected: 3\nReceived: 1',
        ),
      ],
      null,
    ).report;
    expect(count.steps.steps[0]!.assertion).toMatchObject({ matcher: 'toHaveCount', expected: '3', actual: '1' });
    expect(renderBugSpec(count).code).toContain("await expect(page.getByRole('listitem')).toHaveCount(3);");

    const checked = convert(
      [
        body({
          title: 'Expect "toBeChecked"',
          subtitle: "getByLabel('Terms')",
          category: 'assertion',
          params: { locator: "getByLabel('Terms')", expected: '{"checked":false,"timeout":5000}' },
        }),
      ],
      null,
    ).report.steps.steps[0]!.assertion;
    expect(checked).toMatchObject({ matcher: 'toBeChecked', negated: true });

    const url = convert(
      [
        body({ title: 'Navigate', subtitle: `${ORIGIN}/cart`, category: 'navigation' }),
        body({
          title: 'Expect "toHaveURL"',
          category: 'assertion',
          failed: true,
          error: {
            message: `Error: expect(page).toHaveURL(expected) failed\n\nExpected string: "${ORIGIN}/thanks"\nReceived string: "${ORIGIN}/cart"`,
          },
        }),
      ],
      null,
    ).report.steps.steps[1]!;
    expect(url).toMatchObject({
      target: null,
      assertion: { matcher: 'toHaveURL', expected: '/thanks', actual: '/cart' },
    });
  });

  test('hands a regex expectation or a matcher Replay cannot check to a person, and notes passing value checks', () => {
    const steps = [
      body({ title: 'Expect "toHaveText"', subtitle: "getByRole('status')", category: 'assertion' }),
      body({ title: 'Expect "toHaveScreenshot"', subtitle: "getByRole('main')", category: 'assertion' }),
      failingAssertion(
        'Expect "toHaveText"',
        "getByRole('heading')",
        'Error: expect(locator).toHaveText(expected) failed\n\nExpected pattern: /Order #\\d+/\nReceived string: "Oops"',
      ),
    ];
    const { report } = convert(steps, null);
    expect(outline(report)).toEqual([
      'manual: Check `getByRole(\'heading\')` with toHaveText; in the run it expected /Order #\\d+/ and received "Oops"',
    ]);
    expect(report.export!.notes.map((n) => n.reason)).toEqual([
      'A check that passed (toHaveText); the run does not keep the value it expected.',
      'A check that passed (toHaveScreenshot); Replay cannot make it.',
    ]);
  });

  test('reads a typed value from a 1.61 title, before the chain it ends with', () => {
    const steps = [
      body({ title: 'Fill "say "hi" twice" getByLabel(\'Message\')', category: 'input' }),
      body({ title: 'Press "Enter" getByLabel(\'Message\')', category: 'input' }),
      body({ title: 'Type "abc" getByRole(\'searchbox\')', category: 'input' }),
      body({ title: "Tap getByRole('button', { name: 'Send' })", category: 'action' }),
    ];
    expect(outline(convert(steps, null).report)).toEqual([
      'fill getByLabel(\'Message\') say "hi" twice',
      "press getByLabel('Message') Enter",
      "fill getByRole('searchbox') abc",
      "click getByRole('button', { name: 'Send' })",
    ]);
  });

  test('a value the run kept only in part, or masked, is filled by hand', () => {
    const cut = `${'x'.repeat(199)}…`;
    const steps = [
      body({
        title: 'Fill',
        subtitle: "getByLabel('Notes')",
        category: 'input',
        params: { locator: "getByLabel('Notes')", value: cut },
      }),
      body({ title: 'Fill "[masked-token]"', subtitle: "getByLabel('Token')", category: 'input' }),
    ];
    expect(outline(convert(steps, null).report)).toEqual([
      "manual: Fill `getByLabel('Notes')` as the test did; the run keeps only part of the value",
      "manual: Fill `getByLabel('Token')` as the test did; the run keeps only part of the value",
    ]);
  });

  test('chooses the option a select step kept in its options, and names the ones Replay cannot choose', () => {
    const locator = "getByLabel('Domaine')";
    /** A `Select option` step as the reporter stores the params Playwright renders. */
    const select = (options: unknown[]) => {
      const [stored] = flattenSteps([{ title: 'Select option', subtitle: locator, params: { locator, options } }]);
      return body({ title: 'Select option', subtitle: locator, category: 'input', params: stored!.params });
    };
    const steps = [
      select([{ valueOrLabel: 'ELEC' }]),
      select([{ label: 'Gaz' }]),
      select([{ value: 'GAZ' }]),
      select([{ index: 2 }]),
      select([{ valueOrLabel: 'ELEC' }, { valueOrLabel: 'GAZ' }]),
      select([{ valueOrLabel: 'x'.repeat(300) }]),
      body({ title: 'Select option', subtitle: locator, category: 'input', params: { locator } }),
    ];
    const { report, manualSteps } = convert(steps, null);
    expect(outline(report)).toEqual([
      `selectOption ${locator} ELEC`,
      `selectOption ${locator} Gaz`,
      `selectOption ${locator} GAZ`,
      `manual: Choose in \`${locator}\` the option at index 2`,
      `manual: Choose in \`${locator}\` "ELEC" and "GAZ"`,
      `manual: Choose in \`${locator}\` the option the test chose; the run does not keep which`,
      `manual: Choose in \`${locator}\` the option the test chose; the run does not keep which`,
    ]);
    expect(manualSteps).toBe(4);
    expect(parseSteps(report.steps).ok).toBe(true);
  });

  test('turns the mouse, the keyboard and unplayable actions into manual steps, and setup calls into notes', () => {
    const steps = [
      body({ title: 'Press "Escape"', category: 'input' }),
      body({ title: 'Click', category: 'action', params: { x: 10.4, y: 20 } }),
      body({ title: 'Go back', category: 'navigation' }),
      body({ title: 'Set input files', subtitle: "getByLabel('Invoice')", category: 'input' }),
      body({ title: 'Focus', subtitle: "getByLabel('Name')", category: 'other' }),
      body({ title: 'Evaluate', category: 'other' }),
      body({ title: 'Add init script', category: 'other' }),
      body({ title: 'Wait for timeout', category: 'wait' }),
      body({ title: 'Create page', category: 'other', location: undefined }),
    ];
    const { report, manualSteps } = convert(steps, null);
    expect(outline(report)).toEqual([
      'press Escape',
      'manual: Do with the mouse what the test did at the point (10, 20) of the page: Click',
      'manual: Go back to the previous page in the browser',
      "manual: Choose in `getByLabel('Invoice')` the file the test chose; the run does not keep its name",
      "manual: Put the focus on `getByLabel('Name')`",
    ]);
    expect(manualSteps).toBe(4);
    expect(report.export!.notes.map((n) => n.title)).toEqual(['Evaluate', 'Add init script']);
  });

  test('fills the target from the snapshot taken at the call site, a password field’s type included', () => {
    const steps = [
      body({
        title: 'Fill "hunter2"',
        subtitle: "locator('#pw')",
        category: 'input',
        location: '/work/shop/tests/checkout.spec.ts:12:20',
      }),
    ];
    const snapshots: ExecutionElementSnapshot[] = [
      {
        location: 'tests/checkout.spec.ts:12:20',
        used: { method: 'locator', args: ['#pw'] },
        tagName: 'INPUT',
        attributes: { type: 'password', 'data-testid': 'password' },
        text: null,
        accessibleName: 'Your secret',
        alternatives: [
          { locator: "getByTestId('password')", method: 'getByTestId', score: 100 },
          { locator: 'not a locator(', method: 'x', score: 1 },
        ],
      },
    ];
    const step = convert(steps, null, { snapshots }).report.steps.steps[0]!;
    expect(step).toMatchObject({ action: 'fill', value: null, redacted: true });
    expect(step.target).toEqual({
      tagName: 'input',
      role: null,
      accessibleName: 'Your secret',
      testId: 'password',
      text: null,
      alternatives: [
        { locator: "locator('#pw')", method: 'locator', score: 100 },
        { locator: "getByTestId('password')", method: 'getByTestId', score: 100 },
      ],
    });
  });

  test('keeps the steps that lead to the failure when there are more than a steps file holds', () => {
    const steps = Array.from({ length: 250 }, (_, i) =>
      body({ title: 'Click', subtitle: `getByRole('button', { name: 'B${i}' })`, category: 'action' }),
    );
    steps[249] = {
      ...steps[249]!,
      failed: true,
      error: { message: 'TimeoutError: locator.click: Timeout 1ms exceeded.' },
    };
    const { report } = convert(steps, 'TimeoutError: locator.click: Timeout 1ms exceeded.');
    expect(report.steps.steps).toHaveLength(200);
    expect(report.steps.steps[0]!.manual!.description).toBe(
      'Do the first 51 steps of the test by hand, up to where step 52 starts: a steps file holds 200 steps',
    );
    expect(report.steps.steps[1]!.target!.accessibleName).toBe('B51');
    expect(report.export!.failedStep).toBe(199);
  });

  test('carries the failed requests, the console and the screenshot, and checks as a report read back', () => {
    const { report } = convert(bodyFailure.steps, bodyFailure.error, {
      executionId: 42,
      origin: ORIGIN,
      viewport: { width: 1280, height: 720 },
      browser: 'chromium',
      time: 1790000000000,
      screenshot: true,
      console: [{ level: 'error', message: 'Uncaught TypeError: x is undefined', time: 1790000000500 }],
      requests: [
        { method: 'post', url: `${ORIGIN}/api/cart/12?coupon=abc`, status: 500 },
        { method: 'GET', url: `${ORIGIN}/api/cart`, status: 200 },
      ],
    });
    expect(report.evidence.requests).toEqual([
      { method: 'POST', url: '/api/cart/:id?coupon=%3Credacted%3E', status: 500, page: '', time: 0 },
    ]);
    expect(report.evidence.console).toHaveLength(1);
    expect(report.evidence.screenshots).toEqual([
      { file: 'screenshots/1-finish.png', step: null, moment: 'finish', takenAt: 1790000000000 },
    ]);
    expect(report.steps.viewports).toEqual([{ step: 0, width: 1280, height: 720 }]);
    expect(parseSteps(report.steps).ok).toBe(true);

    const evidence = { v: report.v, context: report.context, evidence: report.evidence, export: report.export };
    const back = bugReportFromFiles({ steps: JSON.stringify(report.steps), evidence: JSON.stringify(evidence) });
    expect(back.ok && back.report).toEqual(report);
  });

  test('writes the report’s Markdown with the failed step and what is not replayed', () => {
    const markdown = renderBugMarkdown(
      convert(beforeAllFailure.steps, beforeAllFailure.error, { testFilePath: 'tests/seed-hook.spec.ts' }).report,
    );
    expect(markdown).toContain('1. By hand: Check what the test checked: seeding the report fixtures');
    expect(markdown).toContain('   - The test failed at this step in the test run');
    expect(markdown).toContain(
      '## Not replayed\n\nCalls of the test that these steps leave out, so neither Replay nor the spec performs them:\n\n- `POST /api/seed` at `tests/seed-hook.spec.ts:5`: An API request the test sends itself; Replay sends none.',
    );
  });
});
