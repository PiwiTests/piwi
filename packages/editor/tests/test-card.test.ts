import { describe, expect, test } from 'vitest';
import type { TestExecution } from '../src/piwi-client';
import { TEST_HISTORY_ROWS } from '../src/piwi-client';
import { agoWords, cardStatus, durationWords, median, runResults, testCard } from '../src/test-card';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');

function execution(runId: number, status: string, extra: Partial<TestExecution> = {}): TestExecution {
  return { runId, status, duration: 1200, error: null, startTime: '2026-11-15T10:00:00.000Z', ...extra };
}

const input = {
  testCaseId: 11,
  title: 'cart › adds a mug',
  url: 'https://piwi.test/test-cases/11',
  owner: 'alice',
  tags: ['smoke'],
  quarantine: null,
  runUrl: (id: number) => `https://piwi.test/test-runs/${id}`,
  now: NOW,
};

describe("a test's card", () => {
  test('reads each execution as the strip shows it: a retry that passed is flaky, a timeout a failure', () => {
    expect(cardStatus(execution(1, 'passed'))).toBe('passed');
    expect(cardStatus(execution(1, 'passed', { passedAfterFailure: true }))).toBe('flaky');
    expect(cardStatus(execution(1, 'timedout'))).toBe('failed');
    expect(cardStatus(execution(1, 'timedOut'))).toBe('failed');
    expect(cardStatus(execution(1, 'interrupted'))).toBeNull();
    expect(cardStatus(execution(1, 'skipped'))).toBe('skipped');
    expect(cardStatus(execution(1, 'didnotrun'))).toBeNull();
  });

  test('lists the latest results newest first, and draws the strip oldest first, each mark to its run', () => {
    const card = testCard({
      ...input,
      executions: [
        execution(3, 'failed', {
          error: 'Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole(…)',
          startTime: '2026-11-13T12:00:00.000Z',
        }),
        execution(2, 'passed', { passedAfterFailure: true, duration: 800 }),
        execution(1, 'passed', { duration: 2000 }),
      ],
    });
    expect(card.results.map((r) => [r.runId, r.status])).toEqual([
      [3, 'failed'],
      [2, 'flaky'],
      [1, 'passed'],
    ]);
    expect(card.markdown).toBe(
      [
        '**Piwi** · cart › adds a mug',
        '[✓](https://piwi.test/test-runs/1 "run #1 · passed · 2.0 s") [◐](https://piwi.test/test-runs/2 "run #2 · flaky · 800 ms") [✗](https://piwi.test/test-runs/3 "run #3 · failed · 1.2 s")',
        'Passed 1 of the last 3 runs · 1 flaky · median 1.2 s',
        'Last failed in run #3, 2 d ago: `Error: expect(locator).toBeVisible() failed`',
        'owner alice · @smoke',
      ].join('\n\n'),
    );
    expect(card.html).toContain('<a href="https://piwi.test/test-runs/3" title="run #3 · failed · 1.2 s">✗</a>');
    expect(card.html).toContain(
      'Last failed in run #3, 2 d ago: <code>Error: expect(locator).toBeVisible() failed</code>',
    );
  });

  test('reads one result per run from its final attempts, whatever its retries, repetitions and projects', () => {
    const runs = runResults([
      execution(4, 'failed', { retries: 0, browserName: 'chromium' }),
      execution(4, 'passed', { retries: 1, browserName: 'chromium' }),
      execution(4, 'passed', { browserName: 'firefox' }),
      execution(3, 'passed', { repeatEachIndex: 0 }),
      execution(3, 'failed', { repeatEachIndex: 1, error: '\u001b[31mError: boom\u001b[39m' }),
      execution(2, 'skipped', { browserName: 'chromium' }),
      execution(2, 'skipped', { browserName: 'firefox' }),
      execution(1, 'interrupted'),
    ]);
    expect(runs.map((r) => [r.shown.runId, r.status])).toEqual([
      [4, 'passed'],
      [3, 'failed'],
      [2, 'skipped'],
    ]);
    const card = testCard({
      ...input,
      executions: [execution(3, 'failed', { error: '\u001b[31mError: boom\u001b[39m' })],
    });
    expect(card.markdown).toContain('`Error: boom`');
  });

  test('leaves out the oldest run of a full history, which may be cut short', () => {
    const executions = Array.from({ length: TEST_HISTORY_ROWS }, (_, i) =>
      execution(100 - Math.floor(i / 2), i === TEST_HISTORY_ROWS - 1 ? 'failed' : 'passed', { retries: i % 2 }),
    );
    const runs = runResults(executions).map((r) => r.shown.runId);
    expect(runs).toHaveLength(TEST_HISTORY_ROWS / 2 - 1);
    expect(runs).not.toContain(100 - (TEST_HISTORY_ROWS / 2 - 1));
    expect(runResults(executions.slice(0, 10)).map((r) => r.shown.runId)).toEqual([100, 99, 98, 97, 96]);
  });

  test('says a test skipped in every run is skipped', () => {
    const card = testCard({ ...input, executions: [execution(2, 'skipped'), execution(1, 'skipped')] });
    expect(card.markdown).toContain('Skipped in the last 2 runs');
  });

  test('takes the median of the runs that passed or failed', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    const card = testCard({
      ...input,
      executions: [execution(2, 'skipped', { duration: 0 }), execution(1, 'passed', { duration: 900 })],
    });
    expect(card.markdown).toContain('Passed 1 of the last 1 run · median 900 ms');
  });

  test('says when it has no result yet, and escapes what the test names', () => {
    const card = testCard({ ...input, title: 'a <b> test', owner: null, tags: [], executions: [] });
    expect(card.markdown).toBe('**Piwi** · a \\<b\\> test\n\nNo result yet');
    expect(card.html).toBe('<b>Piwi</b> · a &lt;b&gt; test<br>No result yet');
  });

  test('keeps the latest twenty results', () => {
    const executions = Array.from({ length: 30 }, (_, i) => execution(30 - i, 'passed'));
    expect(testCard({ ...input, executions }).results).toHaveLength(20);
  });

  test('says durations and times as the dashboard does', () => {
    expect(durationWords(850)).toBe('850 ms');
    expect(durationWords(999.6)).toBe('1.0 s');
    expect(durationWords(1400)).toBe('1.4 s');
    expect(durationWords(59_960)).toBe('1 min');
    expect(durationWords(125_000)).toBe('2 min');
    expect(agoWords('2026-11-15T11:59:45.000Z', NOW)).toBe('just now');
    expect(agoWords('2026-11-15T11:30:00.000Z', NOW)).toBe('30 min ago');
    expect(agoWords('2026-11-15T07:00:00.000Z', NOW)).toBe('5 h ago');
    expect(agoWords(null, NOW)).toBeNull();
  });
});
