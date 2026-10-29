import { describe, expect, test } from 'vitest';
import { renderNotificationEmailAt, renderDigestEmailAt } from '#shared/notifications/render-email';
import { codeBlock, outcomeBar } from '#shared/notifications/email-blocks';
import { historySentence, runSegments, testHistorySentence } from '#shared/notifications/message-parts';
import type { RunFinishedPayload, RunHistoryEntry } from '#shared/notification-events';

const SITE = 'https://piwi.example.com';

const snippet = [
  "    40 |   test('pays', async ({ page }) => {",
  "    41 |     await page.goto('/checkout');",
  ">   42 |     await page.getByRole('button', { name: 'Pay' }).click();",
  '       |                                                     ^',
  '    43 |   });',
].join('\n');

const history = (statuses: string[]): RunHistoryEntry[] =>
  statuses.map((status, i) => ({ runId: 100 + i, status, failedTests: status === 'failed' ? 2 : 0 }));

const failedRun: RunFinishedPayload = {
  runId: 104,
  projectId: 1,
  projectName: 'checkout',
  status: 'failed',
  totalTests: 50,
  failedTests: 5,
  passedTests: 42,
  flakyTests: 2,
  skippedTests: 3,
  didNotRunTests: 0,
  durationMs: 512_000,
  branch: 'main',
  environment: 'staging',
  commit: {
    sha: 'abcdef1234567',
    message: 'Check the card',
    author: 'Alex',
    url: 'https://github.com/acme/shop/commit/abcdef1234567',
  },
  ciUrl: 'https://ci.example.com/build/9',
  owners: ['@team/pay'],
  history: history(['passed', 'passed', 'passed', 'passed', 'failed']),
  topFailures: [
    {
      title: 'pays with a saved card',
      suitePath: ['Checkout', 'Payment'],
      filePath: 'tests/pay.spec.ts',
      line: 40,
      browserName: 'chromium',
      headline: "getByRole('button', { name: 'Pay' }) never became enabled",
      errorExcerpt: 'Error: expect(locator).toHaveText(expected) failed\n\nExpected: "Paid"\nReceived: "Pending"',
      source: { file: 'tests/pay.spec.ts', line: 42, snippet },
      history: ['passed', 'passed', 'flaky', 'passed', 'failed'],
      testCaseId: 7,
      executionId: 70,
    },
  ],
};

describe('the run.failed email', () => {
  const { html, text } = renderNotificationEmailAt('run.failed', failedRun, SITE);

  test('opens with the failure count, the run and its scope', () => {
    expect(html).toContain('Run failed · checkout');
    expect(html).toMatch(/>5<\/span> tests failed/);
    expect(html).toContain('out of 50');
    expect(html).toContain('Run #104 · main · staging · 8m 32s');
  });

  test('draws the outcome bar with flaky tests apart from the passed ones', () => {
    expect(html).toContain('<strong style="color:#18181b;">40</strong> passed');
    expect(html).toContain('<strong style="color:#18181b;">2</strong> flaky');
    expect(text).toContain('40 passed (80%) · 5 failed (10%) · 2 flaky (4.0%) · 3 skipped (6.0%)');
  });

  test('shows the history, linking each run, and says what it means', () => {
    expect(html).toContain(`href="${SITE}/test-runs/100"`);
    expect(html).toContain('First failure after 4 passing runs');
    expect(text).toContain('Last 5 runs: ✓ ✓ ✓ ✓ ✗ (First failure after 4 passing runs)');
  });

  test('names the commit, the CI build and the owners', () => {
    expect(html).toContain('href="https://github.com/acme/shop/commit/abcdef1234567"');
    expect(html).toContain('abcdef1');
    expect(html).toContain('Check the card');
    expect(html).toContain('href="https://ci.example.com/build/9"');
    expect(html).toContain('@team/pay');
  });

  test('gives each failure its full path, location, highlighted code and colored error', () => {
    expect(html).toContain('Checkout › Payment ›');
    expect(html).toContain('tests/pay.spec.ts:40');
    expect(html).toContain(`href="${SITE}/test-run-cases/70"`);
    expect(html).toContain('New failure');
    expect(html).toContain('&#8250;&nbsp;42');
    expect(html).toMatch(/<span style="color:#[0-9a-f]{6};">await<\/span>/);
    expect(html).not.toContain('class="hljs');
    expect(html).toContain('color:#047857;white-space:pre-wrap;word-break:break-word;">Expected: &quot;Paid&quot;');
    expect(html).toContain('color:#be123c;white-space:pre-wrap;word-break:break-word;">Received: &quot;Pending&quot;');
  });

  test('links the failures it leaves out, and the run', () => {
    expect(html).toContain('4 more failing tests in the run');
    expect(html).toContain(`href="${SITE}/test-runs/104"`);
    expect(text).toContain(`4 more failing tests: ${SITE}/test-runs/104`);
  });

  test('carries the same story in its plain-text part', () => {
    expect(text).toContain('✗ Checkout › Payment › pays with a saved card');
    expect(text).toContain('  tests/pay.spec.ts:40 (chromium)');
    expect(text).toContain("await page.getByRole('button', { name: 'Pay' }).click();");
    expect(text).toContain(`Open the run: ${SITE}/test-runs/104`);
  });

  test('is wider than the account emails', () => {
    expect(html).toContain('max-width:680px');
  });
});

