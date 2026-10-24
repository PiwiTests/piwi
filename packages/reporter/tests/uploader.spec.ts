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
        { uploadTraces: true, uploadReport: false, reports: [{ type: 'custom', dir: reportDir }] },
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

      await uploader.uploadWithFiles(makePayload([testCase]), { uploadTraces: false, uploadReport: false }, null);

      expect(requests[0]!.body).not.toContain('name="trace_0"');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Uploader.uploadReportsForStreamingRun', () => {
  it('POSTs a placeholder run body with the given runId to /api/test-runs/upload', async () => {
    const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, {}));
    try {
      const uploader = new Uploader(new HttpClient(url, new Logger(false)), new FileHandler(new Logger(false)));
      await uploader.uploadReportsForStreamingRun('proj', 42, {}, '2024-01-01T00:00:00.000Z', null);

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
