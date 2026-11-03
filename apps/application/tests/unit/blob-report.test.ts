import { describe, test, expect } from 'vitest';
import { parseBlobReport, BlobReportError, readBlobScm } from '../../server/utils/blob-report';
import { openArchive, ArchiveError } from '../../server/utils/archive-reader';
import { buildZip } from '../../server/utils/trace-zip';
import { buildBlobReport } from '../utils/blob-report-fixture';
import { MAX_RUN_ERRORS } from '@piwitests/core/run-errors';
import { MAX_TEST_OUTPUT_CHARS } from '@piwitests/core/test-output';

/** The parser reads entries through an injected reader; on the server that is the ZIP. */
const parse = (archive: Buffer) => parseBlobReport(openArchive(archive).readEntry);

describe('parseBlobReport', () => {
  test('maps a run and its executions onto the ingest shape', async () => {
    const parsed = await parse(
      buildBlobReport({
        runStatus: 'failed',
        startTime: 1_700_000_000_000,
        duration: 4321,
        tests: [
          {
            testId: 't-pass',
            title: 'passes',
            suitePath: ['outer', 'inner'],
            line: 7,
            column: 9,
            attempts: [{ status: 'passed', duration: 120 }],
          },
          {
            testId: 't-fail',
            title: 'fails',
            line: 12,
            attempts: [
              { status: 'failed', duration: 300, errorMessage: 'Error: boom' },
              { status: 'passed', duration: 200 },
            ],
          },
        ],
      }),
    );

    expect(parsed.blobVersion).toBe(2);
    expect(parsed.playwrightVersion).toBe('1.61.1');
    expect(parsed.status).toBe('failed');
    expect(parsed.startTime.getTime()).toBe(1_700_000_000_000);
    expect(parsed.duration).toBe(4321);
    expect(parsed.projectNames).toEqual(['chromium']);

    // Two tests, as Playwright counts them: one pass, and one whose retry turned green, so it counts as passed and
    // flaky, never as failed. The three executions stay three cases.
    expect(parsed.cases).toHaveLength(3);
    expect(parsed.totalTests).toBe(2);
    expect(parsed.passedTests).toBe(2);
    expect(parsed.failedTests).toBe(0);
    expect(parsed.flakyTests).toBe(1);

    const passed = parsed.cases[0]!.case;
    expect(passed.title).toBe('passes');
    expect(passed.status).toBe('passed');
    expect(passed.duration).toBe(120);
    expect(passed.line).toBe(7);
    expect(passed.column).toBe(9);
    expect(passed.timeout).toBe(30000);
    expect(passed.retries).toBe(0);
    expect(passed.browser).toEqual({ projectName: 'chromium' });

    // Only describe titles form the suite path — the file suite is not one.
    expect(passed.suitePath).toEqual(['outer', 'inner']);
    expect(parsed.cases[1]!.case.suitePath).toEqual([]);

    const failed = parsed.cases[1]!.case;
    expect(failed.error).toContain('Error: boom');
    expect(parsed.cases[2]!.case.retries).toBe(1);
  });

  test('records spec paths relative to the config directory, as the reporter does', async () => {
    const parsed = await parse(
      buildBlobReport({
        rootDir: '/repo/tests',
        configFile: '../playwright.config.ts',
        file: 'login/auth.spec.ts',
        tests: [{ testId: 't', title: 'a', attempts: [{ status: 'passed' }] }],
      }),
    );

    // rootDir sits one level below the config, so the spec keeps that prefix —
    // matching `path.relative(cwd, file)` on a live run.
    expect(parsed.cases[0]!.case.filePath).toBe('tests/login/auth.spec.ts');
  });

  test('places the error of a timed-out test at the line of the call it interrupted', async () => {
    const parsed = await parse(
      buildBlobReport({
        tests: [
          {
            testId: 't',
            title: 'signs in',
            attempts: [
              {
                status: 'timedOut',
                errors: [
                  { message: 'Test timeout of 30000ms exceeded.' },
                  { message: 'Error: locator.click: Test timeout of 30000ms exceeded.', line: 7, column: 54 },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(parsed.cases[0]!.case.error).toMatch(/\n {4}at tests\/demo\.spec\.ts:7:54$/);
  });

  test('keeps the spec path as-is when the config sits at the test root', async () => {
    const parsed = await parse(
      buildBlobReport({
        rootDir: '/repo',
        configFile: 'playwright.config.ts',
        file: 'e2e/checkout.spec.ts',
        tests: [{ testId: 't', title: 'a', attempts: [{ status: 'passed' }] }],
      }),
    );

    expect(parsed.cases[0]!.case.filePath).toBe('e2e/checkout.spec.ts');
  });

  test('separates a deliberate skip from a test that never ran', async () => {
    const parsed = await parse(
      buildBlobReport({
        tests: [
          {
            testId: 't-skip',
            title: 'skipped on purpose',
            attempts: [{ status: 'skipped', annotations: [{ type: 'skip', description: 'not today' }] }],
          },
          {
            testId: 't-serial',
            title: 'skipped by a failing sibling',
            attempts: [{ status: 'skipped' }],
          },
          { testId: 't-unrun', title: 'never reported', attempts: [] },
        ],
      }),
    );

    const byTitle = new Map(parsed.cases.map((entry) => [entry.case.title, entry.case]));
    expect(byTitle.get('skipped on purpose')!.status).toBe('skipped');
    expect(byTitle.get('skipped on purpose')!.testAnnotations).toEqual([{ type: 'skip', description: 'not today' }]);
    // No skip annotation means it was cut short, not chosen.
    expect(byTitle.get('skipped by a failing sibling')!.status).toBe('didnotrun');
    // Planned but never reported — materialized so the run's totals reconcile.
    expect(byTitle.get('never reported')!.status).toBe('didnotrun');
    expect(byTitle.get('never reported')!.duration).toBe(0);

    expect(parsed.skippedTests).toBe(1);
    expect(parsed.didNotRunTests).toBe(2);
    expect(parsed.totalTests).toBe(3);
  });

  test('follows Playwright on a test.fail() outcome', async () => {
    const parsed = await parse(
      buildBlobReport({
        runStatus: 'passed',
        tests: [
          {
            testId: 't-xfail',
            title: 'known bug',
            attempts: [{ status: 'failed', errorMessage: 'Error: expect(1).toBe(2)', annotations: [{ type: 'fail' }] }],
          },
          {
            testId: 't-xpass',
            title: 'fixed but still marked',
            attempts: [{ status: 'passed', annotations: [{ type: 'fail' }] }],
          },
        ],
      }),
    );

    const byTitle = new Map(parsed.cases.map((entry) => [entry.case.title, entry.case]));

    // An expected failure counts as passed but keeps its error and fail mark.
    const xfail = byTitle.get('known bug')!;
    expect(xfail.status).toBe('passed');
    expect(xfail.error).toContain('expect(1).toBe(2)');
    expect(xfail.testAnnotations).toEqual([{ type: 'fail' }]);

    // An unexpected pass counts as failed, carrying Playwright's explanation.
    const xpass = byTitle.get('fixed but still marked')!;
    expect(xpass.status).toBe('failed');
    expect(xpass.error).toBe('Expected to fail, but passed.');
    expect(xpass.expectedStatus).toBe('failed');
    expect(xfail.expectedStatus).toBe('failed');

    expect(parsed.passedTests).toBe(1);
    expect(parsed.failedTests).toBe(1);
  });

  test('inverts only a test Playwright expected to fail, not one that pushed a fail annotation itself', async () => {
    const parsed = await parse(
      buildBlobReport({
        tests: [
          {
            testId: 't-annotated',
            title: 'notes a known bug',
            attempts: [{ status: 'passed', annotations: [{ type: 'fail' }], expectedStatus: 'passed' }],
          },
        ],
      }),
    );

    const annotated = parsed.cases[0]!.case;
    expect(annotated.status).toBe('passed');
    expect(annotated.error).toBeNull();
    expect(parsed.failedTests).toBe(0);
  });

  test('carries step metrics and splits attachments from traces', async () => {
    const parsed = await parse(
      buildBlobReport({
        tests: [
          {
            testId: 't',
            title: 'has evidence',
            attempts: [
              {
                status: 'failed',
                duration: 900,
                errorMessage: 'Error: nope',
                attachments: [
                  { name: 'trace', contentType: 'application/zip', body: 'trace-bytes' },
                  { name: 'screenshot', contentType: 'image/png', body: 'png-bytes' },
                  { name: 'error-context', contentType: 'text/markdown', body: '# Test info' },
                ],
              },
            ],
          },
        ],
      }),
    );

    const entry = parsed.cases[0]!;
    expect(entry.traces).toHaveLength(1);
    expect(entry.attachments.map((a) => a.name)).toEqual(['screenshot', 'error-context']);
    expect(entry.case.slowestStep).toContain('Expect "toBeVisible"');
    expect(entry.case.slowestStepDuration).toBe(900);
    expect(Array.isArray(entry.case.steps)).toBe(true);

    // Attachment bytes stay in the archive until the caller asks for them.
    expect(entry.traces[0]!.entry).toMatch(/^resources\//);
  });

  test('keeps each `--repeat-each` repetition as an execution of its own', async () => {
    const parsed = await parse(
      buildBlobReport({
        runStatus: 'failed',
        tests: [0, 1, 2].map((repeatEachIndex) => ({
          testId: `pays-${repeatEachIndex}`,
          title: 'pays',
          line: 9,
          repeatEachIndex,
          attempts: [repeatEachIndex === 1 ? { status: 'failed', errorMessage: 'Error: boom' } : { status: 'passed' }],
        })),
      }),
    );
    expect(parsed.cases.map((c) => [c.case.title, c.case.repeatEachIndex, c.case.retries, c.case.status])).toEqual([
      ['pays', 0, 0, 'passed'],
      ['pays', 1, 0, 'failed'],
      ['pays', 2, 0, 'passed'],
    ]);
  });

  test('tags every execution with the shard the archive covers', async () => {
    const parsed = await parse(
      buildBlobReport({
        shard: { current: 2, total: 4 },
        tests: [{ testId: 't', title: 'a', attempts: [{ status: 'passed' }] }],
      }),
    );

    expect(parsed.shard).toEqual({ current: 2, total: 4 });
    expect(parsed.cases[0]!.case.shardIndex).toBe(2);
  });

  test('rejects an archive that is not a blob report', async () => {
    const notABlobReport = buildZip([{ name: 'index.html', data: Buffer.from('<html></html>') }]);
    await expect(parse(notABlobReport)).rejects.toThrow(BlobReportError);
    await expect(parse(notABlobReport)).rejects.toThrow(/report\.jsonl/);
  });

  test('rejects a blob version it cannot read rather than importing garbage', async () => {
    const future = buildBlobReport({
      blobVersion: 99,
      tests: [{ testId: 't', title: 'a', attempts: [{ status: 'passed' }] }],
    });
    await expect(parse(future)).rejects.toThrow(/Unsupported blob report version 99/);
  });

  test('rejects bytes that are not a ZIP at all', () => {
    // Recognising the container is the reader's job, not the parser's.
    expect(() => openArchive(Buffer.from('not a zip'))).toThrow(ArchiveError);
  });

  test('skips malformed event lines instead of failing the import', async () => {
    const valid = buildBlobReport({ tests: [{ testId: 't', title: 'a', attempts: [{ status: 'passed' }] }] });
    const parsed = await parse(valid);
    expect(parsed.cases).toHaveLength(1);

    // A run killed mid-write leaves a truncated final line.
    const truncated = await parse(
      buildZip([
        {
          name: 'report.jsonl',
          data: Buffer.from(
            [
              JSON.stringify({ method: 'onBlobReportMetadata', params: { version: 2, pathSeparator: '/' } }),
              JSON.stringify({ method: 'onConfigure', params: { config: { rootDir: '/repo' } } }),
              '{"method":"onTestEn',
            ].join('\n'),
          ),
        },
      ]),
    );
    expect(truncated.cases).toEqual([]);
  });
});

describe('readBlobScm', () => {
  test("prefers the CI provider's branch over a detached checkout's", () => {
    expect(
      readBlobScm({
        ci: { commitHash: 'abc123', branch: 'feature/pay', commitHref: 'https://example.test/c/abc123' },
        gitCommit: { hash: 'abc123', branch: 'HEAD', subject: 'Pay' },
      }),
    ).toEqual({ commit: 'abc123', branch: 'feature/pay' });
  });

  test("reads the checkout's commit and branch when no CI provider is recorded", () => {
    expect(readBlobScm({ gitCommit: { hash: 'def456', branch: 'main' } })).toEqual({
      commit: 'def456',
      branch: 'main',
    });
  });

  test('reads the flat revision id older Playwright versions recorded', () => {
    expect(readBlobScm({ 'revision.id': '789abc' })).toEqual({ commit: '789abc', branch: null });
  });

  test('is null when the config metadata records no revision', () => {
    expect(readBlobScm({})).toBeNull();
    expect(readBlobScm(undefined)).toBeNull();
  });
});

describe('parseBlobReport counters', () => {
  test('count each test once, by its last attempt, and each --repeat-each repetition apart', async () => {
    const parsed = await parse(
      buildBlobReport({
        runStatus: 'failed',
        tests: [
          {
            testId: 't-broken',
            title: 'always fails',
            attempts: [
              { status: 'failed', errorMessage: 'Error: boom' },
              { status: 'failed', errorMessage: 'Error: boom' },
              { status: 'timedOut', errorMessage: 'Test timeout of 30000ms exceeded.' },
            ],
          },
          { testId: 't-rep-0', title: 'repeated', repeatEachIndex: 0, attempts: [{ status: 'passed' }] },
          { testId: 't-rep-1', title: 'repeated', repeatEachIndex: 1, attempts: [{ status: 'passed' }] },
        ],
      }),
    );

    expect(parsed.cases).toHaveLength(5);
    expect(parsed.totalTests).toBe(3);
    expect(parsed.passedTests).toBe(2);
    expect(parsed.failedTests).toBe(1);
    expect(parsed.flakyTests).toBe(0);
  });

  test('count a test the run stopped in no bucket, as the stored rows and the run page do', async () => {
    const parsed = await parse(
      buildBlobReport({
        runStatus: 'interrupted',
        tests: [
          { testId: 't-pass', title: 'passes', attempts: [{ status: 'passed' }] },
          {
            testId: 't-stop',
            title: 'stopped',
            attempts: [{ status: 'interrupted', errorMessage: 'Error: Test ended.' }],
          },
        ],
      }),
    );

    expect(parsed).toMatchObject({
      totalTests: 2,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      didNotRunTests: 0,
      flakyTests: 0,
    });
  });
});

describe('parseBlobReport on an archive older than Playwright 1.53', () => {
  test("reads each result's attachments from its end event", async () => {
    const parsed = await parse(
      buildBlobReport({
        playwrightVersion: '1.52.0',
        attachmentsOnTestEnd: true,
        runStatus: 'failed',
        tests: [
          {
            testId: 't-fail',
            title: 'fails',
            attempts: [
              {
                status: 'failed',
                errorMessage: 'Error: boom',
                attachments: [
                  { name: 'trace', contentType: 'application/zip', body: 'trace bytes' },
                  { name: 'screenshot', contentType: 'image/png', body: 'png bytes' },
                  { name: '_error-context-0', contentType: 'text/markdown', body: '# Page snapshot' },
                ],
              },
            ],
          },
        ],
      }),
    );

    const [failed] = parsed.cases;
    expect(failed!.traces.map((t) => t.name)).toEqual(['trace']);
    expect(failed!.attachments.map((a) => a.name)).toEqual(['screenshot', '_error-context-0']);
  });
});

describe("a blob report's test output and its errors outside any test", () => {
  test("keeps each attempt's output as the reporter does: in order, decoded as one stream, its secrets hidden", async () => {
    // "café", its "é" split across two base64 chunks.
    const cafe = Buffer.from('café ready\n', 'utf-8');
    const parsed = await parse(
      buildBlobReport({
        outputOutsideTests: ['webServer listening on :3000\n'],
        tests: [
          {
            testId: 't',
            title: 'pays',
            attempts: [
              {
                status: 'failed',
                stdout: [
                  'GET https://api.example.test/me?access_token=t0k3n-v4lue 200\n',
                  { base64: cafe.subarray(0, 4).toString('base64') },
                  { base64: cafe.subarray(4).toString('base64') },
                ],
                stderr: ['payment sandbox answered 502\n'],
              },
              { status: 'passed', stdout: [' \n'] },
            ],
          },
        ],
      }),
    );

    const [first, retry] = parsed.cases.map((entry) => entry.case);
    expect(first!.stdout).toBe('GET https://api.example.test/me?access_token=<hidden> 200\ncafé ready\n');
    expect(first!.stderr).toBe('payment sandbox answered 502\n');
    expect(retry!.stdout).toBeNull();
    expect(retry!.stderr).toBeNull();
  });

  test('bounds a long output as the reporter does, keeping its head and its tail', async () => {
    const long = Array.from({ length: 10_000 }, (_, i) => `step ${i} of the checkout\n`);
    const parsed = await parse(
      buildBlobReport({ tests: [{ testId: 't', title: 'pays', attempts: [{ status: 'passed', stdout: long }] }] }),
    );

    const stdout = parsed.cases[0]!.case.stdout as string;
    expect(stdout.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT_CHARS);
    expect(stdout.startsWith('step 0 of the checkout\n')).toBe(true);
    expect(stdout).toMatch(/\[… \d+ lines \(\d+ characters\) of output cut …\]/);
    expect(stdout.endsWith('step 9999 of the checkout\n')).toBe(true);
  });

  test('keeps the errors outside any test as the reporter does: hidden, placed from the config folder, the first ones', async () => {
    const signIn = 'Error: global setup could not sign in at https://auth.example.test/login?token=s3cr3t-v4lue';
    const parsed = await parse(
      buildBlobReport({
        rootDir: '/repo/tests',
        configFile: '../playwright.config.ts',
        runErrors: [
          {
            message: signIn,
            stack: `${signIn}\n    at globalSetup (/repo/global-setup.ts:4:9)`,
            location: { file: '/repo/global-setup.ts', line: 4, column: 9 },
            snippet: '> 4 |   throw new Error(…)',
            cause: { message: 'Error: connect ECONNREFUSED 127.0.0.1:3000' },
          },
          ...Array.from({ length: MAX_RUN_ERRORS + 5 }, (_, i) => ({ message: `Error: spec ${i} did not load` })),
        ],
        tests: [{ testId: 't', title: 'a', attempts: [{ status: 'passed' }] }],
      }),
    );

    expect(parsed.runErrors).toHaveLength(MAX_RUN_ERRORS);
    expect(parsed.runErrors[0]).toEqual({
      message:
        'Error: global setup could not sign in at https://auth.example.test/login?token=<hidden>\n[cause]: Error: connect ECONNREFUSED 127.0.0.1:3000',
      stack: '    at globalSetup (/repo/global-setup.ts:4:9)',
      location: { file: 'global-setup.ts', line: 4, column: 9 },
    });
    expect(parsed.runErrors[1]).toEqual({ message: 'Error: spec 0 did not load', stack: null, location: null });
  });

  test('a report with neither keeps no run error, and its executions no output', async () => {
    const parsed = await parse(
      buildBlobReport({ tests: [{ testId: 't', title: 'a', attempts: [{ status: 'passed' }] }] }),
    );

    expect(parsed.runErrors).toEqual([]);
    expect(parsed.cases[0]!.case).toMatchObject({ stdout: null, stderr: null });
  });
});
