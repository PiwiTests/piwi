import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import {
  applyOptionsToEnv,
  desktopReplacedServer,
  resolveOptions,
  usedDesktopDiscovery,
} from '../src/internal/config/env.js';
import { defaultDesktopConfigPath, readDesktopConfig } from '../src/internal/config/desktop.js';

const DESKTOP_URL = 'http://127.0.0.1:3000';
const DESKTOP_TOKEN = `pd_${'a'.repeat(64)}`;
const TEAM_URL = 'https://piwi.example.com';
const CI_ENV = [
  'CI',
  'JENKINS_URL',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'TF_BUILD',
  'BITBUCKET_BUILD_NUMBER',
  'TEAMCITY_VERSION',
  'CODEBUILD_BUILD_ID',
  'bamboo_buildKey',
];
const TOUCHED_ENV = [
  'PIWI_DESKTOP_CONFIG',
  'PIWI_DASHBOARD_URL',
  'PIWI_API_KEY',
  'PIWI_USERNAME',
  'PIWI_PASSWORD',
  'PIWI_DESKTOP_APP',
  ...CI_ENV,
];

let tmpDir: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

/** Write a desktop.json as the running app would. */
function publishDesktopConfig(body: unknown): void {
  fs.writeFileSync(configPath, typeof body === 'string' ? body : JSON.stringify(body));
}

