import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import {
  applyOptionsToEnv,
  requestedRunProblem,
  requestedRunTarget,
  resolveOptions,
  usedDesktopDiscovery,
} from '../src/internal/config/env.js';
import { readRequestedRun } from '../src/internal/config/requested-run.js';
import { wrapConfig } from '../src/public/config-wrapper.js';
import { StreamManager } from '../src/internal/streaming/stream-manager.js';
import { StreamBuffer } from '../src/internal/streaming/stream-buffer.js';
import { CrashRecovery } from '../src/internal/streaming/crash-recovery.js';
import { FileHandler } from '../src/internal/files/file-handler.js';
import { RunSubmitter, type CollectedRun } from '../src/internal/submit/run-submitter.js';
import { Uploader, uploadCaseFilesInTurn } from '../src/internal/submit/uploader.js';
import { HttpClient, HttpError } from '../src/internal/transport/http-client.js';
import { getSetupFilePath, writeSetupInfo } from '../src/internal/support/setup-file.js';
import { Logger } from '../src/internal/support/logger.js';
import type { CollectedTestCase } from '../src/types/collected.js';
import type { PiwiDashboardOptions } from '../src/public/options.js';
import { jsonRes, startServer, textRes, urlsHit, type FakeServer } from './_helpers.js';

const TOKEN = `pdq_${'c'.repeat(64)}`;
const INSTANCE = 'https://piwi.example.com';
const TOUCHED_ENV = [
  'PIWI_REQUEST_TOKEN_FILE',
  'PIWI_REQUEST_INSTANCE',
  'PIWI_DESKTOP_CONFIG',
  'PIWI_DESKTOP_APP',
  'PIWI_DASHBOARD_URL',
  'PIWI_API_KEY',
  'PIWI_USERNAME',
  'PIWI_PASSWORD',
  'PIWI_AI',
  'PIWI_AI_UPDATE',
  'PIWI_CAPTURE_CODE_REACH',
  'PIWI_COVERAGE_BROWSER',
  'PIWI_COVERAGE_SERVER',
  'PIWI_COVERAGE_CSS',
  'PIWI_COLLECT_ENVIRONMENT_INFO',
  'PIWI_DEFAULTED_CAPTURE',
  'CI',
];

let tmpDir: string;
let tokenFile: string;
const savedEnv: Record<string, string | undefined> = {};

/** Write the token file as the target does: this user's alone. */
function writeToken(text: string, mode = 0o600): void {
  fs.writeFileSync(tokenFile, text, { mode });
  fs.chmodSync(tokenFile, mode);
}

