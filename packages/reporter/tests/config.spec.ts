import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { applyOptionsToEnv, originEnv, resolveOptions } from '../src/internal/config/env.js';

const PIWI_KEYS = [
  'PIWI_DASHBOARD_URL',
  'PIWI_PROJECT_NAME',
  'PIWI_VERBOSE',
  'PIWI_API_KEY',
  'PIWI_USERNAME',
  'PIWI_PASSWORD',
  'PIWI_ENVIRONMENT',
  'PIWI_LABEL',
  'PIWI_RUN_LABEL',
  'PIWI_KEEP',
  'PIWI_STREAMING',
  'PIWI_STREAMING_BATCH_SIZE',
  'PIWI_STREAMING_BATCH_DELAY',
  'PIWI_MAX_STREAM_BUFFER_BYTES',
  'PIWI_SUBMIT_TIMEOUT',
  'PIWI_LIVE_FILE_UPLOADS',
  'PIWI_UPLOAD_TRACES',
  'PIWI_UPLOAD_REPORT',
  'PIWI_OUTPUT_FILE',
  'PIWI_DESKTOP_CONFIG',
  'PIWI_COVERAGE_BROWSER',
  'PIWI_COVERAGE_SERVER',
];

// Point desktop discovery at a path that cannot exist, so these expectations do
// not change on a machine that happens to be running the desktop app.
const NO_DESKTOP_APP = path.join(os.tmpdir(), 'piwi-no-desktop-app', 'desktop.json');

