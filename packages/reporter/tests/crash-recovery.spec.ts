import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CrashRecovery, recoveryFilePath } from '../src/internal/streaming/crash-recovery.js';
import { HttpClient } from '../src/internal/transport/http-client.js';
import { Logger } from '../src/internal/support/logger.js';
import { jsonRes, startServer, textRes, type FakeServer } from './_helpers.js';

const projectName = 'piwi-recovery-' + process.pid;
const logger = new Logger(false);

describe('the crash-recovery file', () => {
  let server: FakeServer | null = null;
  const files: string[] = [];

  /** A recovery handler for `serverUrl`, whose file the test removes afterwards. */
  function recoveryFor(serverUrl: string): CrashRecovery {
    files.push(recoveryFilePath(serverUrl, projectName));
    return new CrashRecovery(serverUrl, projectName, logger);
  }

  afterEach(async () => {
    await server?.close();
    server = null;
    for (const file of files.splice(0)) fs.rmSync(file, { force: true });
  });

  it('is kept per dashboard and project, readable by its owner only', () => {
    const a = recoveryFor('http://a.example:3000');
    const b = recoveryFor('http://b.example:3000');
    expect(recoveryFilePath('http://a.example:3000', projectName)).not.toBe(
      recoveryFilePath('http://b.example:3000', projectName),
    );
    expect(recoveryFilePath('http://a.example:3000/', projectName)).toBe(
      recoveryFilePath('http://a.example:3000', projectName),
    );

    a.save({ projectName, testCases: [] });
    expect(a.load()).toEqual({ projectName, testCases: [] });
    expect(b.load()).toBeNull();
    if (process.platform !== 'win32') {
      expect(fs.statSync(recoveryFilePath('http://a.example:3000', projectName)).mode & 0o777).toBe(0o600);
    }
  });

  it('is never read for a dashboard it does not name, nor through a symbolic link', () => {
    const recovery = recoveryFor('http://a.example:3000');
    const file = recoveryFilePath('http://a.example:3000', projectName);
    fs.writeFileSync(file, JSON.stringify({ v: 1, serverUrl: 'http://other.example', payload: { projectName } }));
    expect(recovery.load()).toBeNull();

    fs.rmSync(file);
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-recovery-link-')), 'run.json');
    fs.writeFileSync(target, JSON.stringify({ v: 1, serverUrl: 'http://a.example:3000', payload: { projectName } }));
    try {
      fs.symlinkSync(target, file);
    } catch {
      return; // creating a link needs a privilege some systems do not grant
    }
    expect(recovery.load()).toBeNull();
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
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
    expect(recovery.load()).not.toBeNull();

    await recovery.tryUpload(new HttpClient(server.url, logger));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].instanceId).toBeUndefined();
    expect(bodies[0].metadata.ingestHealth).toEqual({ submitFallback: { path: 'recovery' } });
    expect(recovery.load()).toBeNull();
  });

  it('is kept when the replay fails, and deleted when the dashboard refuses the run itself', async () => {
    let status = 503;
    server = await startServer((_req, res) => textRes(res, status, 'no'));
    const recovery = recoveryFor(server.url);
    recovery.save({ projectName, testCases: [] });

    await recovery.tryUpload(new HttpClient(server.url, logger));
    expect(recovery.load()).not.toBeNull();

    status = 400;
    await recovery.tryUpload(new HttpClient(server.url, logger));
    expect(recovery.load()).toBeNull();
  });
});