describe('a requested run', () => {
  beforeEach(() => {
    for (const key of TOUCHED_ENV) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-request-'));
    tokenFile = path.join(tmpDir, 'request-token');
    process.env.PIWI_DESKTOP_CONFIG = path.join(tmpDir, 'desktop.json');
  });

  afterEach(() => {
    for (const key of TOUCHED_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is none without its variables', () => {
    expect(readRequestedRun({})).toBe(null);
    resolveOptions({ serverUrl: 'http://localhost:7494' });
    expect(requestedRunTarget()).toBe(null);
    expect(requestedRunProblem()).toBe(null);
  });

  it('reads the instance and the token the target wrote, and leaves the file', () => {
    writeToken(`${TOKEN}\n`);
    expect(readRequestedRun({ PIWI_REQUEST_TOKEN_FILE: tokenFile, PIWI_REQUEST_INSTANCE: `${INSTANCE}/` })).toEqual({
      instance: INSTANCE,
      token: TOKEN,
    });
    expect(fs.existsSync(tokenFile)).toBe(true);
  });

  it('keeps the path of an instance served under one', () => {
    writeToken(TOKEN);
    expect(
      readRequestedRun({ PIWI_REQUEST_TOKEN_FILE: tokenFile, PIWI_REQUEST_INSTANCE: `${INSTANCE}/piwi/` }),
    ).toEqual({ instance: `${INSTANCE}/piwi`, token: TOKEN });
  });

  it('refuses one variable alone, an instance that is not http(s), a missing file and a file without a token', () => {
    writeToken('not a token');
    const problem = (env: NodeJS.ProcessEnv) => {
      const read = readRequestedRun(env);
      return read && 'problem' in read ? read.problem : null;
    };
    expect(problem({ PIWI_REQUEST_TOKEN_FILE: tokenFile })).toMatch(/together/);
    expect(problem({ PIWI_REQUEST_TOKEN_FILE: tokenFile, PIWI_REQUEST_INSTANCE: 'file:///etc' })).toMatch(/http/);
    expect(problem({ PIWI_REQUEST_TOKEN_FILE: tokenFile, PIWI_REQUEST_INSTANCE: 'piwi' })).toMatch(/not a URL/);
    expect(problem({ PIWI_REQUEST_TOKEN_FILE: path.join(tmpDir, 'none'), PIWI_REQUEST_INSTANCE: INSTANCE })).toMatch(
      /cannot be read/,
    );
    expect(problem({ PIWI_REQUEST_TOKEN_FILE: tokenFile, PIWI_REQUEST_INSTANCE: INSTANCE })).toMatch(
      /no request token/,
    );
  });

  it.skipIf(process.platform === 'win32')('refuses a token file others may write', () => {
    writeToken(TOKEN, 0o666);
    const read = readRequestedRun({ PIWI_REQUEST_TOKEN_FILE: tokenFile, PIWI_REQUEST_INSTANCE: INSTANCE });
    expect(read && 'problem' in read ? read.problem : null).toMatch(/alone/);
  });

  it.skipIf(process.platform === 'win32')('refuses a token file others may read', () => {
    writeToken(TOKEN, 0o644);
    const read = readRequestedRun({ PIWI_REQUEST_TOKEN_FILE: tokenFile, PIWI_REQUEST_INSTANCE: INSTANCE });
    expect(read && 'problem' in read ? read.problem : null).toMatch(/alone/);
  });

  it('uploads to the instance with the token, over the config, the environment and the desktop app', () => {
    writeToken(TOKEN);
    fs.writeFileSync(
      process.env.PIWI_DESKTOP_CONFIG!,
      JSON.stringify({ url: 'http://127.0.0.1:3000', token: `pd_${'a'.repeat(64)}`, pid: process.pid }),
    );
    process.env.PIWI_REQUEST_TOKEN_FILE = tokenFile;
    process.env.PIWI_REQUEST_INSTANCE = INSTANCE;
    process.env.PIWI_DESKTOP_APP = 'prefer';
    process.env.PIWI_API_KEY = `pd_${'d'.repeat(64)}`;
    const opts = resolveOptions({
      serverUrl: 'https://other.example.com',
      username: 'robin',
      password: 'secret',
      streaming: false,
      enabled: false,
      keep: true,
      coverage: { browser: 'on' },
      ai: { mode: 'resolve' },
    });
    expect(opts.serverUrl).toBe(INSTANCE);
    expect(opts.apiKey).toBe(TOKEN);
    expect(opts.username).toBe(null);
    expect(opts.password).toBe(null);
    expect(opts.desktopApp).toBe('off');
    expect(usedDesktopDiscovery()).toBe(false);
    expect(opts.enabled).toBe(true);
    expect(opts.streaming).toBe(true);
    expect(opts.keep).toBe(false);
    expect(opts.sampleAriaOnPass).toBe(false);
    expect(opts.uploadManifest).toBe(false);
    expect(opts.captureCodeReach).toBe(false);
    expect(opts.coverage).toBe(undefined);
    expect(opts.ai?.mode).toBe('replay');
    expect(opts.collectEnvironmentInfo).toBe(false);
    expect(requestedRunTarget()).toBe(INSTANCE);
  });

  it('gives the workers no AI authoring, capture of reach or coverage, environment, server or credentials', () => {
    process.env.PIWI_REQUEST_TOKEN_FILE = tokenFile;
    process.env.PIWI_REQUEST_INSTANCE = INSTANCE;
    // What `wrapConfig` bridges from the config each worker loads again.
    applyOptionsToEnv({
      serverUrl: 'https://other.example.com',
      apiKey: `pd_${'d'.repeat(64)}`,
      username: 'robin',
      password: 'secret',
      captureCodeReach: true,
      coverage: { browser: 'lines', server: 'lines', css: 'rules' },
      ai: { mode: 'resolve' },
    });
    expect(process.env.PIWI_AI).toBe('replay');
    expect(process.env.PIWI_AI_UPDATE).toBe('false');
    expect(process.env.PIWI_CAPTURE_CODE_REACH).toBe('false');
    expect(process.env.PIWI_COVERAGE_BROWSER).toBe('off');
    expect(process.env.PIWI_COVERAGE_SERVER).toBe('off');
    expect(process.env.PIWI_COVERAGE_CSS).toBe('off');
    expect(process.env.PIWI_COLLECT_ENVIRONMENT_INFO).toBe('false');
    expect(process.env.PIWI_DASHBOARD_URL).toBe(undefined);
    expect(process.env.PIWI_API_KEY).toBe(undefined);
    expect(process.env.PIWI_USERNAME).toBe(undefined);
    expect(process.env.PIWI_PASSWORD).toBe(undefined);
  });

  it('takes the server and credentials a `.env` file gives the workers, with no Piwi options', () => {
    process.env.PIWI_REQUEST_TOKEN_FILE = tokenFile;
    process.env.PIWI_REQUEST_INSTANCE = INSTANCE;
    process.env.PIWI_DASHBOARD_URL = 'https://other.example.com';
    process.env.PIWI_API_KEY = `pd_${'d'.repeat(64)}`;
    wrapConfig({});
    expect(process.env.PIWI_DASHBOARD_URL).toBe(undefined);
    expect(process.env.PIWI_API_KEY).toBe(undefined);
    expect(process.env.PIWI_AI).toBe('replay');
  });

  it('leaves the workers’ environment alone outside a requested run', () => {
    applyOptionsToEnv({ serverUrl: 'https://other.example.com', ai: { mode: 'resolve' } });
    expect(process.env.PIWI_DASHBOARD_URL).toBe('https://other.example.com');
    expect(process.env.PIWI_AI).toBe('resolve');
  });

  it('sends nothing when the token cannot be read, rather than reach another server', () => {
    process.env.PIWI_REQUEST_TOKEN_FILE = path.join(tmpDir, 'none');
    process.env.PIWI_REQUEST_INSTANCE = INSTANCE;
    const opts = resolveOptions({ serverUrl: 'https://other.example.com' });
    expect(opts.enabled).toBe(false);
    expect(requestedRunTarget()).toBe(null);
    expect(requestedRunProblem()).toMatch(/cannot be read/);
  });
});

describe('a requested run talking to the instance that asked for it', () => {
  const projectName = 'piwi-requested-run-' + process.pid;
  let server: FakeServer | null = null;
  let warnings: string[];

  beforeEach(() => {
    for (const key of TOUCHED_ENV) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-request-'));
    tokenFile = path.join(tmpDir, 'request-token');
    process.env.PIWI_DESKTOP_CONFIG = path.join(tmpDir, 'desktop.json');
    writeToken(TOKEN);
    process.env.PIWI_REQUEST_TOKEN_FILE = tokenFile;
    process.env.PIWI_REQUEST_INSTANCE = INSTANCE;
    resolveOptions({ serverUrl: 'https://other.example.com' });
    expect(requestedRunTarget()).toBe(INSTANCE);
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void warnings.push(String(line)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await server.close();
    server = null;
    fs.rmSync(getSetupFilePath(projectName), { force: true });
    for (const key of TOUCHED_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resolveOptions({ serverUrl: 'http://localhost:7494' });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function streamManager(postJSON: (url: string) => Promise<unknown>) {
    const recovery = { tryUpload: vi.fn(async () => {}) };
    const sm = new StreamManager(
      { postJSON, resolveAuth: async () => null } as any,
      new StreamBuffer(projectName),
      recovery as any,
      {} as any,
      new FileHandler(),
      { serverUrl: INSTANCE, projectName, streaming: true } as PiwiDashboardOptions,
    );
    return { sm, recovery };
  }

  it('begins the run its setup registered, sending no saved run of another', async () => {
    writeSetupInfo({ runId: 5, setupToken: 'setup', projectName });
    const asked: string[] = [];
    const { sm, recovery } = streamManager(async (url) => {
      asked.push(url);
      return { runId: 5, streamToken: 'tok' };
    });
    sm.start(new Date().toISOString(), {}, 'instance');
    await sm.startPromise;
    expect(asked).toEqual(['/api/test-runs/5/begin']);
    expect(sm.runId).toBe(5);
    expect(recovery.tryUpload).not.toHaveBeenCalled();
    await sm.drain();
  });

  it('asks for no fresh run once the instance refuses to begin it (409), and says nothing is sent', async () => {
    writeSetupInfo({ runId: 5, setupToken: 'setup', projectName });
    const asked: string[] = [];
    const { sm } = streamManager(async (url) => {
      asked.push(url);
      throw new HttpError(409);
    });
    sm.start(new Date().toISOString(), {}, 'instance');
    await sm.startPromise;
    expect(asked).toEqual(['/api/test-runs/5/begin']);
    expect(sm.enabled).toBe(false);
    expect(warnings.some((line) => line.includes(`could not start on ${INSTANCE}`))).toBe(true);
    await sm.drain();
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

  function submitter(url: string, session: Record<string, unknown>) {
    const logger = new Logger(false);
    const http = new HttpClient(url, logger);
    const recovery = new CrashRecovery(url, projectName, logger);
    const tryUpload = vi.spyOn(recovery, 'tryUpload');
    const save = vi.spyOn(recovery, 'save');
    const sm = {
      startPromise: null,
      drain: async () => {},
      auth: null,
      enabled: true,
      runId: 1,
      token: 'tok',
      lostResults: false,
      runEnded: false,
      uploadRemaining: async () => {},
      discardBuffered: vi.fn(),
      ...session,
    };
    const made = new RunSubmitter(
      http,
      new Uploader(http, new FileHandler(logger), logger),
      recovery,
      sm as any,
      logger,
    );
    return { made, tryUpload, save };
  }

  it('has no batch upload nor saved copy when its stream never opened', async () => {
    server = await startServer((_req, res) => jsonRes(res, 200, { runId: 2 }));
    const { made, tryUpload, save } = submitter(server.url, { enabled: false, runId: null });
    expect(await made.submit(collectedRun(server.url), { status: 'passed' } as any)).toBe(null);
    expect(urlsHit(server)).toEqual([]);
    expect(tryUpload).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(warnings.some((line) => line.includes('did not take it'))).toBe(true);
  });

  it('finishes with what reached the instance when results were lost, never the batch upload', async () => {
    server = await startServer((req, res) =>
      req.url === '/api/test-runs/1/finish' ? jsonRes(res, 200, {}) : textRes(res, 404, 'nope'),
    );
    const { made } = submitter(server.url, { lostResults: true });
    const submitted = await made.submit(collectedRun(server.url), { status: 'passed' } as any);
    expect(urlsHit(server)).toEqual(['/api/test-runs/1/finish']);
    expect(submitted?.runId).toBe(1);
  });

  it('keeps here the files of a test the instance does not know (404), and uploads the next', async () => {
    const logger = new Logger(false);
    const warn = vi.spyOn(logger, 'warn');
    const uploaded: string[] = [];
    const uploader = {
      uploadCaseFiles: vi.fn(async (_p: string, _r: number, _t: string, tc: CollectedTestCase) => {
        if (tc.title === 'unknown') throw new HttpError(404);
        return true;
      }),
    };
    const tests = [{ title: 'unknown' }, { title: 'known' }] as CollectedTestCase[];
    await uploadCaseFilesInTurn(
      uploader as any,
      logger,
      { projectName, runId: 1, streamToken: 'tok', uploadTraces: true, auth: null },
      tests,
      new AbortController().signal,
      { uploaded: (tc) => uploaded.push(tc.title) },
    );
    expect(uploaded).toEqual(['known']);
    expect(warn).not.toHaveBeenCalled();
  });
});
