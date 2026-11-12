/**
 * Piwi Runner's Node host on a real socket: the readiness probe, the window's files, and the run-target routes, session
 * and streams of the shared guard (the contract every host of them answers is `packages/editor/tests/
 * run-target-routes.test.ts`, which runs the same functions on a bare `node:http` host).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { linkedFolders, resetDesktopRunTarget, useLinks } from '@piwitests/editor/run-target';
import { ShellRuns } from '@piwitests/editor/shell-runs';
import { isLoopbackHost, runnerHandler } from '../server/host';
import { RUNNER_RUN_CHANNEL_PREFIX, RUNNER_RUNS_WORDS } from '../server/runs';

const TOKEN = `pd_${'d'.repeat(64)}`;
const SHELL = { 'x-piwi-token': TOKEN };
const SHELL_HEADERS = { ...SHELL, 'content-type': 'application/json' };
const DESKTOP_CHALLENGE_HEADER = 'x-piwi-desktop-challenge';
const DESKTOP_PROOF_HEADER = 'x-piwi-desktop-proof';

/** The shell's side of the readiness probe: a fresh challenge, and the proof it expects for it on `port`. */
const newDesktopChallenge = () => crypto.randomBytes(32).toString('hex');
const desktopTokenProof = (token: string, port: number, challenge: string) =>
  crypto.createHmac('sha256', token).update(`piwi-desktop-proof:${port}:${challenge}`).digest('hex');

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

let root: string;
let secret: string;
let server: http.Server;
let base: string;
/** The hub of the runs the shell starts, as the host serves it: none until a test opens one. */
let hub: ShellRuns | null = null;

