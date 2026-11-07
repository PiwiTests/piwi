import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import {
  requestedRunProblem,
  requestedRunTarget,
  resolveOptions,
  usedDesktopDiscovery,
} from '../src/internal/config/env.js';
import { readRequestedRun } from '../src/internal/config/requested-run.js';

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
    expect(opts.coverage).toBe(undefined);
    expect(requestedRunTarget()).toBe(INSTANCE);
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
