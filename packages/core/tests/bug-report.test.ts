import { describe, test, expect } from 'vitest';
import ts from 'typescript';
import {
  BUG_REPORT_MEDIA_TYPE,
  BUG_REPORT_VERSION,
  bugContextFrom,
  bugReportFromFiles,
  bugTitle,
  describeBrowser,
  describeStepInWords,
  emptyBugEvidence,
  expectedSteps,
  isBugReportArchive,
  parseBugReport,
  renderBugMarkdown,
  renderBugSpec,
  reportedRequestUrl,
  specRunVerdict,
  stepShotFile,
  summarizeEvidence,
  type BugReport,
} from '../src/bug-report';
import { bugPhrases } from '../src/bug-phrases';
import { normalizeSteps, buildSession, type RawCaptureEvent, type RecordedTarget } from '../src/recording';
import { parseSteps, toStepsDocument } from '../src/steps';

const ORIGIN = 'https://staging.acme.test';

function target(overrides: Partial<RecordedTarget>): RecordedTarget {
  return {
    tagName: 'button',
    role: null,
    accessibleName: null,
    testId: null,
    text: null,
    alternatives: [],
    ...overrides,
  };
}

function ev(overrides: Partial<RawCaptureEvent>): RawCaptureEvent {
  return {
    kind: 'click',
    target: null,
    value: null,
    checked: null,
    inputType: null,
    isPasswordField: false,
    pageUrl: `${ORIGIN}/cart`,
    timestamp: 1,
    ...overrides,
  };
}

const coupon = target({
  tagName: 'input',
  role: 'textbox',
  accessibleName: 'Coupon',
  alternatives: [{ locator: `getByLabel('Coupon')`, method: 'getByLabel', score: 90 }],
});
const apply = target({
  role: 'button',
  accessibleName: 'Apply',
  text: 'Apply',
  alternatives: [{ locator: `getByRole('button', { name: 'Apply' })`, method: 'getByRole', score: 95 }],
});
const total = target({
  tagName: 'p',
  testId: 'cart-total',
  text: 'Total: 40',
  alternatives: [
    { locator: `locator('div > p:nth-child(3)')`, method: 'locator', score: 60 },
    { locator: `getByTestId('cart-total')`, method: 'getByTestId', score: 100 },
  ],
});

function couponReport(): BugReport {
  const events = [
    ev({ kind: 'navigate', value: `${ORIGIN}/cart?session=abc`, timestamp: 1 }),
    ev({ kind: 'input', target: coupon, value: 'SPRING10', timestamp: 2 }),
    ev({ kind: 'click', target: apply, timestamp: 3 }),
    ev({
      kind: 'assert',
      target: total,
      assertion: {
        matcher: 'toHaveText',
        expected: 'Total: 42',
        actual: 'Total: 40',
        negated: false,
        note: 'the coupon is ignored',
      },
      timestamp: 4,
    }),
    ev({
      kind: 'assert',
      target: target({
        role: 'button',
        accessibleName: 'Download invoice',
        alternatives: [
          { locator: `getByRole('button', { name: 'Download invoice' })`, method: 'getByRole', score: 90 },
        ],
      }),
      assertion: { matcher: 'toBeVisible', expected: null, actual: null, negated: false, note: null },
      timestamp: 5,
    }),
  ];
  const steps = normalizeSteps(events);
  return {
    v: BUG_REPORT_VERSION,
    steps: toStepsDocument(buildSession(steps, 1), { title: 'Coupon not applied to the total' }),
    evidence: {
      ...emptyBugEvidence(),
      console: [
        {
          level: 'error',
          source: 'console',
          message: 'Coupon failed: 500',
          page: '/cart',
          time: Date.UTC(2026, 8, 27, 14, 3, 12),
        },
      ],
      requests: [
        { method: 'POST', url: '/api/cart/coupon', status: 500, page: '/cart', time: Date.UTC(2026, 8, 27, 14, 3, 12) },
      ],
      screenshots: [{ file: 'screenshots/1-marked.png', step: 3, moment: 'marked', takenAt: 4 }],
      outline: '- main:\n  - paragraph: "Total: 40"',
    },
    context: bugContextFrom({
      url: `${ORIGIN}/cart?session=abc#top`,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      time: Date.UTC(2026, 8, 27, 14, 3),
      extensionVersion: '0.39.0',
    }),
  };
}