describe('desktop discovery', () => {
  beforeEach(() => {
    for (const key of TOUCHED_ENV) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-desktop-'));
    configPath = path.join(tmpDir, 'desktop.json');
    process.env.PIWI_DESKTOP_CONFIG = configPath;
  });

  afterEach(() => {
    for (const key of TOUCHED_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readDesktopConfig', () => {
    it('reads a published url and token', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      expect(readDesktopConfig(configPath)).toEqual({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
    });

    it('returns null when the app is not running', () => {
      expect(readDesktopConfig(configPath)).toBe(null);
    });

    it('returns null for malformed or incomplete files rather than throwing', () => {
      publishDesktopConfig('{ truncated');
      expect(readDesktopConfig(configPath)).toBe(null);

      publishDesktopConfig({ url: DESKTOP_URL });
      expect(readDesktopConfig(configPath)).toBe(null);

      publishDesktopConfig({ url: '', token: DESKTOP_TOKEN });
      expect(readDesktopConfig(configPath)).toBe(null);
    });

    it('reads a file whose app is running, and ignores one a crash left behind', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN, pid: process.pid });
      expect(readDesktopConfig(configPath)).toEqual({ url: DESKTOP_URL, token: DESKTOP_TOKEN });

      const exited = spawnSync(process.execPath, ['-e', '']).pid;
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN, pid: exited });
      expect(readDesktopConfig(configPath)).toBe(null);
    });

    it('defaults to ~/.piwi/desktop.json', () => {
      expect(defaultDesktopConfigPath()).toBe(path.join(os.homedir(), '.piwi', 'desktop.json'));
    });
  });

  describe('resolveOptions', () => {
    it('adopts the desktop app when nothing else is configured', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      const opts = resolveOptions({});
      expect(opts.serverUrl).toBe(DESKTOP_URL);
      expect(opts.apiKey).toBe(DESKTOP_TOKEN);
      expect(usedDesktopDiscovery()).toBe(true);
    });

    it('leaves options untouched when the app is not running', () => {
      const opts = resolveOptions({});
      expect(opts.serverUrl).toBe(undefined);
      expect(opts.apiKey).toBe(null);
      expect(usedDesktopDiscovery()).toBe(false);
    });

    it('never overrides an explicit serverUrl', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      const opts = resolveOptions({ serverUrl: 'https://piwi.example.com' });
      expect(opts.serverUrl).toBe('https://piwi.example.com');
      expect(opts.apiKey).toBe(null);
      expect(usedDesktopDiscovery()).toBe(false);
    });

    it('never overrides an explicit apiKey', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      const opts = resolveOptions({ apiKey: 'pd_from_config' });
      expect(opts.apiKey).toBe('pd_from_config');
      expect(opts.serverUrl).toBe(undefined);
      expect(usedDesktopDiscovery()).toBe(false);
    });

    it('never overrides PIWI_DASHBOARD_URL or PIWI_API_KEY from the environment', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });

      process.env.PIWI_DASHBOARD_URL = 'https://ci.example.com';
      expect(resolveOptions({}).serverUrl).toBe('https://ci.example.com');
      expect(usedDesktopDiscovery()).toBe(false);

      delete process.env.PIWI_DASHBOARD_URL;
      process.env.PIWI_API_KEY = 'pd_ci_secret';
      const opts = resolveOptions({});
      expect(opts.apiKey).toBe('pd_ci_secret');
      expect(opts.serverUrl).toBe(undefined);
      expect(usedDesktopDiscovery()).toBe(false);
    });

    it('treats an explicit apiKey: null as unset', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      const opts = resolveOptions({ apiKey: null });
      expect(opts.apiKey).toBe(DESKTOP_TOKEN);
      expect(opts.serverUrl).toBe(DESKTOP_URL);
    });

    it('never adopts the app with desktopApp: off', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      const opts = resolveOptions({ desktopApp: 'off' });
      expect(opts.serverUrl).toBe(undefined);
      expect(usedDesktopDiscovery()).toBe(false);
    });

    it('keeps other options and defaults intact', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      const opts = resolveOptions({ projectName: 'mine' });
      expect(opts.projectName).toBe('mine');
      expect(opts.streaming).toBe(true);
      expect(opts.serverUrl).toBe(DESKTOP_URL);
    });
  });

  describe("desktopApp: 'prefer'", () => {
    it('sends a local run to the running app instead of the configured server', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      const opts = resolveOptions({ serverUrl: TEAM_URL, apiKey: 'pk_team', desktopApp: 'prefer' });
      expect(opts.serverUrl).toBe(DESKTOP_URL);
      expect(opts.apiKey).toBe(DESKTOP_TOKEN);
      expect(usedDesktopDiscovery()).toBe(true);
      expect(desktopReplacedServer()).toBe(TEAM_URL);
    });

    it('never pairs the app with the team credentials', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      process.env.PIWI_USERNAME = 'ci-bot';
      process.env.PIWI_PASSWORD = 'secret';
      const opts = resolveOptions({ serverUrl: TEAM_URL, desktopApp: 'prefer' });
      expect(opts.apiKey).toBe(DESKTOP_TOKEN);
      expect(opts.username).toBe(null);
      expect(opts.password).toBe(null);
    });

    it('keeps the configured server when the app is not running', () => {
      const opts = resolveOptions({ serverUrl: TEAM_URL, apiKey: 'pk_team', desktopApp: 'prefer' });
      expect(opts.serverUrl).toBe(TEAM_URL);
      expect(opts.apiKey).toBe('pk_team');
      expect(usedDesktopDiscovery()).toBe(false);
      expect(desktopReplacedServer()).toBe(null);
    });

    it.each(CI_ENV)('keeps the configured server on CI (%s)', (key) => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      process.env[key] = key === 'CI' ? 'true' : '1';
      const opts = resolveOptions({ serverUrl: TEAM_URL, apiKey: 'pk_team', desktopApp: 'prefer' });
      expect(opts.serverUrl).toBe(TEAM_URL);
      expect(opts.apiKey).toBe('pk_team');
      expect(usedDesktopDiscovery()).toBe(false);
    });

    it.each(['false', 'False', '0'])('reads CI=%s as a local run', (value) => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      process.env.CI = value;
      expect(resolveOptions({ serverUrl: TEAM_URL, desktopApp: 'prefer' }).serverUrl).toBe(DESKTOP_URL);
    });

    it('also sets aside PIWI_DASHBOARD_URL and PIWI_API_KEY', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      process.env.PIWI_DASHBOARD_URL = TEAM_URL;
      process.env.PIWI_API_KEY = 'pk_team';
      const opts = resolveOptions({ desktopApp: 'prefer' });
      expect(opts.serverUrl).toBe(DESKTOP_URL);
      expect(opts.apiKey).toBe(DESKTOP_TOKEN);
    });

    it('is set by PIWI_DESKTOP_APP, which overrides the option', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      process.env.PIWI_DESKTOP_APP = 'prefer';
      expect(resolveOptions({ serverUrl: TEAM_URL }).serverUrl).toBe(DESKTOP_URL);

      process.env.PIWI_DESKTOP_APP = 'off';
      const opts = resolveOptions({ serverUrl: TEAM_URL, desktopApp: 'prefer' });
      expect(opts.serverUrl).toBe(TEAM_URL);
      expect(opts.desktopApp).toBe('off');
      expect(usedDesktopDiscovery()).toBe(false);
    });

    it('reads an unknown mode as fallback', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      process.env.PIWI_DESKTOP_APP = 'always';
      const opts = resolveOptions({ serverUrl: TEAM_URL });
      expect(opts.serverUrl).toBe(TEAM_URL);
      expect(opts.desktopApp).toBe('fallback');
    });

    it('reaches the global setup through the environment, without masking PIWI_DESKTOP_APP', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      applyOptionsToEnv({ serverUrl: TEAM_URL, desktopApp: 'prefer' });
      expect(process.env.PIWI_DESKTOP_APP).toBe('prefer');
      expect(resolveOptions({}).serverUrl).toBe(DESKTOP_URL);

      process.env.PIWI_DESKTOP_APP = 'off';
      applyOptionsToEnv({ serverUrl: TEAM_URL, desktopApp: 'prefer' });
      expect(process.env.PIWI_DESKTOP_APP).toBe('off');
      expect(resolveOptions({}).serverUrl).toBe(TEAM_URL);
    });
  });
});
