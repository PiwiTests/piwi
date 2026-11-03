import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_RUN_ERRORS } from '@piwitests/core/run-errors';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { runErrorOf } from '../src/internal/collect/run-errors.js';
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

/** The folder of the Playwright config the runs below read: errors are named relative to it. */
const CONFIG_DIR = path.join(os.tmpdir(), 'piwi-run-errors-suite');
const config = () => fakeConfig({ configFile: path.join(CONFIG_DIR, 'playwright.config.ts') });

/** As Playwright 1.64 reports a global setup that threw (`onError`, after `onBegin` with no test). */
const GLOBAL_SETUP_ERROR = {
  message: 'Error: global setup could not sign in at https://auth.example.test/login?token=s3cr3t-v4lue',
  stack: [
    'Error: global setup could not sign in at https://auth.example.test/login?token=s3cr3t-v4lue',
    `    at module.exports (${path.join(CONFIG_DIR, 'global-setup.ts')}:4:9)`,
  ].join('\n'),
  location: { file: path.join(CONFIG_DIR, 'global-setup.ts'), line: 4, column: 9 },
  snippet: '> 4 |   throw new Error(…)',
};

describe('an error outside any test', () => {
  it('keeps its message, the frames of its stack and its place, named relative to the config folder', () => {
    expect(runErrorOf(GLOBAL_SETUP_ERROR, CONFIG_DIR)).toEqual({
      message: 'Error: global setup could not sign in at https://auth.example.test/login?token=<hidden>',
      stack: `    at module.exports (${path.join(CONFIG_DIR, 'global-setup.ts')}:4:9)`,
      location: { file: 'global-setup.ts', line: 4, column: 9 },
    });
  });

  it('keeps the error a spec that did not load names, with no stack or place when it has none', () => {
    expect(runErrorOf({ message: 'Error: No tests found', stack: 'Error: No tests found' }, CONFIG_DIR)).toEqual({
      message: 'Error: No tests found',
      stack: null,
      location: null,
    });
  });

  it('names the value thrown when it was no Error, and the causes after the message', () => {
    expect(runErrorOf({ value: "'declined'" }, CONFIG_DIR)?.message).toBe("'declined'");
    const fetchFailed = {
      message: 'TypeError: fetch failed',
      cause: { message: 'Error: connect ECONNREFUSED 127.0.0.1:3000', cause: { value: '{ code: 42 }' } },
    };
    expect(runErrorOf(fetchFailed, CONFIG_DIR)?.message).toBe(
      'TypeError: fetch failed\n[cause]: Error: connect ECONNREFUSED 127.0.0.1:3000\n[cause]: { code: 42 }',
    );
  });

  it('reads its message from its stack when it has none, and is null when it says nothing', () => {
    expect(runErrorOf({ stack: 'Error: boom\n    at x (/a.ts:1:1)' }, CONFIG_DIR)?.message).toBe('Error: boom');
    expect(runErrorOf({}, CONFIG_DIR)).toBeNull();
  });
});

describe('the errors of a run outside its tests', () => {
  const projectName = `piwi-run-errors-${process.pid}`;
  let server: FakeServer | undefined;
  let finishBody: any;
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
    finishBody = undefined;
    submitBody = undefined;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') jsonRes(res, 200, { runId: 7, streamToken: 'tok-7' });
      else if (req.url === '/api/test-runs/7/events') jsonRes(res, 200, {});
      else if (req.url === '/api/test-runs/7/finish') {
        finishBody = JSON.parse(req.body);
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 8, projectId: 1 });
      } else textRes(res, 404, 'nope');
    });
    cleanup();
  });

  afterEach(async () => {
    cleanup();
    await server?.close();
    server = undefined;
  });

  function reporter(streaming: boolean): PiwiDashboardReporter {
    return new PiwiDashboardReporter({
      serverUrl: server!.url,
      projectName,
      streaming,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 20,
    });
  }

  it('reach the run’s /finish when its global setup threw before any test', async () => {
    const piwi = reporter(true);
    // Playwright begins a run that stopped before its tests with no test, then reports its errors.
    piwi.onBegin(config(), fakeSuite());
    piwi.onError(GLOBAL_SETUP_ERROR);
    await piwi.onEnd({ status: 'failed' } as any);

    expect(finishBody.status).toBe('failed');
    expect(finishBody.totalTests).toBe(0);
    expect(finishBody.runErrors).toEqual([
      {
        message: 'Error: global setup could not sign in at https://auth.example.test/login?token=<hidden>',
        stack: `    at module.exports (${path.join(CONFIG_DIR, 'global-setup.ts')}:4:9)`,
        location: { file: 'global-setup.ts', line: 4, column: 9 },
      },
    ]);
  });

  it('go with the batch body, next to the tests, and keep the first ' + MAX_RUN_ERRORS, async () => {
    const piwi = reporter(false);
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'adds to the cart', parent: suite });
    suite.allTests = () => [test];
    piwi.onBegin(config(), suite);
    piwi.onTestBegin(test, fakeResult({}));
    piwi.onTestEnd(test, fakeResult({ status: 'passed' }));
    // A worker fixture whose teardown threw, once per worker, after the tests.
    for (let worker = 0; worker < MAX_RUN_ERRORS + 3; worker++) {
      piwi.onError({
        message: `Error: worker ${worker} teardown failed`,
        stack: 'Error: x\n    at teardown (/a.ts:1:1)',
      });
    }
    await piwi.onEnd({ status: 'failed' } as any);

    expect(submitBody.testCases).toHaveLength(1);
    expect(submitBody.runErrors).toHaveLength(MAX_RUN_ERRORS);
    expect(submitBody.runErrors[0].message).toBe('Error: worker 0 teardown failed');
    expect(submitBody.runErrors.at(-1).message).toBe(`Error: worker ${MAX_RUN_ERRORS - 1} teardown failed`);
  });

  it('are left out of a run that had none', async () => {
    const piwi = reporter(false);
    piwi.onBegin(config(), fakeSuite());
    await piwi.onEnd({ status: 'passed' } as any);
    expect(submitBody).toBeDefined();
    expect('runErrors' in submitBody).toBe(false);
  });
});
