import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import type { PlaywrightTestConfig } from '@playwright/test';
import { applyOptionsToEnv, originEnv, resolveOptions, usedDotEnv } from '../src/internal/config/env.js';
import { wrapConfig } from '../src/public/config-wrapper.js';
import { createGlobalSetup } from '../src/public/global-setup.js';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { getSetupFilePath } from '../src/internal/support/setup-file.js';
import type { PiwiDashboardOptions } from '../src/public/options.js';
import { startServer, jsonRes, fakeConfig, fakeSuite, type FakeServer } from './_helpers.js';

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

describe("the config folder's .env", () => {
  let saved: NodeJS.ProcessEnv = {};
  let configDir = '';
  let server: FakeServer | null = null;
  const projectName = `piwi-dotenv-${process.pid}`;

  beforeEach(() => {
    saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith('PIWI_')) delete process.env[key];
    process.env.PIWI_DESKTOP_CONFIG = NO_DESKTOP_APP;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-dotenv-'));
  });
  afterEach(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(getSetupFilePath(projectName), { force: true });
    if (server) await server.close();
    server = null;
  });

  function writeDotEnv(text: string): void {
    fs.writeFileSync(path.join(configDir, '.env'), text);
  }

  function connection(opts: PiwiDashboardOptions): Pick<PiwiDashboardOptions, 'serverUrl' | 'apiKey' | 'projectName'> {
    return { serverUrl: opts.serverUrl, apiKey: opts.apiKey, projectName: opts.projectName };
  }

  it('reads the connection `piwi init` writes', () => {
    writeDotEnv(
      'PIWI_DASHBOARD_URL=http://dotenv-host:3000\nPIWI_API_KEY=pd_dotenv\nPIWI_PROJECT_NAME=dotenv-project\n',
    );
    const opts = resolveOptions({}, configDir);
    expect(connection(opts)).toEqual({
      serverUrl: 'http://dotenv-host:3000',
      apiKey: 'pd_dotenv',
      projectName: 'dotenv-project',
    });
    expect(usedDotEnv()).toEqual({
      file: path.join(configDir, '.env'),
      keys: ['PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PROJECT_NAME'],
    });
  });

  it('parses the file as the CLI commands do: export, quotes and comments', () => {
    writeDotEnv('# Piwi\nexport PIWI_API_KEY="pd_quoted"\nPIWI_DASHBOARD_URL=http://dotenv-host:3000 # local\n');
    const opts = resolveOptions({}, configDir);
    expect(opts.apiKey).toBe('pd_quoted');
    expect(opts.serverUrl).toBe('http://dotenv-host:3000');
  });

  it('fills only what the options and the environment leave unset', () => {
    writeDotEnv(
      'PIWI_DASHBOARD_URL=http://dotenv-host:3000\nPIWI_API_KEY=pd_dotenv\nPIWI_PROJECT_NAME=dotenv-project\n',
    );
    process.env.PIWI_API_KEY = 'pd_env';
    const opts = resolveOptions({ serverUrl: 'http://config-host:3000' }, configDir);
    expect(connection(opts)).toEqual({
      serverUrl: 'http://config-host:3000',
      apiKey: 'pd_env',
      projectName: 'dotenv-project',
    });
    expect(usedDotEnv()?.keys).toEqual(['PIWI_PROJECT_NAME']);
  });

  it('reads no other variable, and skips an empty value', () => {
    writeDotEnv(
      'PIWI_API_KEY=\nPIWI_STREAMING=false\nPIWI_VERBOSE=true\nPIWI_USERNAME=dotenv-user\nPIWI_CAPTURE_LOCATORS=false\n',
    );
    const opts = resolveOptions({}, configDir);
    expect(opts.apiKey).toBe(null);
    expect(opts.streaming).toBe(true);
    expect(opts.verbose).toBe(false);
    expect(opts.username).toBe(null);
    expect(opts.captureLocators).toBe(true);
    expect(usedDotEnv()).toBe(null);
  });

  it('reads no file without a config folder, nor when the folder has none', () => {
    writeDotEnv('PIWI_API_KEY=pd_dotenv\n');
    expect(resolveOptions({}).apiKey).toBe(null);
    expect(usedDotEnv()).toBe(null);

    fs.rmSync(path.join(configDir, '.env'));
    expect(resolveOptions({}, configDir).apiKey).toBe(null);
    expect(usedDotEnv()).toBe(null);
  });

  it('resolves one connection in the reporter and in the global setup that wrapConfig bridges to', () => {
    writeDotEnv('PIWI_DASHBOARD_URL=http://dotenv-host:3000\nPIWI_API_KEY=pd_dotenv\n');
    const cases: Array<[PiwiDashboardOptions, Pick<PiwiDashboardOptions, 'serverUrl' | 'apiKey' | 'projectName'>]> = [
      [
        { serverUrl: 'http://config-host:3000', projectName: 'mine' },
        { serverUrl: 'http://config-host:3000', apiKey: 'pd_dotenv', projectName: 'mine' },
      ],
      [{ projectName: 'mine' }, { serverUrl: 'http://dotenv-host:3000', apiKey: 'pd_dotenv', projectName: 'mine' }],
    ];
    for (const [piwiOptions, expected] of cases) {
      for (const key of Object.keys(process.env)) if (key.startsWith('PIWI_')) delete process.env[key];
      process.env.PIWI_DESKTOP_CONFIG = NO_DESKTOP_APP;
      // wrapConfig, as Playwright loads the config.
      applyOptionsToEnv(piwiOptions);
      // The reporter, constructed with its entry's options and the folder Playwright adds.
      const reporter = resolveOptions({ ...piwiOptions, configDir }, configDir);
      // The global setup, with the options it finds in the reporters array, then with none.
      const setup = resolveOptions({ ...piwiOptions }, configDir);
      const setupFromEnv = resolveOptions({}, configDir);
      expect(connection(reporter)).toEqual(expected);
      expect(connection(setup)).toEqual(expected);
      expect(connection(setupFromEnv)).toEqual(expected);
    }
  });

  it('sends the key to the dashboard from the global setup and the reporter', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/setup') return jsonRes(res, 200, { runId: 7, setupToken: 'setup-tok' });
      if (req.url === '/api/test-runs/7/begin') return jsonRes(res, 200, { runId: 7, streamToken: 'stream-tok' });
      return jsonRes(res, 404, {});
    });
    writeDotEnv(`PIWI_DASHBOARD_URL=${server.url}\nPIWI_API_KEY=pd_dotenv\n`);
    const configFile = path.join(configDir, 'playwright.config.ts');
    const piwiOptions: PiwiDashboardOptions = {
      projectName,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      uploadManifest: false,
      sampleAriaOnPass: false,
    };
    const config = wrapConfig<PlaywrightTestConfig>({}, piwiOptions);

    await createGlobalSetup()({ configFile, reporter: config.reporter });
    const reporter = new PiwiDashboardReporter({ ...piwiOptions, configDir });
    reporter.onBegin(fakeConfig({ configFile }), fakeSuite());
    const deadline = Date.now() + 3000;
    while (!server.requests.some((r) => r.url === '/api/test-runs/7/begin') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const request = (url: string) => server!.requests.find((r) => r.url === url);
    expect(request('/api/test-runs/setup')?.headers.authorization).toBe('Bearer pd_dotenv');
    // The reporter begins the run the global setup registered, under the same project.
    expect(request('/api/test-runs/7/begin')?.headers.authorization).toBe('Bearer pd_dotenv');
    expect(JSON.parse(request('/api/test-runs/7/begin')!.body).setupToken).toBe('setup-tok');
  });
});

describe('originEnv', () => {
  it('names the launcher, and what it ran for when there is one', () => {
    expect(originEnv('preflight')).toEqual({ PIWI_ORIGIN: 'preflight' });
    expect(originEnv('bug', 37)).toEqual({ PIWI_ORIGIN: 'bug', PIWI_ORIGIN_REF: '37' });
  });
});