const SAVED_ENV: Record<string, string | undefined> = {};
function saveEnv(): void {
  for (const k of PIWI_KEYS) SAVED_ENV[k] = process.env[k];
}
function deletePiwiEnv(): void {
  for (const k of PIWI_KEYS) delete process.env[k];
}
function restoreEnv(): void {
  for (const k of PIWI_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

describe('resolveOptions', () => {
  beforeEach(() => {
    saveEnv();
    deletePiwiEnv();
    process.env.PIWI_DESKTOP_CONFIG = NO_DESKTOP_APP;
  });
  afterEach(() => restoreEnv());

  it('applies built-in defaults', () => {
    const opts = resolveOptions({});
    expect(opts.projectName).toBe('default-project');
    expect(opts.uploadTraces).toBe(true);
    expect(opts.uploadReport).toBe(true);
    expect(opts.liveFileUploads).toBe(true);
    expect(opts.collectScmInfo).toBe(true);
    expect(opts.collectCiInfo).toBe(true);
    expect(opts.collectPerformanceMetrics).toBe(true);
    expect(opts.streaming).toBe(true);
    expect(opts.streamingBatchSize).toBe(20);
    expect(opts.streamingBatchDelay).toBe(2000);
    expect(opts.maxStreamBufferBytes).toBe(100 * 1024 * 1024);
    expect(opts.submitTimeout).toBe(15 * 60 * 1000);
    expect(opts.verbose).toBe(false);
    expect(opts.apiKey).toBe(null);
    expect(opts.username).toBe(null);
    expect(opts.password).toBe(null);
  });

  it('user options override defaults', () => {
    const opts = resolveOptions({ projectName: 'mine', streaming: false, streamingBatchSize: 10 });
    expect(opts.projectName).toBe('mine');
    expect(opts.streaming).toBe(false);
    expect(opts.streamingBatchSize).toBe(10);
  });

  it('reads PIWI_DASHBOARD_URL when serverUrl not provided', () => {
    process.env.PIWI_DASHBOARD_URL = 'http://env-host:3000';
    const opts = resolveOptions({});
    expect(opts.serverUrl).toBe('http://env-host:3000');
  });

  it('user serverUrl wins over env', () => {
    process.env.PIWI_DASHBOARD_URL = 'http://env-host:3000';
    const opts = resolveOptions({ serverUrl: 'http://explicit:3000' });
    expect(opts.serverUrl).toBe('http://explicit:3000');
  });

  it('PIWI_PROJECT_NAME now overrides the built-in default (Phase-4 env fix)', () => {
    // Pre-Phase-4 the default 'default-project' masked this env var; the
    // centralized env map applies env to `raw` before the DEFAULTS merge, so
    // the env var now wins when the caller didn't provide projectName.
    process.env.PIWI_PROJECT_NAME = 'env-project';
    const opts = resolveOptions({});
    expect(opts.projectName).toBe('env-project');
  });

  it('user projectName still wins over env and default', () => {
    process.env.PIWI_PROJECT_NAME = 'env-project';
    const opts = resolveOptions({ projectName: 'explicit' });
    expect(opts.projectName).toBe('explicit');
  });

  it('reads PIWI_API_KEY / USERNAME / PASSWORD from env', () => {
    process.env.PIWI_API_KEY = 'pd_env';
    process.env.PIWI_USERNAME = 'envuser';
    process.env.PIWI_PASSWORD = 'envpass';
    const opts = resolveOptions({});
    expect(opts.apiKey).toBe('pd_env');
    expect(opts.username).toBe('envuser');
    expect(opts.password).toBe('envpass');
  });

  it('reads PIWI_ENVIRONMENT / LABEL / RUN_LABEL from env', () => {
    process.env.PIWI_ENVIRONMENT = 'staging';
    process.env.PIWI_LABEL = 'v2';
    process.env.PIWI_RUN_LABEL = 'run-1';
    const opts = resolveOptions({});
    expect(opts.environment).toBe('staging');
    expect(opts.label).toBe('v2');
    expect(opts.runLabel).toBe('run-1');
  });

  it('reads PIWI_KEEP from env, and an explicit option wins', () => {
    expect(resolveOptions({}).keep).toBeUndefined();
    process.env.PIWI_KEEP = 'true';
    expect(resolveOptions({}).keep).toBe(true);
    expect(resolveOptions({ keep: false }).keep).toBe(false);
    process.env.PIWI_KEEP = 'false';
    expect(resolveOptions({}).keep).toBe(false);
  });

  it('reads PIWI_STREAMING=false and numeric batch params from env', () => {
    process.env.PIWI_STREAMING = 'false';
    process.env.PIWI_STREAMING_BATCH_SIZE = '7';
    process.env.PIWI_STREAMING_BATCH_DELAY = '9000';
    const opts = resolveOptions({});
    expect(opts.streaming).toBe(false);
    expect(opts.streamingBatchSize).toBe(7);
    expect(opts.streamingBatchDelay).toBe(9000);
  });

  it('user streaming=false is not overridden by a missing env var', () => {
    const opts = resolveOptions({ streaming: false });
    expect(opts.streaming).toBe(false);
  });

  it('reads PIWI_MAX_STREAM_BUFFER_BYTES from env, and a user option wins over it', () => {
    process.env.PIWI_MAX_STREAM_BUFFER_BYTES = '2048';
    expect(resolveOptions({}).maxStreamBufferBytes).toBe(2048);
    expect(resolveOptions({ maxStreamBufferBytes: 4096 }).maxStreamBufferBytes).toBe(4096);
  });

  it('reads PIWI_SUBMIT_TIMEOUT from env, including 0 for no limit, and a user option wins over it', () => {
    process.env.PIWI_SUBMIT_TIMEOUT = '0';
    expect(resolveOptions({}).submitTimeout).toBe(0);
    process.env.PIWI_SUBMIT_TIMEOUT = '60000';
    expect(resolveOptions({}).submitTimeout).toBe(60000);
    expect(resolveOptions({ submitTimeout: 5000 }).submitTimeout).toBe(5000);
  });

  it('PIWI_VERBOSE env wins over user option (preserved quirk)', () => {
    const opts1 = resolveOptions({ verbose: false });
    expect(opts1.verbose).toBe(false);
    process.env.PIWI_VERBOSE = 'true';
    const opts2 = resolveOptions({ verbose: false });
    expect(opts2.verbose).toBe(true);
  });

  it('PIWI_VERBOSE=false stays false', () => {
    process.env.PIWI_VERBOSE = 'false';
    const opts = resolveOptions({});
    expect(opts.verbose).toBe(false);
  });

  it('reads PIWI_OUTPUT_FILE from env, and a user option wins over it', () => {
    process.env.PIWI_OUTPUT_FILE = 'piwi-run.json';
    expect(resolveOptions({}).outputFile).toBe('piwi-run.json');
    expect(resolveOptions({ outputFile: 'explicit.json' }).outputFile).toBe('explicit.json');
  });
});

describe('coverage options and their variables', () => {
  let saved: NodeJS.ProcessEnv = {};
  beforeEach(() => {
    saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith('PIWI_')) delete process.env[key];
    process.env.PIWI_DESKTOP_CONFIG = NO_DESKTOP_APP;
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('is unset by default', () => {
    expect(resolveOptions({}).coverage).toBeUndefined();
  });

  it('fills each side from PIWI_COVERAGE_BROWSER and PIWI_COVERAGE_SERVER', () => {
    process.env.PIWI_COVERAGE_BROWSER = 'files';
    process.env.PIWI_COVERAGE_SERVER = 'lines';
    expect(resolveOptions({}).coverage).toEqual({ browser: 'files', server: 'lines' });
  });

  it('keeps an explicit side over its variable, and fills only the other', () => {
    process.env.PIWI_COVERAGE_BROWSER = 'files';
    process.env.PIWI_COVERAGE_SERVER = 'lines';
    expect(resolveOptions({ coverage: { server: 'functions' } }).coverage).toEqual({
      browser: 'files',
      server: 'functions',
    });
  });

  it('bridges the options into the variables the workers read', () => {
    applyOptionsToEnv({ coverage: { browser: 'files', server: 'functions' } });
    expect(process.env.PIWI_COVERAGE_BROWSER).toBe('files');
    expect(process.env.PIWI_COVERAGE_SERVER).toBe('functions');
    expect(resolveOptions({}).coverage).toEqual({ browser: 'files', server: 'functions' });
  });

  it('leaves the variables unset when the options are', () => {
    applyOptionsToEnv({});
    expect(process.env.PIWI_COVERAGE_BROWSER).toBeUndefined();
    expect(process.env.PIWI_COVERAGE_SERVER).toBeUndefined();
  });

  it('turns both sides off with collectPerformanceMetrics: false', () => {
    process.env.PIWI_COVERAGE_SERVER = 'lines';
    applyOptionsToEnv({ collectPerformanceMetrics: false, coverage: { browser: 'files', server: 'lines' } });
    expect(process.env.PIWI_COVERAGE_BROWSER).toBe('off');
    expect(process.env.PIWI_COVERAGE_SERVER).toBe('off');
  });
});

describe('originEnv', () => {
  it('names the launcher, and what it ran for when there is one', () => {
    expect(originEnv('preflight')).toEqual({ PIWI_ORIGIN: 'preflight' });
    expect(originEnv('bug', 37)).toEqual({ PIWI_ORIGIN: 'bug', PIWI_ORIGIN_REF: '37' });
  });
});