describe('bug report', () => {
  test('the steps are a steps document that parseSteps reads back, assertions included', () => {
    const report = couponReport();
    const parsed = parseSteps(JSON.stringify(report.steps));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    expect(parsed.steps.steps.map((s) => s.action)).toEqual(['goto', 'fill', 'click', 'assert', 'assert']);
    expect(parsed.steps.steps[3]!.assertion).toMatchObject({ expected: 'Total: 42', actual: 'Total: 40' });
    expect(expectedSteps(report).map((e) => e.index)).toEqual([3, 4]);
  });

  test('the failing test is marked to fail, tagged, relative, and uses the stable locator', () => {
    const { code, warnings } = renderBugSpec(couponReport());
    expect(warnings).toEqual([]);
    expect(code).toContain(`test('bug: coupon not applied to the total', {`);
    expect(code).toContain(`tag: ['@bug'],`);
    expect(code).toContain('  test.fail(); // passes while the bug exists; remove this line with the fix');
    expect(code).toContain(`await page.goto('/cart?session=abc');`);
    expect(code).toContain(`await page.getByLabel('Coupon').fill('SPRING10');`);
    expect(code).toContain(
      `await expect(page.getByTestId('cart-total')).toHaveText('Total: 42'); // recorded: 'Total: 40'`,
    );
    expect(code).toContain(`await expect(page.getByRole('button', { name: 'Download invoice' })).toBeVisible();`);
    const out = ts.transpileModule(code, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    });
    expect(out.diagnostics ?? []).toEqual([]);
  });

  test('options add to the defaults, such as the project’s test import, or no test.fail() for a run', () => {
    const { code } = renderBugSpec(couponReport(), { testImport: '../fixtures', expectFail: false });
    expect(code).toContain(`from '../fixtures';`);
    expect(code).not.toContain('test.fail()');
  });

  test('the Markdown and the spec give the viewport each step was played at', () => {
    const base = couponReport();
    const report: BugReport = {
      ...base,
      steps: {
        ...base.steps,
        viewports: [
          { step: 0, width: 1280, height: 800 },
          { step: 2, width: 390, height: 844 },
        ],
      },
    };
    const md = renderBugMarkdown(report);
    expect(md).toContain('1. Go to `/cart?session=abc`\n   - Viewport from this step: 1280×800');
    expect(md).toMatch(/\n3\. .*\n {3}- Viewport from this step: 390×844/);
    expect(renderBugMarkdown(report, bugPhrases('fr'))).toContain('Fenêtre à partir de cette étape\u00a0: 390×844');
    const zoomed: BugReport = {
      ...report,
      steps: { ...report.steps, viewports: [{ step: 0, width: 1024, height: 576, zoom: 1.25 }] },
    };
    expect(renderBugMarkdown(zoomed)).toContain('   - Viewport from this step: 1024×576, at 125% zoom');
    expect(renderBugMarkdown(zoomed, bugPhrases('fr'))).toContain('1024×576, zoom à 125\u202f%');
    const { code } = renderBugSpec(report);
    expect(code).toContain('await page.setViewportSize({ width: 1280, height: 800 });');
    expect(code).toContain('await page.setViewportSize({ width: 390, height: 844 });');
  });

  test('the Markdown has the steps in words, expected and actual, the note and the evidence', () => {
    const md = renderBugMarkdown(couponReport());
    expect(md).toContain('# Coupon not applied to the total');
    expect(md).toContain(
      `**Page** \`/cart\` on ${ORIGIN} · Chrome 141 · 1280×720 · 2026-09-27 14:03 UTC · Piwi Picker 0.39.0`,
    );
    expect(md).toContain('1. Go to `/cart?session=abc`');
    expect(md).toContain('2. Fill text field "Coupon" with "SPRING10"');
    expect(md).toContain('3. Click button "Apply"');
    expect(md).toContain('4. The element with test id `cart-total` should read "Total: 42"');
    expect(md).toContain('   - Actual: "Total: 40"');
    expect(md).toContain('   - Note: the coupon is ignored');
    expect(md).toContain('5. Button "Download invoice" should be visible');
    expect(md).toContain(
      '- Step 4: the element with test id `cart-total` should read "Total: 42". It shows "Total: 40".',
    );
    expect(md).toContain('1 screenshot · 1 console error · 1 failed request · page outline');
    expect(md).toContain('- `screenshots/1-marked.png`, after step 4');
    expect(md).toContain('- error on `/cart` at 14:03:12: `Coupon failed: 500`');
    expect(md).toContain('- `POST /api/cart/coupon` → 500, on `/cart` at 14:03:12');
    expect(md).toContain('```yaml\n- main:\n  - paragraph: "Total: 40"\n```');
    expect(md).toContain('not Playwright’s own');
    expect(md).not.toMatch(/ARIA snapshot\b(?! ?,? not)/);
  });

  test('the Markdown keeps text on its line and in its code span', () => {
    const report = couponReport();
    report.steps.title = 'Broken <b>\n total';
    report.evidence.console[0]!.message = 'a `tick` inside';
    const md = renderBugMarkdown(report);
    expect(md).toContain('# Broken &lt;b> total');
    expect(md).toContain('``a `tick` inside``');
  });

  test('a report without a screenshot says why, and one without a title is named by its page', () => {
    const report = couponReport();
    report.steps.title = null;
    report.evidence.screenshots = [];
    report.evidence.screenshotNote = 'open Piwi Picker on the page to allow one';
    expect(bugTitle(report)).toBe('Bug on /cart');
    const md = renderBugMarkdown(report);
    expect(md).toContain('No screenshot: open Piwi Picker on the page to allow one');
    expect(summarizeEvidence(report.evidence)).toMatch(/^no screenshot · /);
  });

  test('request URLs lose their query values and fragment, and keep a foreign origin', () => {
    expect(reportedRequestUrl('/api/cart/coupon?code=SPRING10&x=1#a', `${ORIGIN}/cart`)).toBe(
      '/api/cart/coupon?code=%3Credacted%3E&x=%3Credacted%3E',
    );
    expect(reportedRequestUrl('https://api.acme.test/v1/orders/123', `${ORIGIN}/cart`)).toBe(
      'https://api.acme.test/v1/orders/:id',
    );
    expect(reportedRequestUrl('data:text/plain,hi', `${ORIGIN}/cart`)).toBe('data:…');
  });

  test('the context has the page, the browser and no query', () => {
    const { context } = couponReport();
    expect(context).toMatchObject({ origin: ORIGIN, pageKey: '/cart', path: '/cart', browser: 'Chrome 141' });
    expect(describeBrowser('Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toBe('Edge 141');
    expect(describeBrowser('Mozilla/5.0 … HeadlessChrome/141.0.0.0 Safari/537.36')).toBe('Chrome 141');
    expect(describeBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe(
      'Firefox 130',
    );
  });

  test('the context keys the page without the URL mapping’s path prefix, and keeps it through parsing', () => {
    const at = (url: string, pathPrefix: string | null) =>
      bugContextFrom({ url, userAgent: null, viewport: null, time: 0, extensionVersion: null, pathPrefix });
    const prefixed = at(`${ORIGIN}/app/orders/42`, '/app/');
    expect(prefixed).toMatchObject({ pageKey: '/orders/:id', path: '/app/orders/42', pathPrefix: '/app' });
    // Finished outside the prefix: the page keeps its path, and the mapping is kept for the steps' pages.
    expect(at(`${ORIGIN}/application`, '/app')).toMatchObject({ pageKey: '/application', pathPrefix: '/app' });
    expect(at(`${ORIGIN}/login`, null)).not.toHaveProperty('pathPrefix');
    expect(at('about:blank', '/app')).not.toHaveProperty('pathPrefix');
    const parsed = parseBugReport({ ...couponReport(), context: prefixed });
    expect(parsed.ok && parsed.report.context.pathPrefix).toBe('/app');
    const odd = parseBugReport({ ...couponReport(), context: { ...prefixed, pathPrefix: '/app?x' } });
    expect(odd.ok && odd.report.context).not.toHaveProperty('pathPrefix');
  });

  test('the context keys the page with the tests’ path prefix in front, and keeps it through parsing', () => {
    const context = bugContextFrom({
      url: `${ORIGIN}/cart`,
      userAgent: null,
      viewport: null,
      time: 0,
      extensionVersion: null,
      testPathPrefix: 'app/',
    });
    expect(context).toMatchObject({ pageKey: '/app/cart', path: '/cart', testPathPrefix: '/app' });
    expect(context).not.toHaveProperty('pathPrefix');
    const parsed = parseBugReport({ ...couponReport(), context });
    expect(parsed.ok && parsed.report.context.testPathPrefix).toBe('/app');
  });

  test('an element whose text is asserted is not named by that text', () => {
    const report = couponReport();
    const step = report.steps.steps[3]!;
    step.target = { ...step.target!, testId: null, accessibleName: 'Total: 40', text: 'Total: 40' };
    expect(describeStepInWords(step)).toBe(`\`locator('div > p:nth-child(3)')\` should read "Total: 42"`);
    step.target.alternatives = [];
    expect(describeStepInWords(step)).toBe('The p should read "Total: 42"');
  });

  test('steps in words cover every action, and a password is never shown', () => {
    const words = (step: Parameters<typeof describeStepInWords>[0]) => describeStepInWords(step);
    const base = { target: coupon, value: null, redacted: false, pageUrl: '/cart', timestamp: 1 };
    expect(words({ ...base, action: 'fill', value: null, redacted: true })).toBe(
      'Fill text field "Coupon" with a password (not recorded)',
    );
    expect(words({ ...base, action: 'press', value: 'Enter' })).toBe('Press Enter in text field "Coupon"');
    expect(words({ ...base, target: null, action: 'press', value: 'ControlOrMeta+k' })).toBe('Press Ctrl+K');
    expect(words({ ...base, action: 'selectOption', value: 'FR' })).toBe('Select "FR" in text field "Coupon"');
    expect(
      words({
        ...base,
        action: 'assert',
        target: null,
        assertion: { matcher: 'toHaveURL', expected: '/thanks', actual: '/cart', negated: false, note: null },
      }),
    ).toBe('The page should be `/thanks`');
  });
});

describe('parseBugReport', () => {
  test('reads back a report written as JSON', () => {
    const report = couponReport();
    const parsed = parseBugReport(JSON.stringify(report));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.steps).toEqual(report.steps);
    expect(parsed.report.evidence.requests).toEqual(report.evidence.requests);
    expect(parsed.report.evidence.screenshots).toEqual(report.evidence.screenshots);
    expect(parsed.report.context.origin).toBe(report.context.origin);
  });

  test('refuses steps that are not a steps document', () => {
    const parsed = parseBugReport({ ...couponReport(), steps: { v: 1, steps: 'nope' } });
    expect(parsed.ok).toBe(false);
    expect(parseBugReport({ ...couponReport(), v: 2 }).ok).toBe(false);
    expect(parseBugReport('{').ok).toBe(false);
  });

  test('drops evidence that does not fit its shape, and caps what it keeps', () => {
    const report = couponReport();
    const parsed = parseBugReport({
      ...report,
      evidence: {
        ...report.evidence,
        console: [{ level: 'info', source: 'console', message: 'x' }, ...report.evidence.console],
        requests: [{ method: 'GET; rm', url: '/a', status: 500 }],
        screenshots: [{ file: '../../etc/passwd', moment: 'marked' }, ...report.evidence.screenshots],
        outline: Array.from({ length: 900 }, (_, i) => `- line ${i}`).join('\n'),
      },
      context: { ...report.context, origin: 'javascript:alert(1)', path: 'not-a-path' },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.evidence.console).toHaveLength(1);
    expect(parsed.report.evidence.requests).toEqual([]);
    expect(parsed.report.evidence.screenshots.map((s) => s.file)).toEqual(['screenshots/1-marked.png']);
    expect(parsed.report.evidence.outline!.split('\n')).toHaveLength(400);
    expect(parsed.report.context.origin).toBeNull();
    expect(parsed.report.context.path).toBeNull();
  });
});

describe('bug report archive', () => {
  /** The local header and data of one stored zip entry, as an archive starts. */
  function firstEntry(name: string, data: string, method = 0): Uint8Array {
    const nameBytes = new TextEncoder().encode(name);
    const dataBytes = new TextEncoder().encode(data);
    const out = new Uint8Array(30 + nameBytes.length + dataBytes.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, method, true);
    view.setUint32(18, dataBytes.length, true);
    view.setUint32(22, dataBytes.length, true);
    view.setUint16(26, nameBytes.length, true);
    out.set(nameBytes, 30);
    out.set(dataBytes, 30 + nameBytes.length);
    return out;
  }

  test('tells a bug report archive by its first entry, whatever the file is named', () => {
    expect(isBugReportArchive(firstEntry('mimetype', BUG_REPORT_MEDIA_TYPE))).toBe(true);
    expect(isBugReportArchive(firstEntry('mimetype', 'application/epub+zip'))).toBe(false);
    expect(isBugReportArchive(firstEntry('mimetype', BUG_REPORT_MEDIA_TYPE, 8))).toBe(false);
    expect(isBugReportArchive(firstEntry('steps.json', '{}'))).toBe(false);
    expect(isBugReportArchive(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });

  test('reads a report back from its steps.json and evidence.json', () => {
    const report = couponReport();
    const parsed = bugReportFromFiles({
      steps: JSON.stringify(report.steps),
      evidence: JSON.stringify({ v: report.v, context: report.context, evidence: report.evidence }),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.steps).toEqual(report.steps);
    expect(parsed.report.evidence.requests).toEqual(report.evidence.requests);
    expect(parsed.report.context.pageKey).toBe(report.context.pageKey);
  });

  test('reads the steps alone, and refuses files that are not JSON', () => {
    const parsed = bugReportFromFiles({ steps: JSON.stringify(couponReport().steps), evidence: null });
    expect(parsed.ok && parsed.report.evidence).toEqual(emptyBugEvidence());
    expect(bugReportFromFiles({ steps: '{', evidence: null })).toEqual({
      ok: false,
      errors: ['steps.json: not valid JSON'],
    });
    expect(bugReportFromFiles({ steps: '{}', evidence: '{' }).ok).toBe(false);
  });
});

describe('step screenshots', () => {
  const view = (id: string) => ({ id, box: { x: 10, y: 20, width: 100, height: 30 } });

  test('a step keeps the view of the event it starts from, which a steps document leaves out', () => {
    const steps = normalizeSteps([
      ev({ kind: 'navigate', value: `${ORIGIN}/cart`, timestamp: 1 }),
      ev({ kind: 'input', target: coupon, value: 'S', timestamp: 2, view: view('a') }),
      ev({ kind: 'input', target: coupon, value: 'SP', timestamp: 3, view: view('b') }),
      ev({ kind: 'click', target: apply, timestamp: 4, view: view('c') }),
      ev({ kind: 'click', target: apply, timestamp: 5, view: view('d') }),
      ev({ kind: 'dblclick', target: apply, timestamp: 6, view: view('e') }),
    ]);
    expect(steps.map((step) => step.view?.id ?? null)).toEqual([null, 'a', 'c']);
    const doc = toStepsDocument(buildSession(steps, 1));
    expect(doc.steps.some((step) => 'view' in step)).toBe(false);
  });

  test('a report reads its step screenshots back, one per step, named after the step, and counts them', () => {
    const report = couponReport();
    const shot = (step: number, file = stepShotFile(step)) => ({
      step,
      file,
      box: { x: 1, y: 2, width: 3, height: 4 },
      viewport: { width: 1280, height: 720 },
      takenAt: 9,
    });
    expect(stepShotFile(0)).toBe('steps/001.jpg');
    const parsed = parseBugReport({
      ...report,
      evidence: {
        ...report.evidence,
        stepShots: [shot(2), shot(1), shot(1), shot(3, '../steps/004.jpg'), { ...shot(4), box: 'x', viewport: null }],
      },
    });
    expect(parsed.ok && parsed.report.evidence.stepShots).toEqual([
      shot(1),
      shot(2),
      { ...shot(4), box: null, viewport: null },
    ]);
    expect(parseBugReport(report).ok && parseBugReport(report)).not.toHaveProperty('report.evidence.stepShots');
    if (!parsed.ok) return;
    expect(summarizeEvidence(parsed.report.evidence)).toBe(
      '1 screenshot · 3 step screenshots · 1 console error · 1 failed request · page outline',
    );
  });
});

describe('specRunVerdict', () => {
  const report = couponReport();
  const { code, stepLines } = renderBugSpec(report, { expectFail: false });
  const lines = code.split('\n');
  const steps = report.steps.steps;
  const assertAt = steps.findIndex((s) => s.action === 'assert');

  test('each step starts on the line that performs it', () => {
    expect(stepLines).toHaveLength(steps.length);
    expect(lines[stepLines[0]! - 1]).toContain('page.goto(');
    expect(lines[stepLines[1]! - 1]).toContain(".fill('SPRING10')");
    // An expected result starts with the reporter's note, then asserts.
    expect(lines.slice(stepLines[assertAt]! - 1, stepLines[assertAt + 1]! - 1).join('\n')).toContain(
      "toHaveText('Total: 42')",
    );
  });

  test('failing on the expected result reproduces, with the value found', () => {
    const verdict = specRunVerdict(steps, stepLines, {
      status: 'failed',
      line: stepLines[assertAt]! + 1,
      message:
        'Error: expect(locator).toHaveText(expected) failed\n\nExpected string: "Total: 42"\nReceived string: "Total: 40"',
    });
    expect(verdict).toEqual({ kind: 'reproduced', step: assertAt, found: '"Total: 40"' });
  });

  test('failing on an earlier step diverges there', () => {
    const verdict = specRunVerdict(steps, stepLines, {
      status: 'timedOut',
      line: stepLines[1]!,
      message: "Test timeout of 30000ms exceeded.\nlocator.fill: waiting for getByLabel('Coupon')",
    });
    expect(verdict).toEqual({ kind: 'diverged', step: 1, reason: 'Test timeout of 30000ms exceeded.' });
  });

  test('reads a message without its terminal colors', () => {
    const verdict = specRunVerdict(steps, stepLines, {
      status: 'failed',
      line: stepLines[0]!,
      message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED\nCall log:\n\u001b[2m  - navigating\u001b[22m',
    });
    expect(verdict).toEqual({ kind: 'diverged', step: 0, reason: 'Error: page.goto: net::ERR_CONNECTION_REFUSED' });
  });

  test('passing does not reproduce; a stopped run says so', () => {
    expect(specRunVerdict(steps, stepLines, { status: 'passed', line: null, message: null })).toEqual({
      kind: 'not-reproduced',
    });
    expect(specRunVerdict(steps, stepLines, { status: 'interrupted', line: null, message: null })).toEqual({
      kind: 'stopped',
    });
  });

  test('a function call covers the lines of the steps it stands for', () => {
    const { stepLines: body } = renderBugSpec(report, { expectFail: false, format: 'body' });
    expect(body).toHaveLength(steps.length);
    expect([...body].sort((a, b) => a - b)).toEqual(body);
  });
});

describe('a report made from a test run', () => {
  const made = (): Record<string, unknown> => ({
    v: BUG_REPORT_VERSION,
    steps: toStepsDocument(
      buildSession(
        [
          {
            action: 'manual',
            target: null,
            value: null,
            redacted: false,
            pageUrl: '',
            timestamp: 1,
            manual: {
              description: 'Open the page the test writes itself',
              location: 'tests/a.spec.ts:4',
              call: 'Set content',
            },
          },
        ],
        1,
      ),
    ),
    evidence: emptyBugEvidence(),
    context: {},
    export: {
      source: 'execution',
      executionId: 42,
      testTitle: 'checkout',
      failedStep: 0,
      notes: [{ title: 'POST /api/seed', location: 'tests/a.spec.ts:5', reason: 'An API request' }],
      notesDropped: 0,
    },
  });

  test('keeps its export block, and drops one that is not one', () => {
    const read = parseBugReport(made());
    expect(read.ok && read.report.export).toEqual({
      source: 'execution',
      executionId: 42,
      testTitle: 'checkout',
      failedStep: 0,
      notes: [{ title: 'POST /api/seed', location: 'tests/a.spec.ts:5', reason: 'An API request' }],
      notesDropped: 0,
    });
    const odd = { ...made(), export: { source: 'browser', failedStep: 0 } };
    const dropped = parseBugReport(odd);
    expect(dropped.ok && 'export' in dropped.report).toBe(false);
    const wrong = {
      ...made(),
      export: { source: 'execution', executionId: -1, failedStep: 9, notes: [{ title: 1 }, 'x'], notesDropped: 'x' },
    };
    const capped = parseBugReport(wrong);
    expect(capped.ok && capped.report.export).toEqual({
      source: 'execution',
      executionId: null,
      testTitle: null,
      failedStep: null,
      notes: [],
      notesDropped: 0,
    });
  });

  test('writes a manual step in words, with the call it stands for, and the notes as Not replayed', () => {
    const read = parseBugReport(made());
    const report = read.ok ? read.report : null;
    expect(describeStepInWords(report!.steps.steps[0]!)).toBe('By hand: Open the page the test writes itself');
    const markdown = renderBugMarkdown(report!);
    expect(markdown).toContain(
      '1. By hand: Open the page the test writes itself\n   - `Set content` · `tests/a.spec.ts:4`\n   - The test failed at this step in the test run',
    );
    expect(markdown).toContain('## Not replayed');
    expect(markdown).toContain('- `POST /api/seed` at `tests/a.spec.ts:5`: An API request');
  });
});
