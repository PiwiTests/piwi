import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { RunSubmitter, type CollectedRun } from '../src/internal/submit/run-submitter.js';
import { HttpClient } from '../src/internal/transport/http-client.js';
import { privateTempDir } from '../src/internal/support/private-file.js';
import { Uploader } from '../src/internal/submit/uploader.js';
import { CrashRecovery, recoveryFilePath } from '../src/internal/streaming/crash-recovery.js';
import { FileHandler } from '../src/internal/files/file-handler.js';
import { Logger } from '../src/internal/support/logger.js';
import { hashForProject } from '../src/internal/support/instance-id.js';
import { writeSetupFailure, writeSetupInfo } from '../src/internal/support/setup-file.js';
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

const STREAM_PREFIX = 'piwi-dashboard-stream-';
const SETUP_PREFIX = 'piwi-dashboard-setup-';
/** The waits of a submitter made here before it asks again: as many tries as the reporter's, without its seconds. */
const RETRY_DELAYS_MS = [10, 20];

function cleanupProjectArtifacts(projectName: string, server?: FakeServer): void {
  // Stream-buffer files are keyed by a sha1 hash of the project name, so match
  // on the hash rather than the raw name; a recovery file by the server too.
  const tmp = privateTempDir();
  const hash = hashForProject(projectName);
  for (const f of fs.readdirSync(tmp)) {
    if (f.startsWith(STREAM_PREFIX) || f.startsWith(SETUP_PREFIX)) {
      if (f.includes(hash) || f.includes(projectName)) {
        try {
          fs.unlinkSync(path.join(tmp, f));
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (server) fs.rmSync(recoveryFilePath(server.url, projectName), { force: true });
}

/** The run the recovery file of `server` holds. */
function recoveredRun(server: FakeServer, projectName: string): any {
  return JSON.parse(fs.readFileSync(recoveryFilePath(server.url, projectName), 'utf8')).payload;
}

async function runOneTest(reporter: PiwiDashboardReporter, title: string, status = 'passed'): Promise<void> {
  const suite = fakeSuite();
  const test = fakeTestCase({ title, parent: suite });
  suite.allTests = () => [test];
  reporter.onBegin(fakeConfig(), suite);
  reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
  reporter.onTestEnd(test, fakeResult({ status, duration: 5, workerIndex: 0 }));
  await reporter.onEnd({ status: 'passed' } as any);
}

describe('PiwiDashboardReporter submit/fallback ladder', () => {
  let server: FakeServer;
  const projectName = 'piwi-ladder-' + process.pid;
  const reportDirs: string[] = [];

  /** A report folder on disk, for a run that has a file to attach. */
  function reportDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-ladder-report-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>report</html>');
    reportDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    cleanupProjectArtifacts(projectName);
  });

  afterEach(async () => {
    if (server) await server.close();
    cleanupProjectArtifacts(projectName, server);
    for (const dir of reportDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a run that stopped before any test began (its global setup threw) sends and saves nothing', async () => {
    server = await startServer((_req, res) => textRes(res, 400, 'no'));
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      uploadReport: false,
      uploadTraces: false,
    });
    await reporter.onEnd({ status: 'failed' } as any);
    expect(urlsHit(server)).toEqual([]);
    expect(fs.existsSync(recoveryFilePath(server.url, projectName))).toBe(false);
  });

  it('streaming success path: /start → /events → /finish', async () => {
    let eventsBody: any;
    let finishBody: any;
    const tokenHeaders: Record<string, unknown> = {};
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok-123' });
      } else if (req.url === '/api/test-runs/1/events') {
        eventsBody = JSON.parse(req.body);
        tokenHeaders.events = req.headers['x-piwi-run-token'];
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        finishBody = JSON.parse(req.body);
        tokenHeaders.finish = req.headers['x-piwi-run-token'];
        jsonRes(res, 200, {});
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 50,
    });
    await runOneTest(reporter, 'streaming-test');

    const urls = urlsHit(server).filter((u) => u !== '/api/auth/me');
    expect(urls.includes('/api/test-runs/start'), `urls: ${urls.join(', ')}`).toBeTruthy();
    expect(urls.includes('/api/test-runs/1/events'), `urls: ${urls.join(', ')}`).toBeTruthy();
    expect(urls.includes('/api/test-runs/1/finish'), `urls: ${urls.join(', ')}`).toBeTruthy();
    expect(urls.includes('/api/test-runs/submit')).toBeFalsy();
    expect(urls.includes('/api/test-runs/upload')).toBeFalsy();

    // finish body carries the run status + counters
    expect(finishBody.status).toBe('passed');
    expect(finishBody.streamToken).toBe('tok-123');
    // The stream token goes in the run token header of events and finish too.
    expect(tokenHeaders).toEqual({ events: 'tok-123', finish: 'tok-123' });
    expect(finishBody.totalTests).toBe(1);
    expect(finishBody.passedTests).toBe(1);
    // and the run's start, which with its duration places a shard in its sharded run
    expect(Date.parse(finishBody.startTime)).toBeLessThanOrEqual(Date.now() - finishBody.duration);
    // events body carries testCases array
    expect(Array.isArray(eventsBody.testCases)).toBeTruthy();
    expect(eventsBody.testCases.length >= 1).toBeTruthy();
  });

  it('streaming disabled, no files: JSON /submit only', async () => {
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 10, projectId: 20 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    await runOneTest(reporter, 'json-test');

    const urls = urlsHit(server);
    expect(urls.includes('/api/test-runs/submit')).toBeTruthy();
    expect(urls.includes('/api/test-runs/upload')).toBeFalsy();
    expect(urls.some((u) => u.endsWith('/finish'))).toBeFalsy();
    // submit payload has the wire testCases (no `attachments` / `_filesUploaded`)
    expect(submitBody.projectName).toBe(projectName);
    expect(submitBody.status).toBe('passed');
    expect(submitBody.testCases.length).toBe(1);
    expect('attachments' in submitBody.testCases[0]).toBe(false);
    expect('_filesUploaded' in submitBody.testCases[0]).toBe(false);
    // No stream ran, so the batch replaces no run.
    expect('replacesRun' in submitBody).toBe(false);
  });

  it('writes the CI output file with the submitted run identity', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        jsonRes(res, 200, { runId: 99, projectId: 5 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const outputFile = path.join(os.tmpdir(), `piwi-run-${process.pid}.json`);
    try {
      const reporter = new PiwiDashboardReporter({
        serverUrl: server.url,
        projectName,
        streaming: false,
        uploadReport: false,
        uploadTraces: false,
        liveFileUploads: false,
        outputFile,
      });
      await runOneTest(reporter, 'output-file-test');

      const parsed = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
      expect(parsed.runId).toBe(99);
      expect(parsed.projectId).toBe(5);
      expect(parsed.status).toBe('passed');
      expect(parsed.runUrl).toBe(`${server.url}/test-runs/99`);
    } finally {
      fs.rmSync(outputFile, { force: true });
    }
  });

  it('streaming disabled, a report to attach: multipart /upload only (no /submit)', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/upload') {
        jsonRes(res, 200, { runId: 11, projectId: 21 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      reports: [{ type: 'custom', dir: reportDir() }],
    });
    await runOneTest(reporter, 'upload-test');

    const urls = urlsHit(server);
    // The report goes with the multipart /upload, which succeeds, so /submit is not called.
    expect(urls.includes('/api/test-runs/upload'), `urls: ${urls.join(', ')}`).toBeTruthy();
    expect(urls.includes('/api/test-runs/submit')).toBeFalsy();
  });

  describe('a batch run with files, uploaded in parts', () => {
    /** A screenshot on disk, attached to a test the way Playwright attaches one. */
    function screenshot(content: string): any {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-ladder-shot-'));
      reportDirs.push(dir);
      const file = path.join(dir, `${content}.png`);
      fs.writeFileSync(file, content);
      return { name: 'screenshot', path: file, contentType: 'image/png' };
    }

    /** A batch run of two failing tests, each with its screenshot, and a report. */
    async function runInParts(handler: Parameters<typeof startServer>[0], shard: unknown = null): Promise<void> {
      server = await startServer(handler);
      const reporter = new PiwiDashboardReporter({
        serverUrl: server.url,
        projectName,
        streaming: false,
        uploadReport: false,
        uploadTraces: false,
        liveFileUploads: false,
        reports: [{ type: 'custom', dir: reportDir() }],
      });
      const suite = fakeSuite();
      const tests = ['pays', 'ships'].map((t) => fakeTestCase({ title: t, parent: suite }));
      suite.allTests = () => tests;
      reporter.onBegin(fakeConfig({ shard }), suite);
      for (const test of tests) {
        reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
        reporter.onTestEnd(
          test,
          fakeResult({ status: 'failed', workerIndex: 0, attachments: [screenshot(`${test.title}-SHOT`)] }),
        );
      }
      await reporter.onEnd({ status: 'failed' } as any);
    }

    it("sends the results, then each test's files with the token their answer carries, then the report, which settles the run", async () => {
      let resultsBody: any;
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          resultsBody = JSON.parse(req.body);
          jsonRes(res, 200, { success: true, runId: 21, projectId: 2, streamToken: 'held-token' });
        } else if (req.url === '/api/test-runs/21/case-files' || req.url === '/api/test-runs/upload') {
          jsonRes(res, 200, { success: true, runId: 21 });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      expect(urlsHit(server)).toEqual([
        '/api/test-runs/upload/results',
        '/api/test-runs/21/case-files',
        '/api/test-runs/21/case-files',
        '/api/test-runs/upload',
      ]);
      expect(resultsBody.testCases.map((tc: any) => tc.title)).toEqual(['pays', 'ships']);
      expect(resultsBody.deliveryKey).toMatch(/^[0-9a-f-]{36}$/);
      const [pays, ships] = server.requests.filter((r) => r.url === '/api/test-runs/21/case-files');
      expect(pays!.body).toContain('held-token');
      expect(pays!.body).toContain('pays-SHOT');
      expect(ships!.body).toContain('ships-SHOT');
      const settle = server.requests.find((r) => r.url === '/api/test-runs/upload')!.body;
      expect(settle).toContain('name="runId"');
      expect(settle).toContain('name="report_custom"');
    });

    it('a test whose files are refused as too large leaves the others, and the run settles without its refused report', async () => {
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          jsonRes(res, 200, { success: true, runId: 21, projectId: 2, streamToken: 'held-token' });
        } else if (req.url === '/api/test-runs/21/case-files') {
          if (req.body.includes('pays-SHOT')) jsonRes(res, 413, { message: 'Upload too large (max 1 MB)' });
          else jsonRes(res, 200, { success: true });
        } else if (req.url === '/api/test-runs/upload') {
          if (req.body.includes('name="report_')) jsonRes(res, 413, { message: 'Upload too large (max 1 MB)' });
          else jsonRes(res, 200, { success: true, runId: 21 });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      const caseFiles = server.requests.filter((r) => r.url === '/api/test-runs/21/case-files');
      expect(caseFiles.map((r) => r.body.includes('ships-SHOT'))).toEqual([false, true]);
      const uploads = server.requests.filter((r) => r.url === '/api/test-runs/upload');
      expect(uploads).toHaveLength(2);
      expect(uploads[1]!.body).toContain('already-submitted');
      expect(uploads[1]!.body).not.toContain('name="report_');
      // The run went through its first rung: no single upload of the whole run, no JSON submit.
      expect(uploads.some((r) => r.body.includes('name="testCases"') && r.body.includes('"pays"'))).toBe(false);
      expect(urlsHit(server)).not.toContain('/api/test-runs/submit');
    });

    it('the run settles even when the dashboard refuses every one of its files', async () => {
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          jsonRes(res, 200, { success: true, runId: 21, projectId: 2, streamToken: 'held-token' });
        } else if (req.url === '/api/test-runs/21/case-files') {
          jsonRes(res, 500, { message: 'storage unavailable' });
        } else if (req.url === '/api/test-runs/upload') {
          if (req.body.includes('name="report_')) jsonRes(res, 413, { message: 'Upload too large (max 1 MB)' });
          else jsonRes(res, 200, { success: true, runId: 21 });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      expect(urlsHit(server).filter((u) => u === '/api/test-runs/21/case-files')).toHaveLength(2);
      const uploads = server.requests.filter((r) => r.url === '/api/test-runs/upload');
      expect(uploads.map((r) => r.body.includes('already-submitted') && !r.body.includes('name="report_'))).toEqual([
        false,
        true,
      ]);
      expect(urlsHit(server)).not.toContain('/api/test-runs/submit');
    });

    it('sends the results again when their answer was lost, and the files with the token the repeat carries', async () => {
      const resultsBodies: any[] = [];
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          resultsBodies.push(JSON.parse(req.body));
          // The dashboard holds the run, but its answer never arrives; the repeat gets a new token for the files.
          if (resultsBodies.length === 1) return req.raw.socket?.destroy();
          jsonRes(res, 200, { success: true, runId: 21, projectId: 2, duplicate: true, streamToken: 'renewed-token' });
        } else if (req.url === '/api/test-runs/21/case-files' || req.url === '/api/test-runs/upload') {
          jsonRes(res, 200, { success: true, runId: 21 });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      expect(urlsHit(server)).toEqual([
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/21/case-files',
        '/api/test-runs/21/case-files',
        '/api/test-runs/upload',
      ]);
      expect(resultsBodies[1].deliveryKey).toBe(resultsBodies[0].deliveryKey);
      const caseFiles = server.requests.filter((r) => r.url === '/api/test-runs/21/case-files');
      expect(caseFiles.every((r) => r.body.includes('renewed-token'))).toBe(true);
      expect(server.requests.find((r) => r.url === '/api/test-runs/upload')!.body).toContain('name="report_custom"');
    });

    it('sends the run in one upload under the same key when no answer to its results ever came', async () => {
      let uploadBody = '';
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          textRes(res, 503, 'unavailable');
        } else if (req.url === '/api/test-runs/upload') {
          uploadBody = req.body;
          jsonRes(res, 200, { success: true, runId: 11, projectId: 2 });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      expect(urlsHit(server)).toEqual([
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/upload',
      ]);
      const deliveryKey = JSON.parse(server.requests[0]!.body).deliveryKey;
      expect(uploadBody).toContain(`"deliveryKey":"${deliveryKey}"`);
      expect(uploadBody).toContain('pays-SHOT');
    });

    it('sends the files of the run the one upload is answered as a repeat of, with its token, and settles it', async () => {
      const resultsBodies: any[] = [];
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          // The dashboard holds the run from its results, but none of the three answers arrives.
          resultsBodies.push(JSON.parse(req.body));
          req.raw.socket?.destroy();
        } else if (req.url === '/api/test-runs/upload') {
          if (req.body.includes('name="runId"')) return jsonRes(res, 200, { success: true, runId: 21 });
          // A repeat of the held run: its files are left unread, and a token for them comes back.
          jsonRes(res, 200, { success: true, runId: 21, projectId: 2, duplicate: true, streamToken: 'renewed-token' });
        } else if (req.url === '/api/test-runs/21/case-files') {
          jsonRes(res, 200, { success: true });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      expect(urlsHit(server)).toEqual([
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/upload',
        '/api/test-runs/21/case-files',
        '/api/test-runs/21/case-files',
        '/api/test-runs/upload',
      ]);
      const [whole, settle] = server.requests.filter((r) => r.url === '/api/test-runs/upload');
      expect(whole!.body).toContain(`"deliveryKey":"${resultsBodies[0].deliveryKey}"`);
      expect(whole!.body).not.toContain('name="runId"');
      const caseFiles = server.requests.filter((r) => r.url === '/api/test-runs/21/case-files');
      expect(caseFiles.every((r) => r.body.includes('renewed-token'))).toBe(true);
      expect(caseFiles.map((r) => r.body.includes('pays-SHOT'))).toEqual([true, false]);
      expect(caseFiles[1]!.body).toContain('ships-SHOT');
      expect(settle!.body).toMatch(/name="runId"\r\n\r\n21\r\n/);
      expect(settle!.body).toContain('name="report_custom"');
      expect(urlsHit(server)).not.toContain('/api/test-runs/submit');
    });

    it("a repeat answer to the one upload without a token (an older dashboard's) ends the delivery there", async () => {
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          textRes(res, 503, 'unavailable');
        } else if (req.url === '/api/test-runs/upload') {
          jsonRes(res, 200, { success: true, runId: 21, projectId: 2, duplicate: true });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      expect(urlsHit(server)).toEqual([
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/upload',
      ]);
    });

    it('sends the files of the run its JSON submit is answered as a repeat of, after the one upload was refused', async () => {
      const resultsBodies: any[] = [];
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          // The dashboard holds the run from its results, but none of the three answers arrives.
          resultsBodies.push(JSON.parse(req.body));
          req.raw.socket?.destroy();
        } else if (req.url === '/api/test-runs/upload') {
          if (req.body.includes('name="runId"')) return jsonRes(res, 200, { success: true, runId: 21 });
          jsonRes(res, 413, { message: 'Upload too large (max 1 MB)' });
        } else if (req.url === '/api/test-runs/submit') {
          // A repeat of the held run: a token for its files comes back.
          jsonRes(res, 200, { success: true, runId: 21, projectId: 2, duplicate: true, streamToken: 'renewed-token' });
        } else if (req.url === '/api/test-runs/21/case-files') {
          jsonRes(res, 200, { success: true });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      expect(urlsHit(server)).toEqual([
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/upload',
        '/api/test-runs/submit',
        '/api/test-runs/21/case-files',
        '/api/test-runs/21/case-files',
        '/api/test-runs/upload',
      ]);
      const submitted = JSON.parse(server.requests.find((r) => r.url === '/api/test-runs/submit')!.body);
      expect(submitted.deliveryKey).toBe(resultsBodies[0].deliveryKey);
      const caseFiles = server.requests.filter((r) => r.url === '/api/test-runs/21/case-files');
      expect(caseFiles.every((r) => r.body.includes('renewed-token'))).toBe(true);
      expect(caseFiles.map((r) => r.body.includes('pays-SHOT'))).toEqual([true, false]);
      expect(caseFiles[1]!.body).toContain('ships-SHOT');
      const settle = server.requests.filter((r) => r.url === '/api/test-runs/upload')[1]!.body;
      expect(settle).toMatch(/name="runId"\r\n\r\n21\r\n/);
      expect(settle).toContain('name="report_custom"');
    });

    it("a repeat answer to the JSON submit without a token (an older dashboard's) ends the delivery there", async () => {
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          textRes(res, 503, 'unavailable');
        } else if (req.url === '/api/test-runs/upload') {
          jsonRes(res, 413, { message: 'Upload too large (max 1 MB)' });
        } else if (req.url === '/api/test-runs/submit') {
          jsonRes(res, 200, { success: true, runId: 21, projectId: 2, duplicate: true });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      expect(urlsHit(server)).toEqual([
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/upload/results',
        '/api/test-runs/upload',
        '/api/test-runs/submit',
      ]);
    });

    it('results refused as too large go on alone, never in an upload that carries the files too', async () => {
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          jsonRes(res, 413, { message: 'Request body over 32 MB' });
        } else if (req.url === '/api/test-runs/submit') {
          jsonRes(res, 200, { success: true, runId: 12, projectId: 2 });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      expect(urlsHit(server)).toEqual(['/api/test-runs/upload/results', '/api/test-runs/submit']);
    });

    it('a shard, whose run settles with its last shard, sends its results and files in one upload', async () => {
      await runInParts(
        (req, res) =>
          req.url === '/api/test-runs/upload'
            ? jsonRes(res, 200, { success: true, runId: 11, projectId: 2 })
            : textRes(res, 404, 'nope'),
        { current: 1, total: 2 },
      );

      expect(urlsHit(server)).toEqual(['/api/test-runs/upload']);
    });

    it('a dashboard without /upload/results gets the run, its files and its report in one multipart upload', async () => {
      let uploadBody = '';
      await runInParts((req, res) => {
        if (req.url === '/api/test-runs/upload') {
          uploadBody = req.body;
          jsonRes(res, 200, { success: true, runId: 11, projectId: 2 });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      expect(urlsHit(server)).toEqual(['/api/test-runs/upload/results', '/api/test-runs/upload']);
      expect(uploadBody).toContain('name="testRun"');
      expect(uploadBody).toContain('pays-SHOT');
      expect(uploadBody).toContain('ships-SHOT');
      expect(uploadBody).toContain('name="report_custom"');
    });
  });

  it('fallback: /upload fails → /submit succeeds', async () => {
    let submitBody: any;
    let uploadBody = '';
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/upload') {
        uploadBody = req.body;
        textRes(res, 500, 'boom');
      } else if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 12, projectId: 22 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      reports: [{ type: 'custom', dir: reportDir() }],
    });
    await runOneTest(reporter, 'fallback-test');

    const urls = urlsHit(server);
    const uploadIdx = urls.indexOf('/api/test-runs/upload');
    const submitIdx = urls.indexOf('/api/test-runs/submit');
    expect(uploadIdx, `urls: ${urls.join(', ')}`).toBeGreaterThanOrEqual(0);
    expect(submitIdx, `urls: ${urls.join(', ')}`).toBeGreaterThanOrEqual(0);
    expect(uploadIdx < submitIdx, 'upload must be tried before submit').toBeTruthy();
    // The dashboard learns which rung delivered the run, and why.
    expect(submitBody.metadata.ingestHealth).toEqual({ submitFallback: { path: 'submit', reason: 'upload-failed' } });
    // Both rungs deliver the run under one key, so a dashboard that stored the upload stores the run once.
    expect(submitBody.deliveryKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(uploadBody).toContain(`"deliveryKey":"${submitBody.deliveryKey}"`);
  });

  it('a failed /finish falls back to /upload and names the fallback in the run metadata', async () => {
    let uploadBody = '';
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        textRes(res, 404, 'run not found');
      } else if (req.url === '/api/test-runs/upload') {
        uploadBody = req.body;
        jsonRes(res, 200, { runId: 2, projectId: 3 });
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: true,
      liveFileUploads: false,
      streamingBatchDelay: 50,
      reports: [{ type: 'custom', dir: reportDir() }],
    });
    await runOneTest(reporter, 'finish-fails-test');

    expect(urlsHit(server)).toContain('/api/test-runs/upload');
    expect(uploadBody).toContain('"ingestHealth":{"submitFallback":{"path":"upload","reason":"finish-failed"}}');
  });

  it('a run with no file to attach skips the multipart upload and sends its results as JSON', async () => {
    server = await startServer((req, res) =>
      req.url === '/api/test-runs/submit' ? jsonRes(res, 200, { runId: 3, projectId: 4 }) : textRes(res, 404, 'nope'),
    );

    // uploadReport and uploadTraces keep their defaults, on; the run has no report, trace or attachment.
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      liveFileUploads: false,
    });
    await runOneTest(reporter, 'nothing-to-attach-test');

    expect(urlsHit(server)).toEqual(['/api/test-runs/submit']);
  });

  it('a streamed run with no report to upload finishes without waiting for one', async () => {
    let finishBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        finishBody = JSON.parse(req.body);
        jsonRes(res, 200, { success: true, runId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      liveFileUploads: false,
      streamingBatchDelay: 50,
    });
    await runOneTest(reporter, 'no-report-test');

    expect(finishBody.hasPendingUploads).toBe(false);
    expect(urlsHit(server)).not.toContain('/api/test-runs/upload');
  });

  it('settles a streamed run whose reports the dashboard refuses with an upload that carries none', async () => {
    let finishBody: any;
    const uploads: string[] = [];
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        finishBody = JSON.parse(req.body);
        jsonRes(res, 200, { success: true, runId: 1, status: 'finalizing' });
      } else if (req.url === '/api/test-runs/upload') {
        uploads.push(req.body);
        if (req.body.includes('name="report_custom"')) jsonRes(res, 413, { message: 'Upload too large (max 500 MB)' });
        else jsonRes(res, 200, { success: true, runId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 50,
      reports: [{ type: 'custom', dir: reportDir() }],
    });
    await runOneTest(reporter, 'refused-report-test');

    // `/finish` left the run waiting for its reports, which the dashboard then refused.
    expect(finishBody.hasPendingUploads).toBe(true);
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toContain('already-submitted');
    expect(uploads[1]).not.toContain('name="report_');
  });

  it('all upload methods fail → recovery file is written', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        textRes(res, 500, 'down');
      } else if (req.url === '/api/test-runs/upload') {
        textRes(res, 500, 'down');
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    // Should not throw — recovery saves the payload instead.
    await runOneTest(reporter, 'recovery-test');

    // A recovery file should now exist in tmpdir for this project.
    const recovered = recoveredRun(server, projectName);
    expect(recovered.projectName).toBe(projectName);
  });

  it('a sign-in page answering in place of the dashboard is no delivery: the run is saved for the next one', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Sign in</title>');
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    await runOneTest(reporter, 'sign-in-page-test');

    expect(urlsHit(server)).toContain('/api/test-runs/submit');
    expect(recoveredRun(server, projectName).testCases[0].title).toBe('sign-in-page-test');
  });

  it('batch mode retries a saved recovery payload on the next run', async () => {
    let up = false;
    const submits: any[] = [];
    server = await startServer((req, res) => {
      if (!up) {
        textRes(res, 500, 'down');
      } else if (req.url === '/api/test-runs/submit') {
        submits.push(JSON.parse(req.body));
        jsonRes(res, 200, { runId: 30 + submits.length, projectId: 20 });
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const failing = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    await runOneTest(failing, 'lost-run-test');
    expect(
      fs.existsSync(recoveryFilePath(server.url, projectName)),
      'expected a recovery file after the failed run',
    ).toBe(true);
    const mode = fs.statSync(recoveryFilePath(server.url, projectName)).mode & 0o777;
    if (process.platform !== 'win32') expect(mode, 'readable by its owner only').toBe(0o600);

    up = true;
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    await runOneTest(reporter, 'second-run-test');

    const titles = submits.map((s) => s.testCases[0].title);
    expect(titles, `submits: ${titles.join(', ')}`).toContain('lost-run-test');
    const lost = submits.find((s) => s.testCases[0].title === 'lost-run-test');
    const second = submits.find((s) => s.testCases[0].title === 'second-run-test');
    expect(lost.metadata.ingestHealth).toEqual({ submitFallback: { path: 'recovery' } });
    // A run delivered by its usual rung names no fallback.
    expect(second.metadata.ingestHealth).toBeUndefined();
    expect(titles, `submits: ${titles.join(', ')}`).toContain('second-run-test');
    expect(fs.existsSync(recoveryFilePath(server.url, projectName)), 'recovery file is cleared after the retry').toBe(
      false,
    );
  });

  it('buffer overflow drops results → skips /finish and re-sends the full run via /submit', async () => {
    let finishHit = false;
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        finishHit = true;
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 1, projectId: 2 });
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      // Huge batch settings so events accumulate in the buffer (no mid-run
      // flush), and a tiny budget so per-test results are evicted.
      streamingBatchSize: 100000,
      streamingBatchDelay: 60000,
      maxStreamBufferBytes: 1000,
    });

    // Each complete event carries a big error string, blowing past the budget.
    const bigError = new Error('x'.repeat(3000));
    const suite = fakeSuite();
    const tests = ['t1', 't2', 't3', 't4'].map((t) => fakeTestCase({ title: t, parent: suite }));
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig(), suite);
    for (const test of tests) {
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(test, fakeResult({ status: 'failed', duration: 5, workerIndex: 0, error: bigError }));
    }
    await reporter.onEnd({ status: 'failed' } as any);

    const urls = urlsHit(server).filter((u) => u !== '/api/auth/me');
    // /finish must be skipped because live results were dropped under pressure…
    expect(finishHit, `urls: ${urls.join(', ')}`).toBe(false);
    // …and the full run must still reach the server via the batch /submit.
    expect(submitBody, `urls: ${urls.join(', ')}`).toBeTruthy();
    expect(submitBody.testCases.length).toBe(4);
    expect(submitBody.metadata.ingestHealth).toEqual({ submitFallback: { path: 'submit', reason: 'results-lost' } });
  });

  it('a run the dashboard ended (409) is streamed no more, and goes whole in the batch upload', async () => {
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url?.startsWith('/api/test-runs/1/')) {
        // Another job with the same run label started, and the dashboard cancelled this run.
        jsonRes(res, 409, { message: 'Test run is not in running state' });
      } else if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 2, projectId: 3 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchSize: 1,
      streamingBatchDelay: 50,
    });
    const suite = fakeSuite();
    const tests = ['first', 'second', 'third'].map((t) => fakeTestCase({ title: t, parent: suite }));
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig(), suite);
    await (reporter as any).streamManager.startPromise;
    const runRequests = () => urlsHit(server).filter((u) => u.startsWith('/api/test-runs/1/'));
    const [first, ...later] = tests;
    reporter.onTestBegin(first!, fakeResult({ workerIndex: 0 }));
    reporter.onTestEnd(first!, fakeResult({ status: 'passed', duration: 5, workerIndex: 0 }));
    for (let i = 0; i < 100 && runRequests().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    // The begin and the result of the first test, sent before the dashboard's answer came back.
    const refused = runRequests();
    expect(refused.length).toBeGreaterThan(0);

    for (const test of later) {
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(test, fakeResult({ status: 'passed', duration: 5, workerIndex: 0 }));
      await new Promise((r) => setTimeout(r, 100));
    }
    await reporter.onEnd({ status: 'passed' } as any);

    // The refusal ends the stream: no later events, no heartbeat, no /finish.
    expect(runRequests()).toEqual(refused);
    expect(refused.every((u) => u === '/api/test-runs/1/events')).toBe(true);
    expect(submitBody.testCases.map((tc: any) => tc.title)).toEqual(['first', 'second', 'third']);
    expect(submitBody.metadata.ingestHealth).toEqual({ submitFallback: { path: 'submit', reason: 'run-ended' } });
  });

  it('a result too large for /events keeps the stream going and re-sends the full run via /submit', async () => {
    const streamed: string[] = [];
    let finishHit = false;
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        // A request-size limit in front of the dashboard, like a reverse proxy's.
        if (Buffer.byteLength(req.body) > 1024 * 1024) return textRes(res, 413, 'too large');
        streamed.push(...JSON.parse(req.body).testCases.map((e: any) => `${e.type}:${e.title}`));
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        finishHit = true;
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 1, projectId: 2 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 50,
    });
    const suite = fakeSuite();
    const tests = ['small-1', 'huge', 'small-2'].map((t) => fakeTestCase({ title: t, parent: suite }));
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig(), suite);
    for (const test of tests) {
      const huge = test.title === 'huge';
      const result = fakeResult({ status: huge ? 'failed' : 'passed', workerIndex: 0 });
      if (huge) result.errors = [{ message: 'x'.repeat(2 * 1024 * 1024) }];
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(test, result);
    }
    await reporter.onEnd({ status: 'failed' } as any);

    expect(streamed).toContain('complete:small-1');
    expect(streamed).toContain('complete:small-2');
    expect(streamed).not.toContain('complete:huge');
    expect(finishHit).toBe(false);
    expect(submitBody.testCases.map((tc: any) => tc.title)).toEqual(['small-1', 'huge', 'small-2']);
  });

  it('submitTimeout stops waiting for a hung dashboard and saves the run for the next one', async () => {
    // Accepts every request and never answers, like a hung process or a
    // firewall that drops the replies.
    server = await startServer(() => {});

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 50,
      submitTimeout: 300,
    });
    const started = Date.now();
    await runOneTest(reporter, 'hung-dashboard-test');

    // Each request alone would wait for the 30 s socket timeout.
    expect(Date.now() - started).toBeLessThan(10_000);
    const recovered = recoveredRun(server, projectName);
    expect(recovered.testCases[0].title).toBe('hung-dashboard-test');
    server.server.closeAllConnections();
  });

  it('keeps part of submitTimeout for /finish: file uploads that hang are cut short and the run is finished', async () => {
    const screenshot = path.join(reportDir(), 'screenshot.png');
    fs.writeFileSync(screenshot, 'PNG');
    let finishes = 0;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/case-files') {
        // Takes the upload and never answers.
      } else if (req.url === '/api/test-runs/1/finish') {
        finishes++;
        jsonRes(res, 200, { success: true, runId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      streamingBatchDelay: 50,
      submitTimeout: 2000,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'hung-upload-test', parent: suite });
    suite.allTests = () => [test];
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
    reporter.onTestEnd(
      test,
      fakeResult({
        status: 'failed',
        workerIndex: 0,
        attachments: [{ name: 'screenshot', contentType: 'image/png', path: screenshot }],
      }),
    );
    await reporter.onEnd({ status: 'failed' } as any);

    expect(finishes).toBe(1);
    expect(fs.existsSync(recoveryFilePath(server.url, projectName))).toBe(false);
    server.server.closeAllConnections();
  });

  it('keeps part of submitTimeout for /finish: a trace check that hangs is cut short and the run is finished', async () => {
    const trace = path.join(reportDir(), 'trace.zip');
    fs.writeFileSync(trace, 'TRACE');
    let finishes = 0;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        jsonRes(res, 200, {});
      } else if (req.url === '/api/traces/check') {
        // Takes the check and never answers.
      } else if (req.url === '/api/test-runs/1/finish') {
        finishes++;
        jsonRes(res, 200, { success: true, runId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: true,
      streamingBatchDelay: 50,
      submitTimeout: 2000,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'hung-trace-check-test', parent: suite });
    suite.allTests = () => [test];
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
    reporter.onTestEnd(
      test,
      fakeResult({
        status: 'failed',
        workerIndex: 0,
        attachments: [{ name: 'trace', contentType: 'application/zip', path: trace }],
      }),
    );
    await reporter.onEnd({ status: 'failed' } as any);

    expect(urlsHit(server)).toContain('/api/traces/check');
    expect(finishes).toBe(1);
    expect(fs.existsSync(recoveryFilePath(server.url, projectName))).toBe(false);
    server.server.closeAllConnections();
  });

  it('a non-finite submitTimeout means no limit', async () => {
    server = await startServer((req, res) =>
      req.url === '/api/test-runs/submit' ? jsonRes(res, 200, { runId: 5 }) : textRes(res, 404, 'nope'),
    );
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      submitTimeout: Infinity,
    });
    await runOneTest(reporter, 'unbounded-test');

    expect(urlsHit(server)).toContain('/api/test-runs/submit');
    expect(fs.existsSync(recoveryFilePath(server.url, projectName))).toBe(false);
  });

  it('a 401 with no credential stops the ladder and saves a recovery copy, leaving the run result alone', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        textRes(res, 401, 'unauthorized');
      } else if (req.url === '/api/test-runs/upload') {
        textRes(res, 401, 'unauthorized');
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      reports: [{ type: 'custom', dir: reportDir() }],
    });
    // onEnd never throws: Playwright would count it as a failure of a green run.
    await expect(runOneTest(reporter, 'auth-fail-test')).resolves.toBeUndefined();

    // No other rung can succeed without a credential.
    expect(urlsHit(server)).not.toContain('/api/test-runs/submit');
    // The run is not lost: a recovery copy is written.
    const recovered = recoveredRun(server, projectName);
    expect(recovered.projectName).toBe(projectName);
    expect(recovered.testCases[0].title).toBe('auth-fail-test');
  });

  it('a failed login saves a recovery copy without failing the run', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/api/auth/login') textRes(res, 401, 'bad credentials');
      else textRes(res, 404, 'nope');
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      username: 'ci',
      password: 'wrong',
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    await expect(runOneTest(reporter, 'login-fail-test')).resolves.toBeUndefined();

    expect(urlsHit(server)).toEqual(['/api/auth/login']);
    const recovered = recoveredRun(server, projectName);
    expect(recovered.testCases[0].title).toBe('login-fail-test');
  });

  it('a serverUrl that is not a whole http(s) URL leaves the reporter off with a warning, sending nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reporter = new PiwiDashboardReporter({ serverUrl: 'piwi.example.com', projectName });
      await runOneTest(reporter, 'bad-url-test');

      expect(warn.mock.calls.map((call) => String(call[0]))).toContain(
        `[Piwi Dashboard] serverUrl "piwi.example.com" is not a URL: give the dashboard's whole address, such as https://piwi.example.com. Nothing is sent to the dashboard.`,
      );
      expect(fs.existsSync(recoveryFilePath('piwi.example.com', projectName))).toBe(false);
    } finally {
      warn.mockRestore();
      fs.rmSync(recoveryFilePath('piwi.example.com', projectName), { force: true });
    }
  });

  it('a disabled reporter writes no attachment to disk and keeps no live stream', async () => {
    const reporter = new PiwiDashboardReporter({ serverUrl: 'http://127.0.0.1:1', projectName, enabled: false });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'disabled-test', parent: suite });
    suite.allTests = () => [test];
    const attachments = [{ name: 'order payload', contentType: 'application/json', body: Buffer.from('{}') }];
    try {
      reporter.onBegin(fakeConfig(), suite);
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(test, fakeResult({ status: 'failed', workerIndex: 0, attachments }));
      await reporter.onEnd({ status: 'failed' } as any);

      expect((reporter as any).fileHandler.stagedDir).toBeNull();
      expect((reporter as any).streamManager).toBeNull();
    } finally {
      (reporter as any).fileHandler.cleanupBodyAttachments();
    }
  });

  it('leaves the terminal output to Playwright', () => {
    expect(new PiwiDashboardReporter({ serverUrl: 'http://localhost:1', projectName }).printsToStdio()).toBe(false);
  });
});

