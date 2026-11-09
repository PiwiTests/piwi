import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTokenProof } from '@piwitests/core/desktop-proof';
import { cliFetch, connectionFolders, resolveCliConnection } from '../src/internal/support/connection.js';

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
      desktop: true,
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
      desktop: true,
      project: 'shop',
    });
    expect(resolveCliConnection({ serverUrl: 'https://flag.example' }, env, [folder])?.serverUrl).toBe(
      'https://flag.example',
    );
    expect(resolveCliConnection({}, { ...env, CI: 'true' }, [folder])?.serverUrl).toBe('https://env.example');
  });

  it('never sends the environment PIWI_API_KEY to the desktop app with PIWI_DESKTOP_APP=prefer', () => {
    const env = {
      PIWI_DESKTOP_CONFIG: desktopFile,
      PIWI_DESKTOP_APP: 'prefer',
      PIWI_DASHBOARD_URL: 'https://env.example',
      PIWI_API_KEY: 'pd_env',
    };
    expect(resolveCliConnection({}, env, [])).toEqual({
      serverUrl: 'http://127.0.0.1:3917',
      apiKey: 'pd_desktop',
      desktop: true,
      project: '',
    });
    expect(resolveCliConnection({}, { ...env, PIWI_DASHBOARD_URL: undefined }, [])?.apiKey).toBe('pd_desktop');
  });

  it('skips the desktop app with PIWI_DESKTOP_APP=fallback when an API key is set and no URL', () => {
    const keyOnly = dotEnvFolder('key-only', 'PIWI_API_KEY=pd_dotenv\n');
    const desktopEnv = { PIWI_DESKTOP_CONFIG: desktopFile };
    expect(resolveCliConnection({}, { ...desktopEnv, PIWI_API_KEY: 'pd_env' }, [])).toBeNull();
    expect(resolveCliConnection({ apiKey: 'pd_flag' }, desktopEnv, [])).toBeNull();
    expect(resolveCliConnection({}, desktopEnv, [keyOnly])).toBeNull();
    const preferOnCi = { ...desktopEnv, PIWI_DESKTOP_APP: 'prefer', CI: 'true', PIWI_API_KEY: 'pd_env' };
    expect(resolveCliConnection({}, preferOnCi, [])).toBeNull();
  });

  it('takes the URL and its key from the same .env file', () => {
    const near = dotEnvFolder('e2e', 'PIWI_DASHBOARD_URL=https://b.test\n');
    const root = dotEnvFolder(
      'root',
      'PIWI_DASHBOARD_URL=https://a.test\nPIWI_API_KEY=key-for-a\nPIWI_PROJECT_NAME=shop\n',
    );
    const noDesktop = { PIWI_DESKTOP_CONFIG: '/nonexistent/desktop.json' };
    expect(resolveCliConnection({}, noDesktop, [near, root])).toEqual({
      serverUrl: 'https://b.test',
      apiKey: null,
      project: 'shop',
    });

    const keyOnly = dotEnvFolder('key-only', 'PIWI_API_KEY=pd_near\n');
    expect(resolveCliConnection({}, noDesktop, [keyOnly, near])?.apiKey).toBeNull();
    expect(resolveCliConnection({}, noDesktop, [keyOnly, root])).toEqual({
      serverUrl: 'https://a.test',
      apiKey: 'key-for-a',
      project: 'shop',
    });
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
    const prefer = { PIWI_DESKTOP_CONFIG: desktopFile, PIWI_DESKTOP_APP: 'prefer' };
    expect(resolveCliConnection({ apiKey: 'pd_flag' }, prefer, [], 'piwi bug')?.apiKey).toBe('pd_desktop');
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

  it('looks for the Playwright config no higher than the repository root', () => {
    const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-cli-outer-')));
    try {
      fs.writeFileSync(path.join(outer, 'playwright.config.ts'), 'export default {};\n');
      const repo = path.join(outer, 'repo');
      const below = path.join(repo, 'src');
      fs.mkdirSync(below, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo });
      expect(connectionFolders(below)).toEqual([below, repo]);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe('cliFetch', () => {
  let dir: string;
  let server: http.Server;
  let port: number;
  let seen: Array<{ url: string; key: string | undefined; challenge: string | undefined }>;
  let answer: (challenge: string | undefined) => Promise<string | null>;
  let status: number;

  beforeEach(async () => {
    seen = [];
    status = 200;
    answer = async (challenge) => (challenge ? await desktopTokenProof('pd_desktop', port, challenge) : null);
    server = http.createServer(async (req, res) => {
      const challenge = req.headers['x-piwi-desktop-challenge'] as string | undefined;
      seen.push({ url: req.url ?? '', key: req.headers['x-api-key'] as string | undefined, challenge });
      const proof = req.url === '/api/health' ? await answer(challenge) : null;
      res.writeHead(req.url === '/api/health' ? status : 200, proof ? { 'x-piwi-desktop-proof': proof } : {});
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-cli-fetch-'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Resolve the desktop app's connection as a command does, from a discovery file for the test server. */
  const desktopConnection = (env: Record<string, string> = {}) => {
    const file = path.join(dir, 'desktop.json');
    fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'pd_desktop' }));
    return resolveCliConnection({}, { PIWI_DESKTOP_CONFIG: file, ...env }, [])!;
  };

  it('sends the desktop key after the server proved it holds the key, with a proof of its own for each request', async () => {
    const connection = desktopConnection();
    const headers = { 'X-API-Key': connection.apiKey! };
    expect((await cliFetch(`${connection.serverUrl}/api/a`, { headers })).status).toBe(200);
    expect((await cliFetch(`${connection.serverUrl}/api/b`, { headers })).status).toBe(200);
    expect(seen.map((r) => [r.url, r.key])).toEqual([
      ['/api/health', undefined],
      ['/api/a', 'pd_desktop'],
      ['/api/health', undefined],
      ['/api/b', 'pd_desktop'],
    ]);
  });

  it('sends no key once the server stopped proving it, with no request failing in between', async () => {
    const connection = desktopConnection();
    const headers = { 'X-API-Key': connection.apiKey! };
    await cliFetch(`${connection.serverUrl}/api/a`, { headers });
    answer = async () => null;
    seen.length = 0;
    await expect(cliFetch(`${connection.serverUrl}/api/b`, { headers })).rejects.toThrow(/token is not sent/);
    expect(seen.map((r) => [r.url, r.key])).toEqual([['/api/health', undefined]]);
  });

  it('asks for the proof when the desktop key is in one header and another key is in the other', async () => {
    answer = async () => null;
    const connection = desktopConnection();
    await expect(
      cliFetch(`${connection.serverUrl}/api/a`, {
        headers: { 'X-API-Key': 'pd_someone_else', Authorization: `Bearer ${connection.apiKey}` },
      }),
    ).rejects.toThrow(/token is not sent/);
    expect(seen.map((r) => r.url)).toEqual(['/api/health']);
  });

  it('asks for the proof of a desktop key carried as a bearer token too', async () => {
    answer = async () => null;
    const connection = desktopConnection();
    await expect(
      cliFetch(`${connection.serverUrl}/api/a`, { headers: { Authorization: `Bearer ${connection.apiKey}` } }),
    ).rejects.toThrow(/token is not sent/);
    expect(seen.every((r) => r.key === undefined)).toBe(true);
    expect(seen.map((r) => r.url)).toEqual(['/api/health']);
  });

  it.each([
    ['proves it with another key', () => (answer = (c) => desktopTokenProof('pd_other', port, c ?? ''))],
    ['sends no proof', () => (answer = async () => null)],
    ['answers the check with an error', () => (status = 503)],
  ])('sends no key to a server that %s', async (_name, break_) => {
    break_();
    const connection = desktopConnection();
    await expect(
      cliFetch(`${connection.serverUrl}/api/a`, { headers: { 'X-API-Key': connection.apiKey! } }),
    ).rejects.toThrow(/token is not sent to http:\/\/127\.0\.0\.1:\d+/);
    expect(seen.every((r) => r.key === undefined)).toBe(true);
    expect(seen.map((r) => r.url)).toEqual(['/api/health']);
  });

  it("proves a key the desktop app's run marks, and a key the user named only on a flag needs no proof", async () => {
    const file = path.join(dir, 'desktop.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:1', token: 'pd_unrelated' }));
    const url = `http://127.0.0.1:${port}`;
    const env = {
      PIWI_DESKTOP_CONFIG: file,
      PIWI_DESKTOP_APP: 'off',
      PIWI_DASHBOARD_URL: url,
      PIWI_API_KEY: 'pd_desktop',
    };

    const own = resolveCliConnection({}, env, [])!;
    await cliFetch(`${url}/api/own`, { headers: { 'X-API-Key': own.apiKey! } });
    expect(seen.map((r) => r.url)).toEqual(['/api/own']);

    seen.length = 0;
    const marked = resolveCliConnection({}, { ...env, PIWI_DESKTOP_KEY: '1' }, [])!;
    await cliFetch(`${url}/api/marked`, { headers: { 'X-API-Key': marked.apiKey! } });
    expect(seen.map((r) => [r.url, r.key])).toEqual([
      ['/api/health', undefined],
      ['/api/marked', 'pd_desktop'],
    ]);
  });

  it('makes no check for a request that does not carry the desktop key', async () => {
    desktopConnection();
    await cliFetch(`http://127.0.0.1:${port}/api/plain`, { headers: { 'X-API-Key': 'pd_someone_else' } });
    await cliFetch(`http://127.0.0.1:${port}/api/none`);
    expect(seen.map((r) => r.url)).toEqual(['/api/plain', '/api/none']);
  });
});
