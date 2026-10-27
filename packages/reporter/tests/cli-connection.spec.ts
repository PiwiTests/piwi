import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionFolders, resolveCliConnection } from '../src/internal/support/connection.js';

describe('resolveCliConnection', () => {
  let dir: string;
  let desktopFile: string;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-cli-connection-'));
    desktopFile = path.join(dir, 'desktop.json');
    fs.writeFileSync(desktopFile, JSON.stringify({ url: 'http://127.0.0.1:3917', token: 'pd_desktop' }));
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A folder of `dir` holding a `.env` with `text`. */
  const dotEnvFolder = (name: string, text: string) => {
    const folder = path.join(dir, name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '.env'), text);
    return folder;
  };

  it('turns to the running desktop app when nothing else names a dashboard', () => {
    expect(resolveCliConnection({}, { PIWI_DESKTOP_CONFIG: desktopFile }, [])).toEqual({
      serverUrl: 'http://127.0.0.1:3917',
      apiKey: 'pd_desktop',
      project: '',
    });
  });

  it('never reads the desktop app with PIWI_DESKTOP_APP=off', () => {
    const env = { PIWI_DESKTOP_CONFIG: desktopFile, PIWI_DESKTOP_APP: 'off' };
    expect(resolveCliConnection({}, env, [])).toBeNull();
  });

  it('puts the desktop app before the environment and the .env with PIWI_DESKTOP_APP=prefer, outside CI only', () => {
    const folder = dotEnvFolder('app', 'PIWI_DASHBOARD_URL=https://dotenv.example\nPIWI_PROJECT_NAME=shop\n');
    const env = {
      PIWI_DESKTOP_CONFIG: desktopFile,
      PIWI_DESKTOP_APP: 'prefer',
      PIWI_DASHBOARD_URL: 'https://env.example',
    };
    expect(resolveCliConnection({}, env, [folder])).toEqual({
      serverUrl: 'http://127.0.0.1:3917',
      apiKey: 'pd_desktop',
      project: 'shop',
    });
    expect(resolveCliConnection({ serverUrl: 'https://flag.example' }, env, [folder])?.serverUrl).toBe(
      'https://flag.example',
    );
    expect(resolveCliConnection({}, { ...env, CI: 'true' }, [folder])?.serverUrl).toBe('https://env.example');
  });

  it('treats an empty PIWI_DASHBOARD_URL as unset, in the environment and in a .env', () => {
    const near = dotEnvFolder('near', 'PIWI_DASHBOARD_URL=\n');
    const root = dotEnvFolder('root', 'PIWI_DASHBOARD_URL=https://root.example\nPIWI_API_KEY=pd_root\n');
    const env = { PIWI_DESKTOP_CONFIG: '/nonexistent/desktop.json', PIWI_DASHBOARD_URL: '' };
    expect(resolveCliConnection({}, env, [near, root])).toEqual({
      serverUrl: 'https://root.example',
      apiKey: 'pd_root',
      project: '',
    });
  });

  it('says on stderr that an --api-key flag is not sent to a URL from a .env or the desktop app', () => {
    const folder = dotEnvFolder('app', 'PIWI_DASHBOARD_URL=https://dotenv.example\n');
    const noDesktop = { PIWI_DESKTOP_CONFIG: '/nonexistent/desktop.json' };
    expect(resolveCliConnection({ apiKey: 'pd_flag' }, noDesktop, [folder], 'piwi gate')?.apiKey).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(
      /^piwi gate: --api-key is not sent to https:\/\/dotenv\.example, which comes from a \.env file.*--server-url/,
    );

    error.mockClear();
    expect(
      resolveCliConnection({ apiKey: 'pd_flag' }, { PIWI_DESKTOP_CONFIG: desktopFile }, [], 'piwi bug')?.apiKey,
    ).toBe('pd_desktop');
    expect(String(error.mock.calls[0]?.[0])).toMatch(/^piwi bug: .*comes from the desktop app/);

    error.mockClear();
    const flagged = resolveCliConnection({ serverUrl: 'https://flag.example', apiKey: 'pd_flag' }, noDesktop, [folder]);
    expect(flagged?.apiKey).toBe('pd_flag');
    expect(
      resolveCliConnection({ apiKey: 'pd_flag' }, { ...noDesktop, PIWI_DASHBOARD_URL: 'https://env.example' }, [folder])
        ?.apiKey,
    ).toBe('pd_flag');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('connectionFolders', () => {
  it('lists the Playwright config folder, the working directory and the repository root, each once', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-cli-folders-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const e2e = path.join(repo, 'e2e');
      const below = path.join(e2e, 'tests');
      fs.mkdirSync(below, { recursive: true });
      fs.writeFileSync(path.join(e2e, 'playwright.config.ts'), 'export default {};\n');
      expect(connectionFolders(below)).toEqual([e2e, below, repo]);
      expect(connectionFolders(repo)).toEqual([repo]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
