import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { Uploader, type RunPayload } from '../src/internal/submit/uploader.js';
import { FileHandler } from '../src/internal/files/file-handler.js';
import { HttpClient } from '../src/internal/transport/http-client.js';
import { Logger } from '../src/internal/support/logger.js';
import type { CollectedTestCase } from '../src/types.js';

interface RecordedReq {
  method: string;
  url: string;
  body: string;
}

function startServer(
  handler: (req: RecordedReq, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string; requests: RecordedReq[] }> {
  const requests: RecordedReq[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rec: RecordedReq = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(rec);
      handler(rec, res);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no addr'));
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, requests });
    });
  });
}

function jsonRes(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function makePayload(testCases: CollectedTestCase[] = []): RunPayload {
  return {
    projectName: 'proj',
    status: 'passed',
    startTime: '2024-01-01T00:00:00.000Z',
    duration: 1000,
    totalTests: testCases.length,
    passedTests: testCases.length,
    failedTests: 0,
    skippedTests: 0,
    metadata: {},
    instanceId: 'inst-1',
    testCases,
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-uploader-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Uploader.uploadJSON', () => {
  it('POSTs the serialized run (with test cases) to /api/test-runs/submit', async () => {
    const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, { runId: 7, projectId: 3 }));
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      const payload = makePayload([{ type: 'complete', title: 't', location: 'l', status: 'passed' } as any]);
      const response = await uploader.uploadJSON(payload, null);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('/api/test-runs/submit');
      const body = JSON.parse(requests[0]!.body);
      expect(body.projectName).toBe('proj');
      expect(body.testCases).toHaveLength(1);
      expect(response).toEqual({ runId: 7, projectId: 3 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('a delivery the answer names no run for', () => {
  it('fails, on /submit and on /upload alike', async () => {
    const { server, url } = await startServer((_req, res) => jsonRes(res, 200, { ok: true }));
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      await expect(uploader.uploadJSON(makePayload(), null)).rejects.toThrow(
        'The answer to /api/test-runs/submit names no run',
      );
      await expect(uploader.uploadWithFiles(makePayload(), [], false, null)).rejects.toThrow(
        'The answer to /api/test-runs/upload names no run',
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Uploader.uploadWithFiles', () => {
  it('assembles a multipart form with the run body, a report, an attachment, and a trace', async () => {
    // A custom report directory (findReportDirectory checks the literal path directly).
    const reportDir = path.join(tmpDir, 'custom-report');
    fs.mkdirSync(reportDir);
    fs.writeFileSync(path.join(reportDir, 'index.html'), '<html>report</html>');

    const traceFile = path.join(tmpDir, 'trace.zip');
    fs.writeFileSync(traceFile, 'TRACE-BYTES');
    const screenshotFile = path.join(tmpDir, 'shot.png');
    fs.writeFileSync(screenshotFile, 'PNG-BYTES');

    const { server, url, requests } = await startServer((_req, res) =>
      jsonRes(res, 200, { runId: 1, projectId: 2, reports: [{ label: 'custom', path: 'x' }] }),
    );
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      const testCase: CollectedTestCase = {
        type: 'complete',
        title: 't',
        location: 'l',
        status: 'passed',
        attachments: [
          { name: 'trace', path: traceFile },
          { name: 'screenshot', path: screenshotFile, contentType: 'image/png' },
        ],
      } as any;

      await uploader.uploadWithFiles(
        makePayload([testCase]),
        uploader.findReports({ uploadReport: false, reports: [{ type: 'custom', dir: reportDir }] }),
        true,
        null,
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('/api/test-runs/upload');
      const body = requests[0]!.body;
      expect(body).toContain('name="projectName"');
      expect(body).toContain('name="testRun"');
      expect(body).toContain('name="testCases"');
      expect(body).toContain('name="report_custom"');
      expect(body).toContain('name="attach_meta_0"');
      expect(body).toContain('name="attach_file_0"');
      expect(body).toContain('name="trace_0"');
      expect(body).toContain('TRACE-BYTES');
      expect(body).toContain('PNG-BYTES');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('omits trace fields entirely when uploadTraces is false', async () => {
    const traceFile = path.join(tmpDir, 'trace.zip');
    fs.writeFileSync(traceFile, 'TRACE-BYTES');

    const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, { runId: 1, projectId: 2 }));
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      const testCase: CollectedTestCase = {
        type: 'complete',
        title: 't',
        location: 'l',
        attachments: [{ name: 'trace', path: traceFile }],
      } as any;

      await uploader.uploadWithFiles(makePayload([testCase]), [], false, null);

      expect(requests[0]!.body).not.toContain('name="trace_0"');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Uploader.findReports', () => {
  it("finds a report larger than an attachment may be, for the dashboard's upload limit to decide", () => {
    const reportDir = path.join(tmpDir, 'big-report');
    fs.mkdirSync(reportDir);
    fs.writeFileSync(path.join(reportDir, 'index.html'), 'x'.repeat(16));
    const uploader = new Uploader(
      new HttpClient('http://127.0.0.1:1', new Logger(false)),
      new FileHandler(new Logger(false), 8),
    );

    const found = uploader.findReports({ reports: [{ type: 'custom', dir: reportDir }] });
    expect(found.map((report) => [report.type, report.dir])).toEqual([['custom', reportDir]]);
  });
});

describe('Uploader.uploadReportsForStreamingRun', () => {
  it('POSTs a placeholder run body with the given runId to /api/test-runs/upload', async () => {
    const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, {}));
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      await uploader.uploadReportsForStreamingRun('proj', 42, [], '2024-01-01T00:00:00.000Z', null);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('/api/test-runs/upload');
      expect(requests[0]!.body).toContain('name="runId"');
      expect(requests[0]!.body).toContain('42');
      expect(requests[0]!.body).toContain('already-submitted');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Uploader.uploadCaseFiles', () => {
  function makeCase(traceFile: string): CollectedTestCase {
    return { type: 'complete', title: 't', location: 'l', attachments: [{ name: 'trace', path: traceFile }] } as any;
  }

  it('returns false without any HTTP call when there is nothing to upload', async () => {
    const uploader = new Uploader(
      new HttpClient('http://127.0.0.1:1', new Logger(false)),
      new FileHandler(new Logger(false)),
    );
    const result = await uploader.uploadCaseFiles(
      'proj',
      1,
      'tok',
      { type: 'complete', title: 't', location: 'l' } as any,
      false,
      null,
    );
    expect(result).toBe(false);
  });

  it('skips the trace body when the server already has the blob, and returns true', async () => {
    const traceFile = path.join(tmpDir, 'trace.zip');
    fs.writeFileSync(traceFile, 'TRACE-BYTES');

    const { server, url, requests } = await startServer((req, res) => {
      if (req.url === '/api/traces/check') return jsonRes(res, 200, { missing: [] });
      return jsonRes(res, 200, { ok: true });
    });
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      const result = await uploader.uploadCaseFiles('proj', 5, 'streamtok', makeCase(traceFile), true, null);

      expect(result).toBe(true);
      const caseFilesReq = requests.find((r) => r.url === '/api/test-runs/5/case-files');
      expect(caseFilesReq).toBeDefined();
      expect(caseFilesReq!.body).toContain('trace_hash');
      expect(caseFilesReq!.body).not.toContain('TRACE-BYTES');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('names the execution by its retry and its `--repeat-each` repetition', async () => {
    const traceFile = path.join(tmpDir, 'trace.zip');
    fs.writeFileSync(traceFile, 'TRACE-BYTES');

    const { server, url, requests } = await startServer((req, res) => {
      if (req.url === '/api/traces/check') return jsonRes(res, 200, { missing: [] });
      return jsonRes(res, 200, { ok: true });
    });
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      const repeated = { ...makeCase(traceFile), retries: 1, repeatEachIndex: 2 } as CollectedTestCase;
      await uploader.uploadCaseFiles('proj', 5, 'streamtok', repeated, true, null);

      const body = requests.find((r) => r.url === '/api/test-runs/5/case-files')!.body;
      expect(body).toContain('"retries":1');
      expect(body).toContain('"repeatEachIndex":2');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("names the execution's Playwright project, as the case payload's browser does", async () => {
    const traceFile = path.join(tmpDir, 'trace.zip');
    fs.writeFileSync(traceFile, 'TRACE-BYTES');

    const { server, url, requests } = await startServer((req, res) => {
      if (req.url === '/api/traces/check') return jsonRes(res, 200, { missing: [] });
      return jsonRes(res, 200, { ok: true });
    });
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      const firefox = { ...makeCase(traceFile), browser: { projectName: 'firefox', browserName: 'firefox' } };
      await uploader.uploadCaseFiles('proj', 5, 'streamtok', firefox as CollectedTestCase, true, null);

      const body = requests.find((r) => r.url === '/api/test-runs/5/case-files')!.body;
      expect(body).toContain('"projectName":"firefox"');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('retries with the trace file body on a 422 (server did not actually have the blob)', async () => {
    const traceFile = path.join(tmpDir, 'trace.zip');
    fs.writeFileSync(traceFile, 'TRACE-BYTES');

    let caseFilesAttempts = 0;
    const { server, url, requests } = await startServer((req, res) => {
      if (req.url === '/api/traces/check') return jsonRes(res, 200, { missing: [] });
      caseFilesAttempts++;
      if (caseFilesAttempts === 1) return jsonRes(res, 422, { error: 'blob missing' });
      return jsonRes(res, 200, { ok: true });
    });
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      const result = await uploader.uploadCaseFiles('proj', 9, 'streamtok', makeCase(traceFile), true, null);

      expect(result).toBe(true);
      const caseFilesReqs = requests.filter((r) => r.url === '/api/test-runs/9/case-files');
      expect(caseFilesReqs).toHaveLength(2);
      expect(caseFilesReqs[0]!.body).not.toContain('TRACE-BYTES');
      expect(caseFilesReqs[1]!.body).toContain('TRACE-BYTES');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Uploader.uploadCaseFiles, files too large together', () => {
  it('sends them again in a request each, those of one name together, and leaves out alone one still too large', async () => {
    const file = (name: string, content: string) => {
      const filePath = path.join(tmpDir, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      return filePath;
    };
    const testCase = {
      type: 'complete',
      title: 'records the checkout',
      location: 'l',
      attachments: [
        { name: 'trace', path: file('trace.zip', 'TRACE-BYTES') },
        { name: 'screenshot', path: file('first/screenshot.png', 'FIRST-SHOT'), contentType: 'image/png' },
        { name: 'video', path: file('video.webm', 'HUGE-VIDEO'), contentType: 'video/webm' },
        { name: 'screenshot', path: file('second/screenshot.png', 'SECOND-SHOT'), contentType: 'image/png' },
      ],
    } as any;

    // Over the limit: a request that carries the video.
    const { server, url, requests } = await startServer((req, res) =>
      req.url === '/api/traces/check' || !req.body.includes('HUGE-VIDEO')
        ? jsonRes(res, 200, { success: true })
        : jsonRes(res, 413, { message: 'Upload too large (max 1 MB)' }),
    );
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      const result = await uploader.uploadCaseFiles('proj', 5, 'streamtok', testCase, true, null);

      expect(result).toBe(true);
      const sent = requests.filter((r) => r.url === '/api/test-runs/5/case-files').map((r) => r.body);
      expect(sent).toHaveLength(4);
      // The trace alone, then both screenshots together, then the video alone, which is left out.
      expect(sent[1]).toContain('TRACE-BYTES');
      expect(sent[1]).not.toContain('SHOT');
      expect(sent[2]).toContain('FIRST-SHOT');
      expect(sent[2]).toContain('SECOND-SHOT');
      expect(sent[2]).not.toContain('TRACE-BYTES');
      expect(sent[3]).toContain('HUGE-VIDEO');
      expect(sent[3]).not.toContain('SHOT');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('throws when the one file of a test is too large, for the next test to go', async () => {
    const traceFile = path.join(tmpDir, 'trace.zip');
    fs.writeFileSync(traceFile, 'TRACE-BYTES');
    const { server, url } = await startServer((req, res) =>
      req.url === '/api/traces/check' ? jsonRes(res, 200, {}) : jsonRes(res, 413, { message: 'too large' }),
    );
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      const testCase = {
        type: 'complete',
        title: 't',
        location: 'l',
        attachments: [{ name: 'trace', path: traceFile }],
      };
      await expect(uploader.uploadCaseFiles('proj', 5, 'tok', testCase as any, true, null)).rejects.toMatchObject({
        status: 413,
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Uploader.uploadResults', () => {
  it('sends the run with its results to /api/test-runs/upload/results, and returns the run and its token', async () => {
    const { server, url, requests } = await startServer((_req, res) =>
      jsonRes(res, 200, { success: true, runId: 7, projectId: 3, streamToken: 'held-token' }),
    );
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      const testCase = { type: 'complete', title: 'pays', location: 'l', status: 'passed' } as any;
      const held = await uploader.uploadResults(makePayload([testCase]), null);

      expect(held).toEqual({ runId: 7, projectId: 3, streamToken: 'held-token' });
      expect(requests.map((r) => r.url)).toEqual(['/api/test-runs/upload/results']);
      const body = JSON.parse(requests[0]!.body);
      expect(body.projectName).toBe('proj');
      expect(body.testCases.map((tc: any) => tc.title)).toEqual(['pays']);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('waits for the dashboard to store the results as long as for an upload', async () => {
    const { server, url } = await startServer((_req, res) => {
      setTimeout(() => jsonRes(res, 200, { success: true, runId: 7, projectId: 3, streamToken: 'held-token' }), 300);
    });
    try {
      const client = new HttpClient(url, new Logger(false), 100, 2000);
      const uploader = new Uploader(client, new FileHandler(new Logger(false)));
      expect(await uploader.uploadResults(makePayload(), null)).toMatchObject({ runId: 7 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('returns null from a dashboard that has no such route, or that names no token, and throws any other failure', async () => {
    for (const [status, answer] of [
      [404, { message: 'Page not found' }],
      [405, { message: 'Method not allowed' }],
      [200, { success: true, runId: 7, projectId: 3, duplicate: true }],
    ] as const) {
      const { server, url } = await startServer((_req, res) => jsonRes(res, status, answer));
      try {
        const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
        expect(await uploader.uploadResults(makePayload(), null)).toBeNull();
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }

    // A refusal as too large is no missing route: an upload carrying the same results with the files would go no better.
    for (const status of [401, 413, 503]) {
      const { server, url } = await startServer((_req, res) => jsonRes(res, status, { message: 'refused' }));
      try {
        const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
        await expect(uploader.uploadResults(makePayload(), null)).rejects.toMatchObject({ status });
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }
  });
});

describe('Uploader.uploadReportsAndSettle', () => {
  function report(type: string, content: string) {
    const dir = path.join(tmpDir, `${type}-report`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), content);
    return { type, dir, files: new FileHandler(new Logger(false)).listReport(dir)! };
  }

  it('uploads each report in a request of its own, leaving out alone one refused as too large', async () => {
    const { server, url, requests } = await startServer((req, res) =>
      req.body.includes('name="report_html"')
        ? jsonRes(res, 413, { message: 'Upload too large (max 1 MB)' })
        : jsonRes(res, 200, { success: true, runId: 42 }),
    );
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      await uploader.uploadReportsAndSettle('proj', 42, [report('html', 'big'), report('custom', 'small')], null, null);

      expect(requests.map((r) => r.body.includes('name="report_html"'))).toEqual([true, false]);
      expect(requests[1]!.body).toContain('name="report_custom"');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('settles the run with an upload that carries no report when none went through', async () => {
    const { server, url, requests } = await startServer((req, res) =>
      req.body.includes('name="report_')
        ? jsonRes(res, 413, { message: 'Upload too large (max 1 MB)' })
        : jsonRes(res, 200, { success: true, runId: 42 }),
    );
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      await uploader.uploadReportsAndSettle('proj', 42, [report('html', 'big')], null, null);

      expect(requests).toHaveLength(2);
      expect(requests[1]!.body).toContain('already-submitted');
      expect(requests[1]!.body).not.toContain('name="report_');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