describe('the other run emails', () => {
  test('a passing run counts the tests that needed a retry', () => {
    const { html } = renderNotificationEmailAt(
      'run.finished',
      {
        ...failedRun,
        status: 'passed',
        failedTests: 0,
        passedTests: 47,
        topFailures: [],
        history: history(['failed', 'passed']),
      },
      SITE,
    );
    expect(html).toContain('Run passed · checkout');
    expect(html).toContain('2 only on a retry');
    expect(html).toContain('Back to green after 1 failing run');
    expect(html).not.toContain('What failed');
  });

  test('an interrupted run says how much of it reported', () => {
    const { html } = renderNotificationEmailAt(
      'run.interrupted',
      { ...failedRun, status: 'interrupted', didNotRunTests: 20 },
      SITE,
    );
    expect(html).toContain('The run stopped before the end');
    expect(html).toContain('30 of 50 tests reported');
  });

  test('a performance regression compares the run with the usual time', () => {
    const { html } = renderNotificationEmailAt(
      'perf.regression',
      { ...failedRun, durationMs: 9_000, baselineDurationMs: 6_000, regressionPct: 50 },
      SITE,
    );
    expect(html).toMatch(/\+50%<\/span> slower/);
    expect(html).toContain('9.0s, against a usual 6.0s');
  });

  test('an old payload without the new fields still renders', () => {
    const { html } = renderNotificationEmailAt(
      'run.failed',
      {
        runId: 1,
        projectId: 1,
        projectName: 'p',
        status: 'failed',
        totalTests: 2,
        failedTests: 1,
        passedTests: 1,
        flakyTests: 0,
        topFailures: [{ title: 't' }],
      },
      SITE,
    );
    expect(html).toContain('What failed');
    expect(html).not.toContain('Last ');
  });
});

describe('a failure card', () => {
  const hostile = '<img src=x onerror=alert(1)>';

  test('escapes the title, describe blocks, location, owner, headline, error and code', () => {
    const { html } = renderNotificationEmailAt(
      'run.failed',
      {
        ...failedRun,
        topFailures: [
          {
            title: hostile,
            suitePath: [hostile],
            filePath: `${hostile}.ts`,
            owner: hostile,
            browserName: hostile,
            headline: hostile,
            errorExcerpt: hostile,
            source: { file: `${hostile}.ts`, line: 1, snippet: `>  1 | const a = '${hostile}';` },
          },
        ],
      },
      SITE,
    );
    expect(html).not.toContain('<img src=x');
  });
});