describe("the dashboard's storage quota", () => {
  let server: FakeServer;
  const projectName = 'piwi-quota-' + process.pid;
  const dirs: string[] = [];
  let warnings: string[];

  const FREES_SPACE =
    'A shorter retention on the dashboard frees space, and a higher quota (PIWI_STORAGE_QUOTA_BYTES where the dashboard runs) raises the limit.';
  const RUN_REFUSED_LINE = `[Piwi Dashboard] The dashboard refused this run: its storage is past its quota, and past the ceiling at which it refuses new runs. The tests and the run's exit code are not affected, and nothing of this run is sent. ${FREES_SPACE}`;
  const STREAMED_REST_REFUSED_LINE = `[Piwi Dashboard] The dashboard kept what this run streamed and refused the rest: its storage is past its quota. The run's data is saved on this machine for a later run to send once the dashboard has room. ${FREES_SPACE}`;

  /** A refusal of the dashboard, as every one of its own carries its error code. */
  function refuse(res: Parameters<typeof jsonRes>[0], errorCode: string | null): void {
    jsonRes(res, 409, {
      statusCode: 409,
      message: 'Refused.',
      ...(errorCode ? { data: { errorCode } } : {}),
    });
  }

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-quota-'));
    dirs.push(dir);
    return dir;
  }

  /** A report folder on disk. */
  function reportDir(): string {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>report</html>');
    return dir;
  }

  /** A screenshot on disk, attached to a test the way Playwright attaches one. */
  function screenshot(content: string): any {
    const file = path.join(tempDir(), `${content}.png`);
    fs.writeFileSync(file, content);
    return { name: 'screenshot', path: file, contentType: 'image/png' };
  }

  /**
   * Run two failing tests, each with its screenshot, and answer what `onEnd` returns. `afterFirst` runs once the first
   * test ended.
   */
  async function runTwoTests(
    options: Record<string, unknown>,
    shard: unknown = null,
    afterFirst?: () => Promise<void>,
  ): Promise<unknown> {
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 20,
      captureResources: false,
      ...options,
    });
    const suite = fakeSuite();
    const tests = ['pays', 'ships'].map((t) => fakeTestCase({ title: t, parent: suite }));
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig({ shard }), suite);
    for (const test of tests) {
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(
        test,
        fakeResult({ status: 'failed', workerIndex: 0, attachments: [screenshot(`${test.title}-SHOT`)] }),
      );
      if (test === tests[0]) await afterFirst?.();
    }
    return reporter.onEnd({ status: 'failed' } as any);
  }

  const quotaLines = () => warnings.filter((line) => line.includes('storage'));
  const runRequests = () => urlsHit(server).filter((u) => u.startsWith('/api/test-runs'));

  beforeEach(() => {
    cleanupProjectArtifacts(projectName);
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void warnings.push(String(line)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await server.close();
    cleanupProjectArtifacts(projectName, server);
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('refusing the files', () => {
    it('a run uploaded in parts sends no file after the refusal, and settles with the counts of what it left out', async () => {
      server = await startServer((req, res) => {
        if (req.url === '/api/test-runs/upload/results') {
          jsonRes(res, 200, { success: true, runId: 21, projectId: 2, streamToken: 'held-token' });
        } else if (req.url === '/api/test-runs/21/case-files') {
          refuse(res, 'STORAGE_QUOTA_FILES_REFUSED');
        } else if (req.url === '/api/test-runs/upload') {
          jsonRes(res, 200, { success: true, runId: 21 });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      const ended = await runTwoTests({ streaming: false, reports: [{ type: 'custom', dir: reportDir() }] });

      expect(ended).toBeUndefined();
      expect(urlsHit(server)).toEqual([
        '/api/test-runs/upload/results',
        '/api/test-runs/21/case-files',
        '/api/test-runs/upload',
      ]);
      const settle = server.requests.find((r) => r.url === '/api/test-runs/upload')!.body;
      expect(settle).not.toContain('name="report_');
      expect(settle).toContain('"ingestHealth":{"attachmentsNotKept":2,"reportsNotKept":1}');
      expect(quotaLines()).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(fs.existsSync(recoveryFilePath(server.url, projectName))).toBe(false);
    });

    it('a streamed run counts what it left out in its /finish, which settles it with no report to wait for', async () => {
      let finishBody: any;
      server = await startServer((req, res) => {
        if (req.url === '/api/test-runs/start') {
          jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
        } else if (req.url === '/api/test-runs/1/events') {
          jsonRes(res, 200, {});
        } else if (req.url === '/api/test-runs/1/case-files') {
          refuse(res, 'STORAGE_QUOTA_FILES_REFUSED');
        } else if (req.url === '/api/test-runs/1/finish') {
          finishBody = JSON.parse(req.body);
          jsonRes(res, 200, {});
        } else {
          textRes(res, 404, 'nope');
        }
      });

      const ended = await runTwoTests({ streaming: true, reports: [{ type: 'custom', dir: reportDir() }] });

      expect(ended).toBeUndefined();
      expect(runRequests().filter((u) => u === '/api/test-runs/1/case-files')).toHaveLength(1);
      expect(runRequests()).not.toContain('/api/test-runs/upload');
      expect(finishBody.hasPendingUploads).toBe(false);
      expect(finishBody.metadata.ingestHealth).toEqual({ attachmentsNotKept: 2, reportsNotKept: 1 });
      expect(quotaLines()).toHaveLength(1);
    });

    it('a streamed run uploading files live sends none after the refusal, and counts what it left out in its /finish', async () => {
      let finishBody: any;
      server = await startServer((req, res) => {
        if (req.url === '/api/test-runs/start') {
          jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
        } else if (req.url === '/api/test-runs/1/events') {
          jsonRes(res, 200, {});
        } else if (req.url === '/api/test-runs/1/case-files') {
          refuse(res, 'STORAGE_QUOTA_FILES_REFUSED');
        } else if (req.url === '/api/test-runs/1/finish') {
          finishBody = JSON.parse(req.body);
          jsonRes(res, 200, {});
        } else {
          textRes(res, 404, 'nope');
        }
      });

      const ended = await runTwoTests(
        { streaming: true, liveFileUploads: true, reports: [{ type: 'custom', dir: reportDir() }] },
        null,
        // The first test's files are refused before the second test ends.
        () => vi.waitFor(() => expect(quotaLines()).toHaveLength(1), { timeout: 5000 }),
      );

      expect(ended).toBeUndefined();
      expect(runRequests().filter((u) => u === '/api/test-runs/1/case-files')).toHaveLength(1);
      expect(runRequests()).not.toContain('/api/test-runs/upload');
      expect(finishBody.hasPendingUploads).toBe(false);
      expect(finishBody.metadata.ingestHealth).toEqual({ attachmentsNotKept: 2, reportsNotKept: 1 });
      expect(quotaLines()).toHaveLength(1);
    });

    it('a streamed run that falls back after the refusal sends its results alone, counting every file', async () => {
      let submitBody: any;
      server = await startServer((req, res) => {
        if (req.url === '/api/test-runs/start') {
          jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
        } else if (req.url === '/api/test-runs/1/events') {
          jsonRes(res, 200, {});
        } else if (req.url === '/api/test-runs/1/case-files') {
          refuse(res, 'STORAGE_QUOTA_FILES_REFUSED');
        } else if (req.url === '/api/test-runs/1/finish') {
          jsonRes(res, 400, { message: 'Invalid body' });
        } else if (req.url === '/api/test-runs/submit') {
          submitBody = JSON.parse(req.body);
          jsonRes(res, 200, { runId: 2, projectId: 2 });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      await runTwoTests({ streaming: true, reports: [{ type: 'custom', dir: reportDir() }] });

      expect(runRequests()).not.toContain('/api/test-runs/upload/results');
      expect(runRequests()).not.toContain('/api/test-runs/upload');
      expect(submitBody.metadata.ingestHealth).toEqual({
        attachmentsNotKept: 2,
        reportsNotKept: 1,
        submitFallback: { path: 'submit', reason: 'finish-failed' },
      });
      expect(quotaLines()).toHaveLength(1);
    });

    it('says once when the one upload of a run keeps its results and none of its files', async () => {
      server = await startServer((req, res) => {
        if (req.url === '/api/test-runs/upload') {
          jsonRes(res, 200, {
            success: true,
            runId: 11,
            projectId: 2,
            filesNotKept: { count: 3, errorCode: 'STORAGE_QUOTA_FILES_REFUSED' },
          });
        } else {
          textRes(res, 404, 'nope');
        }
      });

      const ended = await runTwoTests(
        { streaming: false, reports: [{ type: 'custom', dir: reportDir() }] },
        { current: 1, total: 2 },
      );

      expect(ended).toBeUndefined();
      expect(urlsHit(server)).toEqual(['/api/test-runs/upload']);
      expect(quotaLines()).toHaveLength(1);
    });
  });

  describe('refusing the run', () => {
    for (const { refused, streaming, reports } of [
      { refused: '/api/test-runs/start', streaming: true, reports: false },
      { refused: '/api/test-runs/upload/results', streaming: false, reports: true },
      { refused: '/api/test-runs/upload', streaming: false, reports: true },
      { refused: '/api/test-runs/submit', streaming: false, reports: false },
    ]) {
      it(`at ${refused}: says so once, and asks nothing more and saves no copy, the run's result unchanged`, async () => {
        server = await startServer((req, res) =>
          req.url === refused ? refuse(res, 'STORAGE_QUOTA_EXCEEDED') : textRes(res, 404, 'nope'),
        );

        const ended = await runTwoTests(
          { streaming, ...(reports ? { reports: [{ type: 'custom', dir: reportDir() }] } : {}) },
          refused === '/api/test-runs/upload' ? { current: 1, total: 2 } : null,
        );

        expect(ended).toBeUndefined();
        expect(urlsHit(server)).toEqual([refused]);
        expect(warnings).toEqual([RUN_REFUSED_LINE]);
        expect(fs.existsSync(recoveryFilePath(server.url, projectName))).toBe(false);
      });
    }

    it('the global setup said so: the reporter sends nothing, replays no saved run and says nothing more', async () => {
      server = await startServer((_req, res) => jsonRes(res, 200, { runId: 1, streamToken: 'tok' }));
      new CrashRecovery(server.url, projectName).save({ projectName, testCases: [] });
      writeSetupFailure(projectName, 'Request failed with status 409: Refused.', true);

      const ended = await runTwoTests({ streaming: true, reports: [{ type: 'custom', dir: reportDir() }] });

      expect(ended).toBeUndefined();
      expect(urlsHit(server)).toEqual([]);
      expect(warnings).toEqual([]);
      expect(recoveredRun(server, projectName)).toEqual({ projectName, testCases: [] });
    });

    it('the replay of a saved run is refused: the copy stays, and the run is not asked for', async () => {
      server = await startServer((req, res) =>
        req.url === '/api/test-runs/submit' ? refuse(res, 'STORAGE_QUOTA_EXCEEDED') : textRes(res, 404, 'nope'),
      );
      new CrashRecovery(server.url, projectName).save({ projectName, label: 'saved', testCases: [] });

      const ended = await runTwoTests({ streaming: true });

      expect(ended).toBeUndefined();
      expect(urlsHit(server)).toEqual(['/api/test-runs/submit']);
      expect(warnings).toEqual([RUN_REFUSED_LINE]);
      expect(recoveredRun(server, projectName).label).toBe('saved');
    });

    it('the replay of a saved run is refused for a run the global setup registered: the copy stays, the run goes on', async () => {
      server = await startServer((req, res) => {
        if (req.url === '/api/test-runs/submit') refuse(res, 'STORAGE_QUOTA_EXCEEDED');
        else if (req.url === '/api/test-runs/7/begin') jsonRes(res, 200, { runId: 7, streamToken: 'tok' });
        else if (req.url?.startsWith('/api/test-runs/7/')) jsonRes(res, 200, {});
        else textRes(res, 404, 'nope');
      });
      new CrashRecovery(server.url, projectName).save({ projectName, label: 'saved', testCases: [] });
      writeSetupInfo({ runId: 7, setupToken: 'setup', projectName });

      const ended = await runTwoTests({ streaming: true });

      expect(ended).toBeUndefined();
      expect(runRequests().slice(0, 2)).toEqual(['/api/test-runs/submit', '/api/test-runs/7/begin']);
      expect(runRequests().slice(-1)).toEqual(['/api/test-runs/7/finish']);
      expect(quotaLines()).toEqual([]);
      expect(recoveredRun(server, projectName).label).toBe('saved');
    });

    for (const { refused, reports } of [
      { refused: '/api/test-runs/submit', reports: false },
      { refused: '/api/test-runs/upload/results', reports: true },
    ]) {
      it(`at ${refused} after the stream opened: says the streamed run stays, and saves the copy that replaces it`, async () => {
        server = await startServer((req, res) => {
          if (req.url === '/api/test-runs/start') jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
          else if (req.url === '/api/test-runs/1/events' || req.url === '/api/test-runs/1/case-files') {
            jsonRes(res, 200, {});
          } else if (req.url === '/api/test-runs/1/finish') jsonRes(res, 400, { message: 'Invalid body' });
          else if (req.url === refused) refuse(res, 'STORAGE_QUOTA_EXCEEDED');
          else textRes(res, 404, 'nope');
        });

        const ended = await runTwoTests({
          streaming: true,
          ...(reports ? { reports: [{ type: 'custom', dir: reportDir() }] } : {}),
        });

        expect(ended).toBeUndefined();
        expect(runRequests()).toContain('/api/test-runs/1/finish');
        expect(runRequests().slice(-1)).toEqual([refused]);
        expect(runRequests().filter((u) => !u.startsWith('/api/test-runs/1/'))).toEqual([
          '/api/test-runs/start',
          refused,
        ]);
        expect(quotaLines()).toEqual([STREAMED_REST_REFUSED_LINE]);
        const copy = recoveredRun(server, projectName);
        expect(copy.replacesRun).toEqual({ runId: 1, streamToken: 'tok' });
        expect(copy.testCases).toHaveLength(2);
      });
    }
  });

  it("reads an older dashboard's 409 without a code as a plain refusal: the stream gives up, the batch is sent and saved", async () => {
    server = await startServer((req, res) =>
      req.url === '/api/test-runs/start' || req.url === '/api/test-runs/submit'
        ? refuse(res, null)
        : textRes(res, 404, 'nope'),
    );

    const ended = await runTwoTests({ streaming: true });

    expect(ended).toBeUndefined();
    expect(urlsHit(server)).toEqual(['/api/test-runs/start', '/api/test-runs/submit']);
    expect(quotaLines()).toEqual([]);
    expect(warnings.join('\n')).toContain('Live streaming is unavailable');
    expect(recoveredRun(server, projectName).testCases).toHaveLength(2);
  });
});

describe('RunSubmitter local copies', () => {
  let server: FakeServer;
  const projectName = 'piwi-submitter-' + process.pid;

  beforeEach(() => cleanupProjectArtifacts(projectName));
  afterEach(async () => {
    if (server) await server.close();
    cleanupProjectArtifacts(projectName, server);
  });

  function collectedRun(serverUrl: string): CollectedRun {
    return {
      options: { serverUrl, projectName, uploadReport: false, uploadTraces: false },
      testCases: [],
      startTime: new Date().toISOString(),
      playwrightVersion: null,
      reporterVersion: null,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      timedOutTests: 0,
      didNotRunTests: 0,
      metadata: {},
      instanceId: 'instance',
      shardInfo: null,
      setupSteps: [],
      isFullRun: true,
      filterDetails: null,
    };
  }

  function streamSession(overrides: Record<string, unknown> = {}) {
    return {
      startPromise: null,
      drain: async () => {},
      auth: null,
      enabled: true,
      runId: 1,
      token: 'tok',
      lostResults: false,
      uploadRemaining: async () => {},
      discardBuffered: vi.fn(),
      ...overrides,
    };
  }

  function submitter(url: string, sm: ReturnType<typeof streamSession>): RunSubmitter {
    const logger = new Logger(false);
    const http = new HttpClient(url, logger);
    return new RunSubmitter(
      http,
      new Uploader(http, new FileHandler(logger), logger),
      new CrashRecovery(url, projectName, logger),
      sm as any,
      logger,
      null,
      RETRY_DELAYS_MS,
    );
  }

  it("discards the run's buffered live events once /finish succeeds", async () => {
    server = await startServer((req, res) =>
      req.url === '/api/test-runs/1/finish' ? jsonRes(res, 200, {}) : textRes(res, 404, 'nope'),
    );
    const sm = streamSession();
    await submitter(server.url, sm).submit(collectedRun(server.url), { status: 'passed' } as any);
    expect(sm.discardBuffered).toHaveBeenCalledOnce();
  });

  it('asks /finish again when its answer was lost, and takes a refusal of the repeat as the run finished', async () => {
    let finishes = 0;
    server = await startServer((req, res) => {
      if (req.url !== '/api/test-runs/1/finish') return textRes(res, 404, 'nope');
      finishes++;
      // The dashboard finishes the run, but its answer never arrives; the repeat finds the run closed.
      if (finishes === 1) return req.raw.socket?.destroy();
      jsonRes(res, 409, { message: 'Test run is not in running state' });
    });
    const sm = streamSession();
    const submitted = await submitter(server.url, sm).submit(collectedRun(server.url), { status: 'passed' } as any);

    expect(urlsHit(server)).toEqual(['/api/test-runs/1/finish', '/api/test-runs/1/finish']);
    expect(submitted?.runId).toBe(1);
    expect(sm.discardBuffered).toHaveBeenCalledOnce();
    expect(fs.existsSync(recoveryFilePath(server.url, projectName))).toBe(false);
  });

  it('falls back to the batch submit once every try at /finish failed, naming the run it streamed', async () => {
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/1/finish') return textRes(res, 503, 'unavailable');
      if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        return jsonRes(res, 200, { runId: 2 });
      }
      textRes(res, 404, 'nope');
    });
    const sm = streamSession();
    const submitted = await submitter(server.url, sm).submit(collectedRun(server.url), { status: 'passed' } as any);

    expect(urlsHit(server)).toEqual([
      '/api/test-runs/1/finish',
      '/api/test-runs/1/finish',
      '/api/test-runs/1/finish',
      '/api/test-runs/submit',
    ]);
    expect(submitted?.runId).toBe(2);
    // The dashboard may hold the streamed run for its reports: the batch, proven by the run's token, replaces it.
    expect(submitBody.replacesRun).toEqual({ runId: 1, streamToken: 'tok' });
  });

  it("a shard's batch names no run it replaces: the other shards share the run it streamed", async () => {
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/1/finish') return textRes(res, 404, 'run not found');
      if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        return jsonRes(res, 200, { runId: 2 });
      }
      textRes(res, 404, 'nope');
    });
    const run = { ...collectedRun(server.url), shardInfo: { current: 1, total: 2 } };
    await submitter(server.url, streamSession()).submit(run, { status: 'passed' } as any);

    expect(submitBody.shardTotal).toBe(2);
    expect('replacesRun' in submitBody).toBe(false);
  });

  it("sends the suite's setup steps with the batch submit a stream fell back to", async () => {
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url !== '/api/test-runs/submit') return textRes(res, 404, 'nope');
      submitBody = JSON.parse(req.body);
      jsonRes(res, 200, { runId: 2 });
    });
    const step = {
      title: 'beforeAll hook',
      category: 'hook',
      startedAt: 1_700_000_000_000,
      duration: 12,
      status: 'passed',
      location: 'tests/a.spec.ts:3:1',
      workerIndex: 0,
    };
    const run = { ...collectedRun(server.url), setupSteps: [step] };
    await submitter(server.url, streamSession({ lostResults: true })).submit(run, { status: 'passed' } as any);

    expect(submitBody.setupSteps).toEqual([step]);
  });

  it("discards the run's buffered live events once the batch submit succeeds", async () => {
    server = await startServer((req, res) =>
      req.url === '/api/test-runs/submit' ? jsonRes(res, 200, { runId: 2 }) : textRes(res, 404, 'nope'),
    );
    const sm = streamSession({ lostResults: true });
    await submitter(server.url, sm).submit(collectedRun(server.url), { status: 'passed' } as any);
    expect(urlsHit(server)).toEqual(['/api/test-runs/submit']);
    expect(sm.discardBuffered).toHaveBeenCalledOnce();
  });

  it("keeps an earlier run's recovery file when the run itself goes through: only its own replay deletes it", async () => {
    server = await startServer((req, res) =>
      req.url === '/api/test-runs/submit' ? jsonRes(res, 200, { runId: 3 }) : textRes(res, 404, 'nope'),
    );
    new CrashRecovery(server.url, projectName).save({ projectName, testCases: [] });
    const sm = streamSession({ lostResults: true });
    await submitter(server.url, sm).submit(collectedRun(server.url), { status: 'passed' } as any);
    expect(sm.discardBuffered).toHaveBeenCalledOnce();
    expect(recoveredRun(server, projectName)).toEqual({ projectName, testCases: [] });
  });

  it('keeps the buffered live events when no rung delivers the run', async () => {
    server = await startServer((_req, res) => textRes(res, 400, 'refused'));
    const sm = streamSession();
    await submitter(server.url, sm).submit(collectedRun(server.url), { status: 'passed' } as any);
    expect(sm.discardBuffered).not.toHaveBeenCalled();
    expect(fs.existsSync(recoveryFilePath(server.url, projectName))).toBe(true);
  });
});