beforeEach(async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-runner-host-')));
  root = path.join(folder, 'public');
  secret = path.join(folder, 'secret.txt');
  fs.mkdirSync(path.join(root, '_nuxt'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Piwi Runner</title>');
  fs.writeFileSync(path.join(root, '_nuxt', 'entry.js'), 'export {};');
  fs.writeFileSync(secret, 'not for the window');
  server = http.createServer(runnerHandler({ token: TOKEN, root, runs: () => hub }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  hub?.close();
  hub = null;
  resetDesktopRunTarget();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

/** A request as the shell or the window sends one; the path is sent as it is written. */
function call(method: string, route: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${route}`, { method, headers, setHost: !headers.host }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('the readiness probe', () => {
  test('answers 200 with the proof of the token for the challenge, bound to its own port', async () => {
    const challenge = newDesktopChallenge();
    const answer = await call('GET', '/api/health', { [DESKTOP_CHALLENGE_HEADER]: challenge });
    expect(answer.status).toBe(200);
    const port = Number(new URL(base).port);
    expect(answer.headers[DESKTOP_PROOF_HEADER]).toBe(desktopTokenProof(TOKEN, port, challenge));
    expect(answer.headers[DESKTOP_PROOF_HEADER]).not.toBe(desktopTokenProof(TOKEN, port + 1, challenge));
  });

  test('answers a new challenge with a new proof, so an earlier answer proves nothing', async () => {
    const first = await call('GET', '/api/health', { [DESKTOP_CHALLENGE_HEADER]: newDesktopChallenge() });
    const second = await call('GET', '/api/health', { [DESKTOP_CHALLENGE_HEADER]: newDesktopChallenge() });
    expect(first.headers[DESKTOP_PROOF_HEADER]).toBeTruthy();
    expect(second.headers[DESKTOP_PROOF_HEADER]).not.toBe(first.headers[DESKTOP_PROOF_HEADER]);
  });

  test('answers 200 without a proof when there is no well-formed challenge', async () => {
    const requests: Record<string, string>[] = [{}, { [DESKTOP_CHALLENGE_HEADER]: 'not-a-challenge' }];
    for (const headers of requests) {
      const answer = await call('GET', '/api/health', headers);
      expect(answer.status).toBe(200);
      expect(answer.headers[DESKTOP_PROOF_HEADER]).toBeUndefined();
    }
  });

  test('refuses a request whose Host is not this machine', async () => {
    expect((await call('GET', '/api/health', { host: 'evil.example:80' })).status).toBe(421);
    expect(isLoopbackHost('127.0.0.1:3000')).toBe(true);
    expect(isLoopbackHost('localhost:3000')).toBe(true);
    expect(isLoopbackHost('[::1]:3000')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

/** A session code, as the shell gets one over its own request. */
async function sessionCode(): Promise<string> {
  const answer = await call('POST', '/api/desktop/run-target/session-code', SHELL_HEADERS, '{}');
  expect(answer.status).toBe(200);
  return (JSON.parse(answer.text) as { code: string }).code;
}

describe('the window session', () => {
  test('refuses a code that is missing, wrong or sent twice', async () => {
    const code = await sessionCode();
    expect((await call('GET', '/__piwi/session')).status).toBe(403);
    expect((await call('GET', '/__piwi/session?code=wrong')).status).toBe(403);
    expect((await call('GET', `/__piwi/session?code=${code}&code=${code}`)).status).toBe(403);
  });

  test('refuses the access token on the URL, and a code that was already used', async () => {
    expect((await call('GET', `/__piwi/session?token=${TOKEN}`)).status).toBe(403);
    expect((await call('GET', `/__piwi/session?code=${TOKEN}`)).status).toBe(403);
    const code = await sessionCode();
    expect((await call('GET', `/__piwi/session?code=${code}`)).status).toBe(302);
    expect((await call('GET', `/__piwi/session?code=${code}`)).status).toBe(403);
  });

  test('gives a code to the shell only', async () => {
    const route = '/api/desktop/run-target/session-code';
    const json = { 'content-type': 'application/json' };
    expect((await call('POST', route, json, '{}')).status).toBe(401);
    const browser = await call('POST', route, { ...SHELL_HEADERS, origin: 'http://127.0.0.1:3000' }, '{}');
    expect(browser.status).toBe(403);
  });

  test('exchanges the code for the cookie that opens the streams', async () => {
    const answer = await call('GET', `/__piwi/session?code=${await sessionCode()}`);
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('/');
    const cookie = String(answer.headers['set-cookie']);
    expect(cookie).toContain(`piwi_token=${encodeURIComponent(TOKEN)}`);
    expect(cookie).toContain('HttpOnly');
    expect((await call('GET', '/api/desktop/events')).status).toBe(401);
    const opened = await new Promise<number>((resolve, reject) => {
      const req = http.get(`${base}/api/desktop/events`, { headers: { cookie: cookie.split(';')[0]! } }, (res) => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      req.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
      });
    });
    expect(opened).toBe(200);
  });
});

describe('the run-target routes', () => {
  test('answer 401 without the token, and refuse a browser on a shell-only route', async () => {
    expect((await call('GET', '/api/desktop/run-target')).status).toBe(401);
    expect((await call('GET', '/api/desktop/events')).status).toBe(401);
    expect((await call('GET', '/api/desktop/notifications')).status).toBe(401);
    const asBrowser = await call('POST', '/api/desktop/run-target/key', { ...SHELL, origin: 'http://127.0.0.1:1' });
    expect(asBrowser.status).toBe(403);
  });

  test('serve the connection to the shell and to the window with the token', async () => {
    const asShell = await call('GET', '/api/desktop/run-target', SHELL);
    expect(asShell.status).toBe(200);
    expect(JSON.parse(asShell.text)).toMatchObject({ connection: { state: 'none' } });
    const asWindow = await call('GET', '/api/desktop/run-target', { cookie: `piwi_token=${TOKEN}` });
    expect(asWindow.status).toBe(200);
  });

  test('answer 404 to any other API path, with or without the token', async () => {
    expect((await call('GET', '/api/projects', SHELL)).status).toBe(404);
    expect((await call('GET', '/api/projects')).status).toBe(404);
    expect((await call('GET', '/__piwi/other')).status).toBe(404);
  });
});

describe('the hub of the runs the shell starts', () => {
  const open = async () => {
    hub = await ShellRuns.start({
      token: TOKEN,
      version: '0.0.0',
      folders: linkedFolders,
      words: RUNNER_RUNS_WORDS,
      folderPrefix: RUNNER_RUN_CHANNEL_PREFIX,
    });
    return hub;
  };

  test('names its run channel and the picks address to the shell alone, with the token', async () => {
    const runs = await open();
    expect((await call('GET', '/api/desktop/run-channel')).status).toBe(401);
    const asBrowser = await call('GET', '/api/desktop/run-channel', { ...SHELL, origin: 'http://127.0.0.1:1' });
    expect(asBrowser.status).toBe(403);
    const asShell = await call('GET', '/api/desktop/run-channel', SHELL);
    expect(asShell.status).toBe(200);
    const port = new URL(base).port;
    expect(JSON.parse(asShell.text)).toEqual({
      runChannel: runs.runChannel,
      picks: `http://127.0.0.1:${port}/api/desktop/runs/picks#${runs.picksToken()}`,
      hub: { url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/), token: TOKEN },
    });
    expect(path.basename(path.dirname(runs.runChannel!.split('#')[0]!))).toMatch(/^piwi-runner-run-/);
  });

  test('names no channel before the hub opens, so a run starts without one', async () => {
    const answer = await call('GET', '/api/desktop/run-channel', SHELL);
    expect(JSON.parse(answer.text)).toEqual({ runChannel: null, picks: null, hub: null });
    expect((await call('POST', '/api/desktop/runs/commands', SHELL_HEADERS, '{}')).status).toBe(503);
  });

  test('takes the window’s commands and a run’s picks behind their tokens', async () => {
    const runs = await open();
    expect(
      (await call('POST', '/api/desktop/runs/commands', { 'content-type': 'application/json' }, '{}')).status,
    ).toBe(401);
    expect((await call('POST', '/api/desktop/runs/commands', SHELL_HEADERS, '{}')).status).toBe(404);
    const pick = JSON.stringify({ kind: 'locator', text: "getByText('Pay')" });
    const picks = { authorization: `Bearer ${runs.picksToken()}`, 'content-type': 'application/json' };
    expect((await call('POST', '/api/desktop/runs/picks', picks, pick)).status).toBe(200);
    expect((await call('GET', '/api/desktop/run-target', picks)).status).toBe(401);
    expect((await call('GET', '/api/desktop/run-channel', picks)).status).toBe(401);
  });

  test('takes the folders the shell links to the instance’s projects as its runs’ folders', async () => {
    const runs = await open();
    const folder = path.dirname(root);
    useLinks(new Map([[4, folder]]));
    expect(runs.live()[0]?.roots).toEqual([folder]);
    expect(runs.live()[0]?.client).toBe('Piwi Runner');
  });

  test('serves no other route of the dashboard’s desktop build', async () => {
    await open();
    expect((await call('GET', '/api/desktop/live', SHELL)).status).toBe(404);
  });
});

describe('the window files', () => {
  test('serve the built files, keeping the ones named by content', async () => {
    const page = await call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.text).toContain('Piwi Runner');
    const script = await call('GET', '/_nuxt/entry.js');
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.headers['cache-control']).toContain('immutable');
  });

  test('answer a page of the window with its index, and a missing file with a 404', async () => {
    expect((await call('GET', '/settings')).text).toContain('Piwi Runner');
    expect((await call('GET', '/_nuxt/missing.js')).status).toBe(404);
  });

  test('answer HEAD without a body, and refuse any other method', async () => {
    const head = await call('HEAD', '/');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect((await call('DELETE', '/')).status).toBe(404);
  });

  test('never serve a file outside the folder', async () => {
    for (const route of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/_nuxt/..%2f..%2fsecret.txt', '/%00', '/%zz']) {
      const answer = await call('GET', route);
      expect(answer.text, route).not.toContain('not for the window');
    }
    expect((await call('GET', '/..%2fsecret.txt')).status).toBe(404);
  });
});