describe('the email blocks', () => {
  test('a run splits into its outcomes, empty ones left out', () => {
    expect(runSegments({ passedTests: 10, failedTests: 0, flakyTests: 3, skippedTests: 0 })).toEqual([
      { key: 'passed', label: 'passed', count: 7 },
      { key: 'flaky', label: 'flaky', count: 3 },
    ]);
  });

  test('the outcome bar gives a tiny share a visible width', () => {
    const bar = outcomeBar(runSegments({ passedTests: 999, failedTests: 1, flakyTests: 0 }), 1000);
    const widths = [...bar.matchAll(/<td width="([\d.]+)%"/g)].map((m) => Number(m[1]));
    expect(widths[1]).toBeGreaterThanOrEqual(1.4);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
  });

  test('the history sentence', () => {
    expect(historySentence(history(['passed', 'passed', 'failed']))).toBe('First failure after 2 passing runs');
    expect(historySentence(history(['passed', 'failed', 'failed']))).toBe('Failing for 2 runs in a row');
    expect(historySentence(history(['failed', 'failed']))).toBe('Failed in all of the last 2 runs');
    expect(historySentence(history(['failed', 'failed', 'passed']))).toBe('Back to green after 2 failing runs');
    expect(historySentence(history(['passed', 'passed', 'passed']))).toBe('Green in all of the last 3 runs');
    expect(historySentence(history(['interrupted', 'passed']))).toBeNull();
    expect(historySentence(history(['passed']))).toBeNull();
  });

  test("a test's own history sentence, and whether its failure is new", () => {
    expect(testHistorySentence(['passed', 'flaky', 'failed'])).toEqual({
      text: 'Passed in each of the 2 runs before',
      isNew: true,
    });
    expect(testHistorySentence([null, 'passed', 'failed'])).toEqual({
      text: 'Passed in the previous run',
      isNew: true,
    });
    expect(testHistorySentence(['failed', 'passed', 'failed'])).toEqual({
      text: 'Also failed in 1 of the 2 runs before',
      isNew: false,
    });
    expect(testHistorySentence(['passed', 'failed', 'failed'])).toEqual({
      text: 'Failed in the last 2 runs',
      isNew: false,
    });
    expect(testHistorySentence([null, null, 'failed'])).toEqual({ text: 'No earlier result here', isNew: false });
    expect(testHistorySentence(['failed', 'passed'])).toBeNull();
  });

  test('the code block drops the shared indentation and the caret row, and marks the failing line', () => {
    const html = codeBlock({ file: 'tests/pay.spec.ts', line: 42, snippet });
    expect(html).toContain('tests/pay.spec.ts:42');
    expect(html).not.toContain('^');
    expect(html).toContain('>&#8250;&nbsp;42</td>');
    // The rows shared two spaces of indentation: the test line now starts the code.
    expect(html).toMatch(/>40<\/td><td[^>]*><span style="color:#[0-9a-f]{6};">test<\/span>/);
  });

  test('the code block leaves code in an unknown language plain and escaped', () => {
    const html = codeBlock({ file: 'notes.unknown', line: 1, snippet: '>  1 | <b>bold</b>' });
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });
});

describe('the digest', () => {
  test('marks what needs attention and draws each run', () => {
    const { subject, html } = renderDigestEmailAt(
      [
        { event: 'run.failed', payload: failedRun },
        {
          event: 'cluster.fixed',
          payload: {
            clusterId: 1,
            projectId: 1,
            projectName: 'checkout',
            signature: 's',
            runId: 3,
            verification: 'stopped-failing',
          },
        },
      ],
      SITE,
    );
    expect(subject).toBe('Piwi digest — 2 notifications');
    expect(html).toContain('1 needs attention');
    expect(html).toContain(`href="${SITE}/test-runs/104"`);
    expect(html).toContain(`href="${SITE}/failure-clusters/1"`);
    expect(html).toContain('<strong style="color:#18181b;">40</strong> passed');
  });
});