describe('the HTML report a run uploads', () => {
  let server: FakeServer;
  let dir: string;
  const projectName = 'piwi-html-report-' + process.pid;

  beforeEach(() => {
    cleanupProjectArtifacts(projectName);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-html-report-run-'));
  });
  afterEach(async () => {
    if (server) await server.close();
    cleanupProjectArtifacts(projectName, server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Run one test under a config in `dir` with these reporters; `report` writes what the html reporter would. */
  async function runWithReporters(reporters: unknown[], report?: () => void): Promise<string> {
    let uploadBody = '';
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/upload') uploadBody = req.body;
      if (req.url === '/api/test-runs/upload' || req.url === '/api/test-runs/submit') {
        jsonRes(res, 200, { runId: 1, projectId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'reported', parent: suite });
    suite.allTests = () => [test];
    reporter.onBegin(
      { ...fakeConfig({ configFile: path.join(dir, 'playwright.config.ts') }), reporter: reporters },
      suite,
    );
    reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
    reporter.onTestEnd(test, fakeResult({ status: 'passed', workerIndex: 0 }));
    report?.();
    await reporter.onEnd({ status: 'passed' } as any);
    return uploadBody;
  }

  function writeReport(folder: string, writtenAt?: Date): void {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.html'), '<html>report</html>');
    if (writtenAt) fs.utimesSync(path.join(folder, 'index.html'), writtenAt, writtenAt);
  }

  /** Run `fn` from `dir`, as a run started there. */
  async function fromDir<T>(fn: () => Promise<T>): Promise<T> {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      return await fn();
    } finally {
      process.chdir(cwd);
    }
  }

  it("uploads the report the html reporter wrote to its outputFolder, read from the config's folder", async () => {
    const body = await runWithReporters([['html', { outputFolder: 'html-out' }], ['@piwitests/reporter']], () =>
      writeReport(path.join(dir, 'html-out')),
    );
    expect(body).toContain('name="report_html"');
  });

  it("never uploads a report an earlier run left in the html reporter's folder", async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    writeReport(path.join(dir, 'playwright-report'), new Date(Date.now() - 60 * 60 * 1000));
    const body = await fromDir(() => runWithReporters([['html'], ['@piwitests/reporter']]));
    expect(body).not.toContain('name="report_html"');
  });

  it('uploads no HTML report for a run without an html reporter, whatever playwright-report holds', async () => {
    const body = await fromDir(() =>
      runWithReporters([['list'], ['@piwitests/reporter']], () => writeReport(path.join(dir, 'playwright-report'))),
    );
    expect(body).not.toContain('name="report_html"');
  });
});
