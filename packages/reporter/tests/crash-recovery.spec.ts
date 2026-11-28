import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CrashRecovery, recoveryFiles, singleCopyPath } from '../src/internal/streaming/crash-recovery.js';
import { HttpClient } from '../src/internal/transport/http-client.js';
import { Logger } from '../src/internal/support/logger.js';
import { privateTempDir } from '../src/internal/support/private-file.js';
import { StorageQuota } from '../src/internal/submit/storage-quota.js';
import { jsonRes, startServer, stubPlatform, textRes, type FakeServer } from './_helpers.js';

const projectName = 'piwi-recovery-' + process.pid;
const logger = new Logger(false);

/** Set when the file at `file` was written to `secondsAgo` seconds ago. */
function writtenAgo(file: string, secondsAgo: number): void {
  const at = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, at, at);
}

describe('the crash-recovery files', () => {
  let server: FakeServer | null = null;
  const servers: string[] = [];

  /** A recovery handler for `serverUrl`, whose files the test removes afterwards. */
  function recoveryFor(serverUrl: string, limits?: { runs: number; bytes: number }): CrashRecovery {
    servers.push(serverUrl);
    return new CrashRecovery(serverUrl, projectName, logger, limits);
  }

  /** Save `payload` as a run's copy written `secondsAgo` seconds ago: the copies are replayed oldest first. */
  function saveAged(recovery: CrashRecovery, serverUrl: string, payload: Record<string, unknown>, secondsAgo: number) {
    const before = new Set(recoveryFiles(serverUrl, projectName));
    expect(recovery.save(payload)).toBe(true);
    const saved = recoveryFiles(serverUrl, projectName).find((file) => !before.has(file))!;
    writtenAgo(saved, secondsAgo);
    return saved;
  }

  afterEach(async () => {
    await server?.close();
    server = null;
    // Every file of the dashboard and project, those the listing leaves out as untrusted included.
    for (const serverUrl of servers.splice(0)) {
      const stem = path.basename(singleCopyPath(serverUrl, projectName), '.json');
      for (const name of fs.readdirSync(privateTempDir())) {
        if (name.startsWith(stem)) fs.rmSync(path.join(privateTempDir(), name), { force: true });
      }
    }
  });

  it('keeps one file a run, named by its delivery key, per dashboard and project, readable by its owner only', () => {
    const a = recoveryFor('http://a.example:3000');
    const b = recoveryFor('http://b.example:3000');

    const first = saveAged(a, 'http://a.example:3000', { projectName, deliveryKey: 'run-1', testCases: [] }, 2);
    saveAged(a, 'http://a.example:3000', { projectName, deliveryKey: 'run-2', testCases: [] }, 1);
    b.save({ projectName, deliveryKey: 'run-3', testCases: [] });

    expect(path.basename(first)).toMatch(/^piwi-dashboard-recovery-[0-9a-f]{16}-run-1\.json$/);
    expect(a.load().map((payload) => payload.deliveryKey)).toEqual(['run-1', 'run-2']);
    expect(b.load().map((payload) => payload.deliveryKey)).toEqual(['run-3']);
    expect(recoveryFiles('http://a.example:3000/', projectName)).toEqual(
      recoveryFiles('http://a.example:3000', projectName),
    );
    if (process.platform !== 'win32') expect(fs.statSync(first).mode & 0o777).toBe(0o600);
  });

  it('keeps a file for each of two runs of one project on one machine, however close together they save', () => {
    const one = recoveryFor('http://a.example:3000');
    const other = new CrashRecovery('http://a.example:3000', projectName, logger);

    one.save({ projectName, deliveryKey: 'one', testCases: [] });
    other.save({ projectName, deliveryKey: 'other', testCases: [] });
    // A copy that names no delivery key gets a name of its own too.
    one.save({ projectName, testCases: [] });
    other.save({ projectName, testCases: [] });

    expect(recoveryFiles('http://a.example:3000', projectName)).toHaveLength(4);
    expect(new Set(one.load().map((payload) => payload.deliveryKey))).toEqual(new Set(['one', 'other', undefined]));
  });

  it('is never read for a dashboard it does not name, nor through a symbolic link', () => {
    const recovery = recoveryFor('http://a.example:3000');
    const named = singleCopyPath('http://a.example:3000', projectName).replace(/\.json$/, '-elsewhere.json');
    fs.writeFileSync(named, JSON.stringify({ v: 1, serverUrl: 'http://other.example', payload: { projectName } }), {
      mode: 0o600,
    });
    expect(recovery.load()).toEqual([]);

    fs.rmSync(named);
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-recovery-link-')), 'run.json');
    fs.writeFileSync(target, JSON.stringify({ v: 1, serverUrl: 'http://a.example:3000', payload: { projectName } }));
    try {
      fs.symlinkSync(target, named);
    } catch {
      return; // creating a link needs a privilege some systems do not grant
    }
    expect(recovery.load()).toEqual([]);
    expect(recoveryFiles('http://a.example:3000', projectName)).toEqual([]);
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('is never read when other users may write to it', () => {
    const recovery = recoveryFor('http://a.example:3000');
    recovery.save({ projectName, testCases: [] });
    fs.chmodSync(recoveryFiles('http://a.example:3000', projectName)[0]!, 0o666);
    expect(recovery.load()).toEqual([]);
  });

  it('keeps at most the runs of its limits, dropping the oldest first and saying how many', () => {
    const url = 'http://a.example:3000';
    const roomy = recoveryFor(url, { runs: 10, bytes: 1024 * 1024 });
    for (const [index, label] of ['a', 'b', 'c', 'd'].entries()) {
      saveAged(roomy, url, { projectName, deliveryKey: label, testCases: [] }, 10 - index);
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      recoveryFor(url, { runs: 2, bytes: 1024 * 1024 }).save({ projectName, deliveryKey: 'e', testCases: [] });
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        '[Piwi Dashboard] Dropped the saved results of 3 earlier runs, the oldest, that the dashboard never got: this machine keeps at most 2 runs and 1 MB of them for this dashboard and project.',
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(roomy.load().map((payload) => payload.deliveryKey)).toEqual(['d', 'e']);
  });

  it('keeps at most the bytes of its limits, the newest copy even alone past them', () => {
    const url = 'http://b.example:3000';
    const roomy = recoveryFor(url, { runs: 10, bytes: 1024 * 1024 });
    const padded = (label: string) => ({ projectName, deliveryKey: label, padding: 'x'.repeat(1000) });
    saveAged(roomy, url, padded('f'), 3);
    saveAged(roomy, url, padded('g'), 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      recoveryFor(url, { runs: 10, bytes: 2500 }).save(padded('h'));
      expect(roomy.load().map((payload) => payload.deliveryKey)).toEqual(['g', 'h']);
      recoveryFor(url, { runs: 10, bytes: 1024 }).save(padded('i'));
      expect(roomy.load().map((payload) => payload.deliveryKey)).toEqual(['i']);
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        '[Piwi Dashboard] Dropped the saved results of 1 earlier run, the oldest, that the dashboard never got: this machine keeps at most 10 runs and 2 KB of them for this dashboard and project.',
        '[Piwi Dashboard] Dropped the saved results of 2 earlier runs, the oldest, that the dashboard never got: this machine keeps at most 10 runs and 1 KB of them for this dashboard and project.',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('is replayed to its own dashboard only, and deleted once the dashboard took the run', async () => {
    const bodies: any[] = [];
    server = await startServer((req, res) => {
      bodies.push(JSON.parse(req.body));
      jsonRes(res, 200, { runId: 1 });
    });
    const recovery = recoveryFor(server.url);
    recovery.save({ projectName, instanceId: 'abc', testCases: [] });

    await recovery.tryUpload(new HttpClient('http://127.0.0.1:1', logger));
    expect(bodies).toEqual([]);
    expect(recovery.load()).toHaveLength(1);

    await recovery.tryUpload(new HttpClient(server.url, logger));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].instanceId).toBeUndefined();
    expect(bodies[0].metadata.ingestHealth).toEqual({ submitFallback: { path: 'recovery' } });
    expect(recovery.load()).toEqual([]);
  });

  it('replays every run oldest first, one at a time, going on past a run the dashboard refuses for good', async () => {
    let inFlight = 0;
    let most = 0;
    const labels: string[] = [];
    server = await startServer((req, res) => {
      const { label } = JSON.parse(req.body);
      labels.push(label);
      most = Math.max(most, ++inFlight);
      setTimeout(() => {
        inFlight--;
        if (label === 'refused') jsonRes(res, 400, { message: 'Invalid body' });
        else jsonRes(res, 200, { runId: labels.length });
      }, 20);
    });
    const recovery = recoveryFor(server.url);
    saveAged(recovery, server.url, { projectName, deliveryKey: 'k3', label: 'newest', testCases: [] }, 1);
    saveAged(recovery, server.url, { projectName, deliveryKey: 'k1', label: 'oldest', testCases: [] }, 30);
    saveAged(recovery, server.url, { projectName, deliveryKey: 'k2', label: 'refused', testCases: [] }, 20);

    await recovery.tryUpload(new HttpClient(server.url, logger));

    expect(labels).toEqual(['oldest', 'refused', 'newest']);
    expect(most).toBe(1);
    expect(recovery.load()).toEqual([]);
  });

  for (const { why, answer } of [
    { why: 'read-only', answer: { status: 409, errorCode: 'READ_ONLY' } },
    { why: 'refused for the storage quota', answer: { status: 409, errorCode: 'STORAGE_QUOTA_EXCEEDED' } },
    { why: 'not answering', answer: { status: 503, errorCode: null } },
  ]) {
    it(`stops at the first run the dashboard ${why} does not take, keeping it and the runs after it`, async () => {
      server = await startServer((req, res) => {
        if (JSON.parse(req.body).label === 'taken') return jsonRes(res, 200, { runId: 1 });
        jsonRes(res, answer.status, {
          message: 'No.',
          ...(answer.errorCode && { data: { errorCode: answer.errorCode } }),
        });
      });
      const recovery = recoveryFor(server.url);
      saveAged(recovery, server.url, { projectName, deliveryKey: 'k1', label: 'taken', testCases: [] }, 30);
      saveAged(recovery, server.url, { projectName, deliveryKey: 'k2', label: 'stopped', testCases: [] }, 20);
      saveAged(recovery, server.url, { projectName, deliveryKey: 'k3', label: 'kept', testCases: [] }, 10);
      const info = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await recovery.tryUpload(new HttpClient(server.url, logger), null, new StorageQuota(logger));
      } finally {
        info.mockRestore();
        warn.mockRestore();
      }

      expect(server.requests.map((request) => JSON.parse(request.body).label)).toEqual(['taken', 'stopped']);
      expect(recovery.load().map((payload) => payload.label)).toEqual(['stopped', 'kept']);
    });
  }

  it('replays the single file an older reporter kept, as the oldest, with the copies of later runs', async () => {
    const labels: string[] = [];
    server = await startServer((req, res) => {
      labels.push(JSON.parse(req.body).label);
      jsonRes(res, 200, { runId: labels.length });
    });
    const recovery = recoveryFor(server.url);
    recovery.save({ projectName, deliveryKey: 'k1', label: 'later', testCases: [] });
    const single = singleCopyPath(server.url, projectName);
    fs.writeFileSync(
      single,
      JSON.stringify({ v: 1, serverUrl: server.url, payload: { projectName, label: 'single', testCases: [] } }),
      { mode: 0o600 },
    );
    writtenAgo(single, 3600);

    await recovery.tryUpload(new HttpClient(server.url, logger));

    expect(labels).toEqual(['single', 'later']);
    expect(fs.existsSync(single)).toBe(false);
    expect(recovery.load()).toEqual([]);
  });

  it('keeps the counts of the files the copy left out, beside the mark of its delivery from recovery', async () => {
    const bodies: any[] = [];
    server = await startServer((req, res) => {
      bodies.push(JSON.parse(req.body));
      jsonRes(res, 200, { runId: 1 });
    });
    const recovery = recoveryFor(server.url);
    const ingestHealth = {
      tracesNotKept: 1,
      attachmentsNotKept: 2,
      reportsNotKept: 1,
      submitFallback: { path: 'submit', reason: 'finish-failed' },
    };
    recovery.save({ projectName, metadata: { branch: 'main', ingestHealth }, testCases: [] });

    await recovery.tryUpload(new HttpClient(server.url, logger));

    expect(bodies).toHaveLength(1);
    expect(bodies[0].metadata).toEqual({
      branch: 'main',
      ingestHealth: {
        tracesNotKept: 1,
        attachmentsNotKept: 2,
        reportsNotKept: 1,
        submitFallback: { path: 'recovery' },
      },
    });
  });

  it("is kept when the answer is not the dashboard's: a sign-in page, or JSON that names no run", async () => {
    let signInPage = true;
    server = await startServer((_req, res) => {
      if (!signInPage) return jsonRes(res, 200, {});
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Sign in</title>');
    });
    const recovery = recoveryFor(server.url);
    recovery.save({ projectName, testCases: [] });

    await recovery.tryUpload(new HttpClient(server.url, logger));
    expect(recovery.load()).toHaveLength(1);

    signInPage = false;
    await recovery.tryUpload(new HttpClient(server.url, logger));
    expect(recovery.load()).toHaveLength(1);
  });

  it("is kept when the dashboard's storage quota refuses it, which refuses the run of this process too", async () => {
    server = await startServer((_req, res) =>
      jsonRes(res, 409, { statusCode: 409, message: 'Refused.', data: { errorCode: 'STORAGE_QUOTA_EXCEEDED' } }),
    );
    const recovery = recoveryFor(server.url);
    recovery.save({ projectName, testCases: [] });
    const quota = new StorageQuota(logger);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await recovery.tryUpload(new HttpClient(server.url, logger), null, quota);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenLastCalledWith(
        '[Piwi Dashboard] The dashboard refused the saved test data for its storage quota: it stays on this machine for a later run.',
      );
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
    expect(recovery.load()).toHaveLength(1);
    expect(quota.refusesRun).toBe(true);
  });

  it('is kept when the dashboard is read-only, and not sent again while it stays so', async () => {
    server = await startServer((_req, res) =>
      jsonRes(res, 409, { statusCode: 409, message: 'Read-only.', data: { errorCode: 'READ_ONLY' } }),
    );
    const recovery = recoveryFor(server.url);
    recovery.save({ projectName, testCases: [] });
    const client = new HttpClient(server.url, logger);
    const quota = new StorageQuota(logger);
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await recovery.tryUpload(client, null, quota);
      await recovery.tryUpload(client, null, quota);
      expect(info).toHaveBeenLastCalledWith(
        '[Piwi Dashboard] The dashboard is read-only: the saved test data of earlier runs is not sent, and stays on this machine for a later run.',
      );
    } finally {
      info.mockRestore();
    }
    expect(server.requests.map((r) => r.url)).toEqual(['/api/test-runs/submit']);
    expect(recovery.load()).toEqual([{ projectName, testCases: [] }]);
    expect(client.readOnly).toBe(true);
    expect(quota.refusesRun).toBe(false);
  });

  it('is kept when the replay fails, and deleted when the dashboard refuses the run itself', async () => {
    let status = 503;
    server = await startServer((_req, res) => textRes(res, status, 'no'));
    const recovery = recoveryFor(server.url);
    recovery.save({ projectName, testCases: [] });

    await recovery.tryUpload(new HttpClient(server.url, logger));
    expect(recovery.load()).toHaveLength(1);

    status = 400;
    await recovery.tryUpload(new HttpClient(server.url, logger));
    expect(recovery.load()).toEqual([]);
  });
});

describe("an older reporter's recovery file on Windows", () => {
  let server: FakeServer | null = null;
  let bodies: any[];
  let status: number;
  /** This user's local application data folder, and the shared temp folder an older reporter wrote to. */
  let local: string;
  let shared: string;
  let realPlatform: () => void;

  beforeEach(async () => {
    local = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-recovery-local-'));
    shared = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-recovery-shared-'));
    bodies = [];
    status = 200;
    server = await startServer((req, res) => {
      if (status !== 200) return textRes(res, status, 'no');
      bodies.push(JSON.parse(req.body));
      jsonRes(res, 200, { runId: bodies.length });
    });
    realPlatform = stubPlatform('win32');
    vi.stubEnv('LOCALAPPDATA', local);
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, shared);
  });

  afterEach(async () => {
    realPlatform();
    vi.unstubAllEnvs();
    await server?.close();
    server = null;
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(shared, { recursive: true, force: true });
  });

  /** Leave a recovery file in the shared temp folder, as an older reporter did. */
  function leaveLegacyFile(payload: Record<string, unknown>): string {
    const file = singleCopyPath(server!.url, projectName, shared);
    fs.writeFileSync(file, JSON.stringify({ v: 1, serverUrl: server!.url, payload }), { mode: 0o600 });
    return file;
  }

  it('is replayed once, then deleted from the shared temp folder', async () => {
    const legacy = leaveLegacyFile({ projectName, testCases: [], label: 'left' });
    const recovery = new CrashRecovery(server!.url, projectName, logger);

    await recovery.tryUpload(new HttpClient(server!.url, logger));
    await recovery.tryUpload(new HttpClient(server!.url, logger));

    expect(bodies.map((body) => body.label)).toEqual(['left']);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(singleCopyPath(server!.url, projectName))).toBe(false);
  });

  it('moves into the private folder when the replay fails, and is replayed from there', async () => {
    const legacy = leaveLegacyFile({ projectName, testCases: [], label: 'left' });
    const recovery = new CrashRecovery(server!.url, projectName, logger);

    status = 503;
    await recovery.tryUpload(new HttpClient(server!.url, logger));
    expect(fs.existsSync(legacy)).toBe(false);
    expect(path.dirname(singleCopyPath(server!.url, projectName))).toBe(path.join(local, 'piwi', 'tmp'));
    expect(recovery.load()).toEqual([expect.objectContaining({ label: 'left' })]);

    status = 200;
    await recovery.tryUpload(new HttpClient(server!.url, logger));
    expect(bodies.map((body) => body.label)).toEqual(['left']);
    expect(recovery.load()).toEqual([]);
  });

  it('is replayed first, as the oldest, with the copies of later runs', async () => {
    const legacy = leaveLegacyFile({ projectName, testCases: [], label: 'left' });
    const recovery = new CrashRecovery(server!.url, projectName, logger);
    recovery.save({ projectName, testCases: [], label: 'own' });

    await recovery.tryUpload(new HttpClient(server!.url, logger));

    expect(bodies.map((body) => body.label)).toEqual(['left', 'own']);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(recovery.load()).toEqual([]);
  });

  it('waits for the next run while the private folder holds a single file of its own', async () => {
    const legacy = leaveLegacyFile({ projectName, testCases: [], label: 'left' });
    const recovery = new CrashRecovery(server!.url, projectName, logger);
    const own = { v: 1, serverUrl: server!.url, payload: { projectName, testCases: [], label: 'own' } };
    fs.writeFileSync(singleCopyPath(server!.url, projectName), JSON.stringify(own), { mode: 0o600 });

    await recovery.tryUpload(new HttpClient(server!.url, logger));
    expect(fs.existsSync(legacy)).toBe(true);
    await recovery.tryUpload(new HttpClient(server!.url, logger));
    await recovery.tryUpload(new HttpClient(server!.url, logger));

    expect(bodies.map((body) => body.label)).toEqual(['own', 'left']);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('stays where it is when it names another dashboard or is a symbolic link', async () => {
    const legacy = singleCopyPath(server!.url, projectName, shared);
    const elsewhere = JSON.stringify({ v: 1, serverUrl: 'http://other.example', payload: { projectName } });
    fs.writeFileSync(legacy, elsewhere, { mode: 0o600 });
    const recovery = new CrashRecovery(server!.url, projectName, logger);
    await recovery.tryUpload(new HttpClient(server!.url, logger));
    expect(fs.readFileSync(legacy, 'utf8')).toBe(elsewhere);

    fs.rmSync(legacy);
    const target = path.join(local, 'run.json');
    fs.writeFileSync(target, JSON.stringify({ v: 1, serverUrl: server!.url, payload: { projectName } }));
    try {
      fs.symlinkSync(target, legacy);
    } catch {
      return; // creating a link needs a privilege some systems do not grant
    }
    await recovery.tryUpload(new HttpClient(server!.url, logger));
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(bodies).toEqual([]);
  });
});
