import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_TEST_OUTPUT_CHARS } from '@piwitests/core/test-output';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { testOutputOf } from '../src/internal/collect/test-output.js';
import { recoveryFilePath } from '../src/internal/streaming/crash-recovery.js';
import { privateTempDir } from '../src/internal/support/private-file.js';
import { hashForProject } from '../src/internal/support/instance-id.js';
import {
  fakeConfig,
  fakeResult,
  fakeSuite,
  fakeTestCase,
  jsonRes,
  startServer,
  textRes,
  type FakeServer,
} from './_helpers.js';

describe('what an attempt wrote to a stream', () => {
  it('joins its chunks in order, text and bytes read as UTF-8', () => {
    expect(testOutputOf(['seeding the cart\n', Buffer.from('2 items, total 12,50 €\n'), 'done\n'])).toBe(
      'seeding the cart\n2 items, total 12,50 €\ndone\n',
    );
  });

  it('keeps a character whole when its bytes are split across two chunks', () => {
    const euro = Buffer.from('€');
    expect(testOutputOf([Buffer.from('total 12,50 '), euro.subarray(0, 1), euro.subarray(1), Buffer.from('\n')])).toBe(
      'total 12,50 €\n',
    );
    expect(testOutputOf([euro.subarray(0, 2), 'text\n'])).toBe('\ufffdtext\n');
  });

  it('is null when the attempt wrote nothing, or only white space', () => {
    expect(testOutputOf(undefined)).toBeNull();
    expect(testOutputOf([])).toBeNull();
    expect(testOutputOf(['\n', Buffer.from('  ')])).toBeNull();
  });

  it('keeps its first and last lines, past the budget, with a line naming what was cut', () => {
    const chunks = Array.from({ length: 4000 }, (_, i) => `console.log line ${i} of the checkout test\n`);
    const kept = testOutputOf(chunks)!;
    expect(kept.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT_CHARS);
    expect(kept.startsWith('console.log line 0 of')).toBe(true);
    expect(kept.endsWith('console.log line 3999 of the checkout test\n')).toBe(true);
    expect(kept).toMatch(/\n\[… \d+ lines \(\d+ characters\) of output cut …\]\n/);
  });

  it('hides what may be a secret', () => {
    const kept = testOutputOf(['GET https://api.example.test/me?access_token=t0k3n-v4lue 200\n'])!;
    expect(kept).toBe('GET https://api.example.test/me?access_token=<hidden> 200\n');
  });
});

describe("an attempt's output on the wire", () => {
  const projectName = `piwi-test-output-${process.pid}`;
  let server: FakeServer | undefined;
  let streamed: any[];
  let submitBody: any;

  function cleanup(): void {
    const hash = hashForProject(projectName);
    for (const f of fs.readdirSync(privateTempDir())) {
      if ((f.startsWith('piwi-dashboard-stream-') || f.startsWith('piwi-dashboard-setup-')) && f.includes(hash)) {
        fs.rmSync(path.join(privateTempDir(), f), { force: true });
      }
    }
    if (server) fs.rmSync(recoveryFilePath(server.url, projectName), { force: true });
  }

  beforeEach(async () => {
    streamed = [];
    submitBody = undefined;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') jsonRes(res, 200, { runId: 3, streamToken: 'tok-3' });
      else if (req.url === '/api/test-runs/3/events') {
        streamed.push(...JSON.parse(req.body).testCases);
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/3/finish') jsonRes(res, 200, {});
      else if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 4, projectId: 1 });
      } else textRes(res, 404, 'nope');
    });
    cleanup();
  });

  afterEach(async () => {
    cleanup();
    await server?.close();
    server = undefined;
  });

  /** One test that logged a line to each stream, run by a reporter streaming or not. */
  async function runLoggingTest(streaming: boolean): Promise<void> {
    const piwi = new PiwiDashboardReporter({
      serverUrl: server!.url,
      projectName,
      streaming,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 20,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'pays with a card', parent: suite });
    suite.allTests = () => [test];
    piwi.onBegin(fakeConfig(), suite);
    piwi.onTestBegin(test, fakeResult({}));
    piwi.onTestEnd(test, {
      ...fakeResult({ status: 'failed' }),
      stdout: ['order 4521 created\n'],
      stderr: [Buffer.from('payment sandbox answered 502\n')],
    });
    await piwi.onEnd({ status: 'failed' } as any);
  }

  it('streams with its test’s result', async () => {
    await runLoggingTest(true);
    const complete = streamed.find((event) => event.type === 'complete');
    expect(complete.stdout).toBe('order 4521 created\n');
    expect(complete.stderr).toBe('payment sandbox answered 502\n');
  });

  it('goes with its test in the batch body', async () => {
    await runLoggingTest(false);
    expect(submitBody.testCases[0].stdout).toBe('order 4521 created\n');
    expect(submitBody.testCases[0].stderr).toBe('payment sandbox answered 502\n');
  });
});
