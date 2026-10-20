import { describe, it, afterEach, expect } from 'vitest';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import {
  formatExternalIdDuplicates,
  planExternalIds,
  resolveOnDuplicate,
  type PlannedTest,
} from '../src/internal/collect/external-ids.js';
import {
  startServer,
  jsonRes,
  textRes,
  fakeConfig,
  fakeSuite,
  fakeTestCase,
  fakeResult,
  type FakeServer,
} from './_helpers.js';

function planned(testId: string, title: string, extra: Partial<PlannedTest> = {}): PlannedTest {
  return { testId, filePath: 'tests/login.spec.ts', suitePath: [], title, line: 3, annotations: [], ...extra };
}

describe('planExternalIds', () => {
  it('reads the ID from piwi:id, which wins over the pattern', () => {
    const plan = planExternalIds(
      [planned('a', '12526, Log in', { annotations: [{ type: 'piwi:id', description: 'TC-9' }] })],
      {
        pattern: /^(\d+), /,
      },
    );
    expect(plan.byTestId.get('a')).toEqual({ externalId: 'TC-9' });
  });

  it('reads the ID from the title, with the display title only when asked', () => {
    const tests = [planned('a', '12526, Log in with Email')];
    expect(planExternalIds(tests, { pattern: '^(\\d+), ' }).byTestId.get('a')).toEqual({ externalId: '12526' });
    expect(planExternalIds(tests, { pattern: /^(\d+), /, stripFromTitle: true }).byTestId.get('a')).toEqual({
      externalId: '12526',
      displayTitle: 'Log in with Email',
    });
  });

  it('sets aside an ID declared by two different tests, for both of them', () => {
    const plan = planExternalIds(
      [
        planned('a', '5, Log in'),
        planned('b', '5, Log out', { filePath: 'tests/logout.spec.ts', suitePath: ['Session'], line: 8 }),
        planned('c', '6, Sign up'),
      ],
      { pattern: /^(\d+), / },
    );
    expect([...plan.byTestId.keys()]).toEqual(['c']);
    expect(plan.duplicates).toEqual([
      {
        externalId: '5',
        tests: [
          { filePath: 'tests/login.spec.ts', title: '5, Log in', line: 3 },
          { filePath: 'tests/logout.spec.ts', suitePath: ['Session'], title: '5, Log out', line: 8 },
        ],
      },
    ]);
  });

  it('does not count the same test in two Playwright projects as a duplicate', () => {
    const plan = planExternalIds([planned('chromium-a', '5, Log in'), planned('firefox-a', '5, Log in')], {
      pattern: /^(\d+), /,
    });
    expect(plan.duplicates).toEqual([]);
    expect(plan.byTestId.size).toBe(2);
  });

  it('reports a pattern that does not compile and reads only annotations', () => {
    const plan = planExternalIds(
      [planned('a', '5, Log in'), planned('b', 'Other', { annotations: [{ type: 'piwi:id', description: '7' }] })],
      { pattern: '(' },
    );
    expect(plan.patternError).toBeTruthy();
    expect([...plan.byTestId]).toEqual([['b', { externalId: '7' }]]);
  });

  it('names every location of a duplicate in the console', () => {
    const lines = formatExternalIdDuplicates(
      [
        {
          externalId: '5',
          tests: [
            { filePath: 'a.spec.ts', title: 'A', line: 2 },
            { filePath: 'b.spec.ts', suitePath: ['S'], title: 'B' },
          ],
        },
      ],
      'report',
    );
    expect(lines).toEqual([
      'External ID 5 is declared by 2 tests; this run matches them by file, describe path and title:',
      '  a.spec.ts:2  A',
      '  b.spec.ts  S › B',
      "Give each test its own ID, or set externalId.onDuplicate: 'fail' to fail the run instead.",
    ]);
  });
});

describe('resolveOnDuplicate', () => {
  it('reads report and fail in any case, and anything else as report with a warning', () => {
    expect(resolveOnDuplicate(undefined)).toEqual({ onDuplicate: 'report' });
    expect(resolveOnDuplicate(' FAIL ')).toEqual({ onDuplicate: 'fail' });
    expect(resolveOnDuplicate('Report')).toEqual({ onDuplicate: 'report' });
    expect(resolveOnDuplicate('error')).toEqual({ onDuplicate: 'report', invalid: 'error' });
  });
});

describe('external IDs on the wire', () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  async function run(
    titles: string[],
    externalId: Record<string, unknown>,
  ): Promise<{ body: any; outcome: { status?: string } | void }> {
    let body: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        body = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 1, projectId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-external-ids-' + process.pid,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      externalId,
    });
    const suite = fakeSuite();
    const tests = titles.map((title, i) => ({ ...fakeTestCase({ title, parent: suite, line: i + 1 }), id: `t${i}` }));
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig(), suite);
    for (const test of tests) {
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(test, fakeResult({ status: 'passed', duration: 5, workerIndex: 0 }));
    }
    const outcome = await reporter.onEnd({ status: 'passed' } as any);
    return { body, outcome };
  }

  it('sends the ID and the display title, with the whole title kept', async () => {
    const { body } = await run(['12526, Log in', 'No id'], { pattern: /^(\d+), /, stripFromTitle: true });
    expect(body.testCases.map((c: any) => [c.title, c.externalId, c.displayTitle])).toEqual([
      ['12526, Log in', '12526', 'Log in'],
      ['No id', null, null],
    ]);
  });

  it('sends no ID for duplicates, records them on the run, and fails it only when asked', async () => {
    const reported = await run(['5, A', '5, B'], { pattern: /^(\d+), / });
    expect(reported.body.testCases.map((c: any) => c.externalId)).toEqual([null, null]);
    expect(reported.body.metadata.externalIdDuplicates).toHaveLength(1);
    expect(reported.outcome).toBeUndefined();
    expect(reported.body.status).toBe('passed');

    await server!.close();
    server = undefined;
    const failed = await run(['5, A', '5, B'], { pattern: /^(\d+), /, onDuplicate: 'FAIL' });
    expect(failed.outcome).toEqual({ status: 'failed' });
    // The dashboard records the status the run exits with.
    expect(failed.body.status).toBe('failed');
  });
});
