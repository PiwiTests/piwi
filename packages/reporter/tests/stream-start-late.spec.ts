import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { createGlobalSetup } from '../src/public/global-setup.js';
import { getSetupFilePath } from '../src/internal/support/setup-file.js';
import { recoveryFilePath } from '../src/internal/streaming/crash-recovery.js';
import {
  startServer,
  jsonRes,
  textRes,
  urlsHit,
  fakeConfig,
  fakeSuite,
  fakeTestCase,
  fakeResult,
  type FakeServer,
} from './_helpers.js';

/**
 * A run whose instance does not answer as it starts (a restart, a proxy's errors): the reporter asks for its stream
 * again while the run goes on, keeps the run's events meanwhile and sends them once the instance answers, saying once
 * how late; the end of the run delivers each result once, whichever way the stream went.
 */

const projectName = 'piwi-stream-late-' + process.pid;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await sleep(25);
  }
}

describe('a run whose instance is down as it starts', () => {
  let server: FakeServer | undefined;
  let lines: string[];

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      fs.rmSync(recoveryFilePath(server.url, projectName), { force: true });
      await server.close();
    }
    server = undefined;
    fs.rmSync(getSetupFilePath(projectName), { force: true });
  });

  /** The reporter's lines, from now on. */
  function captureLines(): void {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void lines.push(String(line)));
  }

  function reporterFor(url: string): PiwiDashboardReporter {
    return new PiwiDashboardReporter({
      serverUrl: url,
      projectName,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      captureResources: false,
      streamingBatchDelay: 50,
    });
  }

  /** Run the global setup and begin the run of `titles`, as Playwright does. */
  async function beginRun(reporter: PiwiDashboardReporter, url: string, titles: string[]) {
    await createGlobalSetup({ serverUrl: url, projectName })({ reporter: [['@piwitests/reporter', {}]] });
    const suite = fakeSuite();
    const tests = titles.map((title) => fakeTestCase({ id: title, title, parent: suite }));
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig(), suite);
    return tests;
  }

  function runTest(reporter: PiwiDashboardReporter, test: unknown): void {
    reporter.onTestBegin(test as never, fakeResult({ workerIndex: 0 }));
    reporter.onTestEnd(test as never, fakeResult({ status: 'passed', duration: 5, workerIndex: 0 }));
  }

  it('streams the run once the instance answers, says once how late, and sends each result once', async () => {
    const downUntil = Date.now() + 4000;
    const streamed: string[] = [];
    server = await startServer((req, res) => {
      if (Date.now() < downUntil) return textRes(res, 503, 'Service Unavailable');
      if (req.url === '/api/test-runs/start') return jsonRes(res, 200, { runId: 7, streamToken: 'tok' });
      if (req.url === '/api/test-runs/7/events') {
        for (const event of JSON.parse(req.body).testCases) streamed.push(`${event.type} ${event.title}`);
        return jsonRes(res, 200, {});
      }
      if (req.url === '/api/test-runs/7/heartbeat' || req.url === '/api/test-runs/7/finish') {
        return jsonRes(res, 200, { runId: 7 });
      }
      textRes(res, 404, 'nope');
    });
    captureLines();
    const reporter = reporterFor(server.url);
    const tests = await beginRun(reporter, server.url, ['first', 'second', 'third', 'after']);

    // Three tests run while the instance is down.
    for (const test of tests.slice(0, 3)) {
      runTest(reporter, test);
      await sleep(500);
    }
    await waitFor(() => streamed.includes('complete third'));
    // Once the stream is open, a test streams as it ends.
    runTest(reporter, tests[3]);
    await waitFor(() => streamed.includes('complete after'));
    await reporter.onEnd({ status: 'passed' } as never);

    expect([...streamed].sort()).toEqual(
      ['first', 'second', 'third', 'after'].flatMap((title) => [`begin ${title}`, `complete ${title}`]).sort(),
    );
    const urls = urlsHit(server);
    expect(urls.filter((url) => url === '/api/test-runs/7/finish')).toHaveLength(1);
    expect(urls).not.toContain('/api/test-runs/submit');
    expect(urls).not.toContain('/api/test-runs/upload');
    expect(urls).not.toContain('/api/test-runs/upload/results');
    // The instance did not answer the global setup either: the stream is a run of its own.
    expect(urls.filter((url) => url === '/api/test-runs/setup')).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith('/begin'))).toEqual([]);

    const late = lines.filter((line) => /Streaming started \d+ s late/.test(line));
    expect(late).toHaveLength(1);
    expect(Number(/started (\d+) s late/.exec(late[0]!)![1])).toBeGreaterThanOrEqual(4);
    expect(late[0]).toContain('Run ID: 7');
    expect(lines.filter((line) => line.includes('Live streaming could not start'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('Streaming enabled');
  }, 30_000);

  it('sends the run whole in one batch when the stream never opens, with no event streamed', async () => {
    let submitted: { testCases: Array<{ title: string }> } | null = null;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        submitted = JSON.parse(req.body);
        return jsonRes(res, 200, { runId: 9, projectId: 1 });
      }
      // A proxy in front of the instance answers its streaming routes with errors all run long.
      textRes(res, 502, 'Bad Gateway');
    });
    captureLines();
    const reporter = reporterFor(server.url);
    const tests = await beginRun(reporter, server.url, ['first', 'second']);
    for (const test of tests) {
      runTest(reporter, test);
      await sleep(300);
    }
    await reporter.onEnd({ status: 'passed' } as never);

    expect(submitted!.testCases.map((tc) => tc.title)).toEqual(['first', 'second']);
    const urls = urlsHit(server);
    expect(urls.filter((url) => url.includes('/events'))).toEqual([]);
    // Asked again while the run went on, and once more as it ended.
    expect(urls.filter((url) => url === '/api/test-runs/start').length).toBeGreaterThanOrEqual(2);
    expect(lines.filter((line) => line.includes('Live streaming could not start'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('Live streaming did not start before the run ended'))).toHaveLength(1);
    expect(lines.join('\n')).not.toMatch(/Streaming started|Streaming enabled/);
  }, 30_000);
});
