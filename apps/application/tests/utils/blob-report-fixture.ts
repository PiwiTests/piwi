/**
 * Builds a synthetic Playwright blob report for tests.
 *
 * The event shapes mirror what `--reporter=blob` writes (verified against
 * Playwright 1.61): a `report.jsonl` event stream plus one `resources/<sha1>`
 * entry per attachment. Generating it beats committing a recorded archive —
 * the interesting variations (retries, skips, shards, unrun tests) are set by
 * argument instead of by re-recording, and no binary enters the repo.
 */

import { buildZip, type ZipEntry } from '../../server/utils/trace-zip';

export interface FixtureTest {
  testId: string;
  title: string;
  /** Describe blocks wrapping the test, outermost first. */
  suitePath?: string[];
  line?: number;
  column?: number;
  timeout?: number;
  /** Playwright's `repeatEachIndex`: the `--repeat-each` repetition this test is, 0 by default. */
  repeatEachIndex?: number;
  /** One entry per attempt; an empty array leaves the test unrun. */
  attempts?: Array<{
    status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
    duration?: number;
    errorMessage?: string;
    annotations?: Array<{ type: string; description?: string }>;
    /** Attach a `trace` (zip), `screenshot` (png) or `error-context` (markdown). */
    attachments?: Array<{ name: string; contentType: string; body: string }>;
  }>;
}

export interface FixtureOptions {
  file?: string;
  rootDir?: string;
  configFile?: string;
  projectName?: string;
  playwrightVersion?: string;
  blobVersion?: number;
  shard?: { current: number; total: number } | null;
  runStatus?: string;
  startTime?: number;
  duration?: number;
  tests: FixtureTest[];
}

/** Build the archive bytes for a blob report describing `options.tests`. */
export function buildBlobReport(options: FixtureOptions): Buffer {
  const {
    file = 'demo.spec.ts',
    rootDir = '/repo/tests',
    configFile = '../playwright.config.ts',
    projectName = 'chromium',
    playwrightVersion = '1.61.1',
    blobVersion = 2,
    shard = null,
    runStatus = 'passed',
    startTime = 1_700_000_000_000,
    duration = 1234,
    tests,
  } = options;

  const lines: unknown[] = [
    { method: 'onBlobReportMetadata', params: { version: blobVersion, userAgent: 'test', pathSeparator: '/' } },
    {
      method: 'onConfigure',
      params: { config: { configFile, rootDir, version: playwrightVersion, shard, metadata: {}, workers: 1 } },
    },
    { method: 'onProject', params: { project: buildProject(projectName, file, tests) } },
    { method: 'onBegin' },
  ];

  const resources: ZipEntry[] = [];
  let resourceIndex = 0;

  for (const test of tests) {
    for (const [retry, attempt] of (test.attempts ?? []).entries()) {
      const resultId = `${test.testId}-r${retry}`;

      lines.push({
        method: 'onTestBegin',
        params: {
          testId: test.testId,
          result: { id: resultId, retry, workerIndex: retry, parallelIndex: retry, startTime: startTime + retry * 100 },
        },
      });

      // One real step so the metrics helpers have something to fold.
      const stepId = `${resultId}-step`;
      lines.push({
        method: 'onStepBegin',
        params: {
          testId: test.testId,
          resultId,
          step: {
            id: stepId,
            title: `Expect "toBeVisible" ${test.title}`,
            category: 'expect',
            startTime: startTime + retry * 100,
            location: { file, line: test.line ?? 3, column: test.column ?? 5 },
          },
        },
      });
      lines.push({
        method: 'onStepEnd',
        params: {
          testId: test.testId,
          resultId,
          step: {
            id: stepId,
            duration: attempt.duration ?? 10,
            ...(attempt.errorMessage ? { error: { message: attempt.errorMessage } } : {}),
          },
        },
      });

      const attachments = (attempt.attachments ?? []).map((attachment) => {
        const extension = attachment.contentType === 'text/markdown' ? 'markdown' : 'bin';
        const path = `resources/fixture-${resourceIndex++}.${extension}`;
        resources.push({ name: path, data: Buffer.from(attachment.body, 'utf-8') });
        return { name: attachment.name, contentType: attachment.contentType, path };
      });

      if (attachments.length > 0) {
        lines.push({ method: 'onAttach', params: { testId: test.testId, resultId, attachments } });
      }

      lines.push({
        method: 'onTestEnd',
        params: {
          test: {
            testId: test.testId,
            expectedStatus: attempt.annotations?.some((a) => a.type === 'fail') ? 'failed' : 'passed',
            timeout: test.timeout ?? 30000,
            annotations: [],
          },
          result: {
            id: resultId,
            duration: attempt.duration ?? 10,
            status: attempt.status,
            errors: attempt.errorMessage
              ? [
                  {
                    message: attempt.errorMessage,
                    stack: attempt.errorMessage,
                    location: { file: `${rootDir}/${file}`, line: test.line ?? 3, column: test.column ?? 5 },
                  },
                ]
              : [],
            ...(attempt.annotations ? { annotations: attempt.annotations } : {}),
          },
        },
      });
    }
  }

  lines.push({ method: 'onEnd', params: { result: { status: runStatus, startTime, duration } } });

  const jsonl = lines.map((line) => JSON.stringify(line)).join('\n');
  return buildZip([{ name: 'report.jsonl', data: Buffer.from(jsonl, 'utf-8') }, ...resources]);
}

