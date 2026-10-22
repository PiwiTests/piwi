import { describe, test, expect } from 'vitest';
import { parseBlobReport, BlobReportError, readBlobScm } from '../../server/utils/blob-report';
import { openArchive, ArchiveError } from '../../server/utils/archive-reader';
import { buildZip } from '../../server/utils/trace-zip';
import { buildBlobReport } from '../utils/blob-report-fixture';

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

    // Three executions: one pass plus the failure and its retry.
    expect(parsed.totalTests).toBe(3);
    expect(parsed.passedTests).toBe(2);
    expect(parsed.failedTests).toBe(1);
    // The retry turned green, so the test counts as flaky.
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
