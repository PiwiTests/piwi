import { describe, expect, test } from 'vitest';
import { renderNotificationEmailAt, renderDigestEmailAt } from '#shared/notifications/render-email';
import { codeBlock, outcomeBar } from '#shared/notifications/email-blocks';
import {
  historySentence,
  percent,
  runSegments,
  sourceIsTestFile,
  testHistorySentence,
} from '#shared/notifications/message-parts';
import { durationShort } from '#shared/relative-time';
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
    expect(html).toContain('First failure in the last 5 runs');
    expect(text).toContain('Last 5 runs: ✓ ✓ ✓ ✓ ✗ (First failure in the last 5 runs)');
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
    expect(text).toContain('  tests/pay.spec.ts:40 · New failure · chromium');
    expect(text).toContain('\n5 tests failed\nout of 50 · Run #104 · main · staging · 8m 32s\n');
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
    expect(html).toContain('First pass in the last 2 runs');
    expect(html).not.toContain('What failed');
  });

  test('an interrupted run says how much of it reported, and draws the rest as not reported', () => {
    const { html, text } = renderNotificationEmailAt(
      'run.interrupted',
      {
        ...failedRun,
        status: 'interrupted',
        totalTests: 120,
        passedTests: 30,
        failedTests: 10,
        flakyTests: 0,
        skippedTests: 0,
        didNotRunTests: 0,
      },
      SITE,
    );
    expect(html).toContain('The run stopped before the end');
    expect(html).toContain('40 of 120 tests reported');
    expect(text).toContain('30 passed (25%) · 10 failed (8.3%) · 80 not reported (67%)');
  });

  test('a green run with skipped tests counts what passed, not every test', () => {
    const { html } = renderNotificationEmailAt(
      'run.finished',
      {
        ...failedRun,
        status: 'passed',
        totalTests: 50,
        passedTests: 45,
        failedTests: 0,
        flakyTests: 0,
        skippedTests: 5,
        topFailures: [],
      },
      SITE,
    );
    expect(html).toMatch(/>45<\/span> tests passed/);
    expect(html).toContain('out of 50');
    expect(html).not.toContain('All ');
  });

  test('a digest lists its first notifications and counts the rest', () => {
    const items = Array.from({ length: 25 }, () => ({ event: 'run.failed' as const, payload: failedRun }));
    const { html, text } = renderDigestEmailAt(items, SITE);
    expect(html.match(/border-left:4px solid/g)).toHaveLength(20);
    expect(html).toContain('…and 5 more notifications');
    expect(text.match(/Test run failed/g)).toHaveLength(25);
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

  test('a payload without history, commit or sources renders', () => {
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

  test('the history sentence, which never takes the window for the whole streak', () => {
    expect(historySentence(history(['passed', 'passed', 'failed']))).toBe('First failure in the last 3 runs');
    expect(historySentence(history(['failed', 'passed', 'passed', 'failed']))).toBe(
      'First failure after 2 passing runs',
    );
    expect(historySentence(history(['passed', 'failed', 'failed']))).toBe('Failing for 2 runs in a row');
    expect(historySentence(history(['failed', 'failed']))).toBe('Failed in all of the last 2 runs');
    expect(historySentence(history(['failed', 'failed', 'passed']))).toBe('First pass in the last 3 runs');
    expect(historySentence(history(['passed', 'failed', 'failed', 'passed']))).toBe(
      'Back to green after 2 failing runs',
    );
    expect(historySentence(history(['passed', 'passed', 'passed']))).toBe('Green in all of the last 3 runs');
    expect(historySentence(history(['interrupted', 'passed']))).toBeNull();
    expect(historySentence(history(['passed']))).toBeNull();
  });

  test("a test's own history sentence counts only the runs that ran it", () => {
    const sentence = (outcomes: Parameters<typeof testHistorySentence>[0]) => testHistorySentence(outcomes);
    expect(sentence(['passed', 'flaky', 'failed'])).toEqual({ text: 'Passed the 2 times it ran before', isNew: true });
    expect(sentence([null, 'passed', 'failed'])).toEqual({ text: 'Passed the previous time it ran', isNew: true });
    expect(sentence(['failed', 'passed', 'failed'])).toEqual({
      text: 'Also failed 1 of the 2 times it ran before',
      isNew: false,
    });
    expect(sentence(['passed', 'failed', 'failed'])).toEqual({ text: 'Failed the last 2 times it ran', isNew: false });
    expect(sentence(['failed', 'skipped', 'failed'])).toEqual({ text: 'Failed the last 2 times it ran', isNew: false });
    expect(sentence(['skipped', 'didnotrun', 'failed'])).toEqual({ text: 'No earlier result here', isNew: false });
    expect(sentence([null, null, 'failed'])).toEqual({ text: 'No earlier result here', isNew: false });
    expect(sentence(['failed', 'passed'])).toBeNull();
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

describe('the words every channel shares', () => {
  test('a duration rounds as a clock does', () => {
    expect(durationShort(539_600)).toBe('9m 0s');
    expect(durationShort(59_960)).toBe('1m 0s');
    expect(durationShort(12_440)).toBe('12.4s');
    expect(durationShort(850)).toBe('850ms');
  });

  test('a share that is neither all nor nothing never reads as 100% or 0%', () => {
    expect(percent(999, 1000)).toBe('99.9%');
    expect(percent(1, 2000)).toBe('<0.1%');
    expect(percent(996, 10_000)).toBe('10%');
    expect(percent(33, 1000)).toBe('3.3%');
    expect(percent(5, 5)).toBe('100%');
  });

  test("a stack frame's path from the working directory still names the test's own file", () => {
    const source = { file: 'e2e/tests/a.spec.ts', line: 3, snippet: '>  3 | x()' };
    expect(sourceIsTestFile({ source, filePath: 'tests/a.spec.ts' })).toBe(true);
    expect(sourceIsTestFile({ source, filePath: 'tests/b.spec.ts' })).toBe(false);
  });
});