/** Nest the tests under their describe blocks inside one file suite. */
function buildProject(projectName: string, file: string, tests: FixtureTest[]) {
  const fileSuite: Record<string, unknown> = {
    title: file,
    location: { file, line: 1, column: 1 },
    entries: [] as unknown[],
  };

  for (const test of tests) {
    let container = fileSuite;
    for (const suiteTitle of test.suitePath ?? []) {
      const siblings = container.entries as Record<string, unknown>[];
      let next = siblings.find((entry) => entry.title === suiteTitle && !entry.testId);
      if (!next) {
        next = { title: suiteTitle, location: { file, line: 1, column: 1 }, entries: [] };
        siblings.push(next);
      }
      container = next;
    }

    (container.entries as unknown[]).push({
      testId: test.testId,
      title: test.title,
      location: { file, line: test.line ?? 3, column: test.column ?? 5 },
      retries: 1,
      tags: [],
      repeatEachIndex: test.repeatEachIndex ?? 0,
      annotations: [],
      timeout: test.timeout ?? 30000,
    });
  }

  return { name: projectName, timeout: 30000, retries: 1, suites: [fileSuite], use: {} };
}

export interface TraceFixtureOptions {
  /** Display title Playwright writes: `file:line › suite › … › test`. */
  title?: string;
  browserName?: string;
  /** Epoch ms the context opened — the anchor for every monotonic timestamp. */
  wallTime?: number;
  monotonicTime?: number;
  testTimeout?: number;
  playwrightVersion?: string;
  /** Failure recorded by the runner; omit for a passing trace. */
  error?: { message: string; file?: string; line?: number; column?: number };
  actions?: Array<{ apiName: string; startTime: number; endTime?: number; error?: string }>;
  consoleEntries?: Array<{ messageType: string; text: string; time: number }>;
  /** Drop the library context, as a test that never opened a page does. */
  omitLibraryContext?: boolean;
}

/**
 * Build a bare Playwright trace archive: the runner stream (`test.trace`) plus
 * the browser-context stream (`0-trace.trace`) that carries the display title.
 */
export function buildTraceArchive(options: TraceFixtureOptions = {}): Buffer {
  const {
    title = 'demo.spec.ts:12 › checkout › completes',
    browserName = 'chromium',
    wallTime = 1_700_000_000_000,
    monotonicTime = 1000,
    testTimeout = 30000,
    playwrightVersion = '1.61.1',
    error,
    actions = [{ apiName: 'locator.click', startTime: monotonicTime + 10, endTime: monotonicTime + 60 }],
    consoleEntries = [],
    omitLibraryContext = false,
  } = options;

  const runner: unknown[] = [
    {
      version: 8,
      type: 'context-options',
      origin: 'testRunner',
      browserName: '',
      playwrightVersion,
      options: {},
      wallTime,
      monotonicTime,
      sdkLanguage: 'javascript',
      testTimeout,
    },
  ];

  if (error) {
    runner.push({
      type: 'error',
      message: error.message,
      stack: error.file ? [{ file: error.file, line: error.line ?? 1, column: error.column ?? 1 }] : [],
    });
  }

  const library: unknown[] = omitLibraryContext
    ? []
    : [
        {
          version: 8,
          type: 'context-options',
          origin: 'library',
          browserName,
          playwrightVersion,
          options: { viewport: { width: 1280, height: 720 }, locale: 'en-US', isMobile: false },
          wallTime: wallTime + 100,
          monotonicTime: monotonicTime + 100,
          sdkLanguage: 'javascript',
          title,
        },
      ];

  for (const [index, action] of actions.entries()) {
    const callId = `call@${index}`;
    library.push({
      type: 'before',
      callId,
      apiName: action.apiName,
      class: 'Locator',
      method: action.apiName.split('.').pop(),
      startTime: action.startTime,
    });
    library.push({
      type: 'after',
      callId,
      ...(action.endTime != null ? { endTime: action.endTime } : {}),
      ...(action.error ? { error: { message: action.error } } : {}),
    });
  }

  for (const entry of consoleEntries) {
    library.push({ type: 'console', messageType: entry.messageType, text: entry.text, time: entry.time });
  }

  const entries: ZipEntry[] = [
    { name: 'test.trace', data: Buffer.from(runner.map((line) => JSON.stringify(line)).join('\n'), 'utf-8') },
  ];
  if (library.length > 0) {
    entries.push({
      name: '0-trace.trace',
      data: Buffer.from(library.map((line) => JSON.stringify(line)).join('\n'), 'utf-8'),
    });
  }

  return buildZip(entries);
}

/** An `error-context` attachment body, as Playwright writes it on failure. */
export function errorContextMarkdown(options: { snapshot: string; source: Array<[number, string]> }): string {
  const source = options.source.map(([line, text]) => `  ${String(line).padStart(2)} | ${text}`).join('\n');
  return [
    '# Test info',
    '',
    '- Name: demo',
    '',
    '# Error details',
    '',
    '```',
    'Error: something failed',
    '```',
    '',
    '```yaml',
    options.snapshot,
    '```',
    '',
    '# Test source',
    '',
    '```ts',
    source,
    '```',
    '',
  ].join('\n');
}
