import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { resolveOptions, usedDesktopDiscovery } from '../src/internal/config/env.js';
import { defaultDesktopConfigPath, readDesktopConfig } from '../src/internal/config/desktop.js';

const DESKTOP_URL = 'http://127.0.0.1:3000';
const DESKTOP_TOKEN = `pd_${'a'.repeat(64)}`;
const TOUCHED_ENV = ['PIWI_DESKTOP_CONFIG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PROJECT_NAME'];

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

    it('never overrides a connection in the config folder .env', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      fs.writeFileSync(
        path.join(tmpDir, '.env'),
        'PIWI_DASHBOARD_URL=https://piwi.example.com\nPIWI_API_KEY=pd_dotenv\n',
      );
      const opts = resolveOptions({}, tmpDir);
      expect(opts.serverUrl).toBe('https://piwi.example.com');
      expect(opts.apiKey).toBe('pd_dotenv');
      expect(usedDesktopDiscovery()).toBe(false);
    });

    it('never pairs a key from the config folder .env with the desktop URL', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      fs.writeFileSync(path.join(tmpDir, '.env'), 'PIWI_API_KEY=pd_dotenv\n');
      const opts = resolveOptions({}, tmpDir);
      expect(opts.apiKey).toBe('pd_dotenv');
      expect(opts.serverUrl).toBe(undefined);
      expect(usedDesktopDiscovery()).toBe(false);
    });

    it('still adopts the desktop app when the config folder .env names no server', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      fs.writeFileSync(
        path.join(tmpDir, '.env'),
        'PIWI_PROJECT_NAME=from-dotenv\nPIWI_DASHBOARD_URL=\nPIWI_API_KEY=\n',
      );
      const opts = resolveOptions({}, tmpDir);
      expect(opts.projectName).toBe('from-dotenv');
      expect(opts.serverUrl).toBe(DESKTOP_URL);
      expect(opts.apiKey).toBe(DESKTOP_TOKEN);
      expect(usedDesktopDiscovery()).toBe(true);
    });

    it('treats an explicit apiKey: null as unset', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      const opts = resolveOptions({ apiKey: null });
      expect(opts.apiKey).toBe(DESKTOP_TOKEN);
      expect(opts.serverUrl).toBe(DESKTOP_URL);
    });

    it('keeps other options and defaults intact', () => {
      publishDesktopConfig({ url: DESKTOP_URL, token: DESKTOP_TOKEN });
      const opts = resolveOptions({ projectName: 'mine' });
      expect(opts.projectName).toBe('mine');
      expect(opts.streaming).toBe(true);
      expect(opts.serverUrl).toBe(DESKTOP_URL);
    });
  });
});
