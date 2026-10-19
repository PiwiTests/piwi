import { describe, test, expect } from 'vitest';
import {
  parseTraceArchive,
  parseTraceTitle,
  resolveSpecPath,
  looksLikeTrace,
  TraceImportError,
} from '../../server/utils/trace-import';
import { openArchive, ArchiveError } from '../../server/utils/archive-reader';
import { buildZip } from '../../server/utils/trace-zip';
import { buildTraceArchive, buildBlobReport } from '../utils/blob-report-fixture';

/** The parser reads entries through an injected reader; on the server that is the ZIP. */
const parse = (archive: Buffer) => {
  const { entryNames, readEntry } = openArchive(archive);
  return parseTraceArchive(entryNames, readEntry);
};

describe('parseTraceTitle', () => {
  test('splits file, line, describe blocks and test title', () => {
    expect(parseTraceTitle('checkout.spec.ts:14 › checkout › payment › shows an error')).toEqual({
      filePath: 'checkout.spec.ts',
      line: 14,
      suitePath: ['checkout', 'payment'],
      title: 'shows an error',
    });
  });

  test('handles a test with no describe blocks', () => {
    expect(parseTraceTitle('smoke.spec.ts:3 › loads')).toEqual({
      filePath: 'smoke.spec.ts',
      line: 3,
      suitePath: [],
      title: 'loads',
    });
  });

  test('keeps a Windows drive colon out of the line number', () => {
    const parsed = parseTraceTitle('C:\\repo\\tests\\a.spec.ts:7 › works');
    expect(parsed.filePath).toBe('C:\\repo\\tests\\a.spec.ts');
    expect(parsed.line).toBe(7);
  });

  test('survives a title with no line number', () => {
    expect(parseTraceTitle('a.spec.ts › works')).toEqual({
      filePath: 'a.spec.ts',
      line: null,
      suitePath: [],
      title: 'works',
    });
  });
});

describe('resolveSpecPath', () => {
  test('adopts the project path that ends with the recorded one', () => {
    expect(resolveSpecPath('checkout.spec.ts', ['tests/checkout.spec.ts', 'tests/login.spec.ts'])).toBe(
      'tests/checkout.spec.ts',
    );
  });

  test('prefers an exact match over a suffix match', () => {
    expect(resolveSpecPath('tests/a.spec.ts', ['e2e/tests/a.spec.ts', 'tests/a.spec.ts'])).toBe('tests/a.spec.ts');
  });

  test('prefers the shallowest match when several files share a name', () => {
    expect(resolveSpecPath('a.spec.ts', ['packages/x/tests/a.spec.ts', 'tests/a.spec.ts'])).toBe('tests/a.spec.ts');
  });

  test('keeps the recorded path when the project knows nothing about it', () => {
    expect(resolveSpecPath('brand-new.spec.ts', ['tests/other.spec.ts'])).toBe('brand-new.spec.ts');
    expect(resolveSpecPath('a.spec.ts', [])).toBe('a.spec.ts');
  });

  test('does not match a partial file name', () => {
    // `checkout.spec.ts` must not adopt `tests/my-checkout.spec.ts`.
    expect(resolveSpecPath('checkout.spec.ts', ['tests/my-checkout.spec.ts'])).toBe('checkout.spec.ts');
  });
});

describe('looksLikeTrace', () => {
  test('recognises a trace by its event stream', () => {
    expect(looksLikeTrace(['test.trace', '0-trace.network'])).toBe(true);
    expect(looksLikeTrace(['report.jsonl', 'resources/x.zip'])).toBe(false);
  });
});

describe('parseTraceArchive', () => {
  test('rebuilds a passing execution from the trace headers', async () => {
    const parsed = await parse(
      buildTraceArchive({
        title: 'checkout.spec.ts:14 › checkout › completes',
        wallTime: 1_700_000_000_000,
        monotonicTime: 1000,
        testTimeout: 45000,
        actions: [
          { apiName: 'page.goto', startTime: 1100, endTime: 1400 },
          { apiName: 'locator.click', startTime: 1400, endTime: 1500 },
        ],
      }),
    );

    expect(parsed.case.title).toBe('completes');
    expect(parsed.case.suitePath).toEqual(['checkout']);
    expect(parsed.rawFilePath).toBe('checkout.spec.ts');
    expect(parsed.case.line).toBe(14);
    expect(parsed.case.status).toBe('passed');
    expect(parsed.case.error).toBeNull();
    expect(parsed.case.timeout).toBe(45000);
    expect(parsed.case.retries).toBe(0);
    expect(parsed.startedAt).toBe(1_700_000_000_000);
    expect(parsed.playwrightVersion).toBe('1.61.1');

    // Browser config comes from the library context's options.
    expect(parsed.case.browser).toMatchObject({
      browserName: 'chromium',
      projectName: 'chromium',
      locale: 'en-US',
    });

    // Actions become steps, with the slowest one surfaced.
    expect(Array.isArray(parsed.case.steps)).toBe(true);
    expect(parsed.case.slowestStep).toBe('page.goto');
    expect(parsed.case.slowestStepDuration).toBe(300);
  });

  test('rebuilds a failing execution with its error and stack frame', async () => {
    const parsed = await parse(
      buildTraceArchive({
        error: {
          message: "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button')",
          file: '/repo/tests/checkout.spec.ts',
          line: 15,
          column: 20,
        },
      }),
    );

    expect(parsed.case.status).toBe('failed');
    expect(parsed.case.error).toContain('toBeVisible');
    // The synthetic frame is what locator healing keys on.
    expect(parsed.case.error).toContain('at /repo/tests/checkout.spec.ts:15:20');
  });

  test('records a timeout as its own status', async () => {
    const parsed = await parse(buildTraceArchive({ error: { message: 'Test timeout of 30000ms exceeded.' } }));
    expect(parsed.case.status).toBe('timedOut');
  });

  test('carries the browser console through', async () => {
    const parsed = await parse(
      buildTraceArchive({
        wallTime: 1_700_000_000_000,
        monotonicTime: 1000,
        consoleEntries: [
          { messageType: 'error', text: 'boom', time: 1500 },
          { messageType: 'log', text: 'chatter', time: 1600 },
        ],
      }),
    );

    const logs = parsed.case.consoleLogs as Array<{ type: string; text: string }>;
    // `log` is dropped, matching what the capture fixtures keep.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'error', text: 'boom' });
  });

  test('refuses a trace with no test title', async () => {
    const archive = buildTraceArchive({ omitLibraryContext: true });
    await expect(parse(archive)).rejects.toThrow(TraceImportError);
    await expect(parse(archive)).rejects.toThrow(/no test title/i);
  });

  test('refuses an archive holding no trace stream', async () => {
    const blob = buildBlobReport({ tests: [{ testId: 't', title: 'a', attempts: [{ status: 'passed' }] }] });
    await expect(parse(blob)).rejects.toThrow(/no Playwright trace data/i);
  });

  test('refuses bytes that are not a ZIP', () => {
    // Recognising the container is the reader's job, not the parser's.
    expect(() => openArchive(Buffer.from('not a zip'))).toThrow(ArchiveError);
  });

  test('survives a corrupt stream alongside a readable one', async () => {
    // A trace whose network sidecar is unreadable still yields its execution.
    const good = buildTraceArchive({ title: 'a.spec.ts:1 › works' });
    const withJunk = buildZip([
      ...(await import('../utils/zip')).parseZipSync(good),
      { name: 'junk.trace', data: Buffer.from('{not json\n') },
    ]);

    const parsed = await parse(withJunk);
    expect(parsed.case.title).toBe('works');
  });
});
