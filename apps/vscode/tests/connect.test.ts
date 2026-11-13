import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  apiKeySecret,
  connectFailure,
  InstanceError,
  listProjects,
  needsKey,
  normalizeServerUrl,
  startSignIn,
  waitForSignIn,
  type SignIn,
} from '../src/connect';

const started: unknown[] = [];
let answers: string[] = [];
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/projects/menu') {
        if (req.headers['x-api-key'] !== 'pd_new') {
          res.statusCode = 401;
          return res.end('{}');
        }
        return res.end(JSON.stringify({ items: [{ id: 7, name: 'Acme Mugs' }] }));
      }
      if (req.url === '/api/extension/connect') {
        started.push(JSON.parse(body));
        return res.end(
          JSON.stringify({
            deviceCode: 'pdc_1',
            userCode: 'BCDF-GHJK',
            verificationUrl: `${base}/extension/connect?code=BCDF-GHJK`,
            interval: 5,
            expiresIn: 600,
          }),
        );
      }
      if (req.url === '/api/extension/connect/token') return res.end(answers.shift() ?? '{"status":"pending"}');
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const noWait = async () => {};

describe('Piwi: Connect', () => {
  test('an instance URL is stored trimmed, and its key is kept under it', () => {
    expect(normalizeServerUrl('  https://piwi.corp//  ')).toBe('https://piwi.corp');
    expect(normalizeServerUrl('piwi.corp')).toBeNull();
    expect(normalizeServerUrl('https://')).toBeNull();
    expect(apiKeySecret('https://piwi.corp/')).toBe('piwi.apiKey https://piwi.corp');
  });

  test('an instance with a login asks for a key, and lists its projects with one', async () => {
    expect(await needsKey(base)).toBe(true);
    expect(await listProjects(base, 'pd_new')).toEqual([{ id: 7, name: 'Acme Mugs' }]);
  });

  test('the browser sign-in names the editor, waits, and hands over the key', async () => {
    const signIn = await startSignIn(base, { editor: 'Visual Studio Code', os: 'Linux' });
    expect(signIn.userCode).toBe('BCDF-GHJK');
    expect(started[started.length - 1]).toEqual({ editor: 'Visual Studio Code', os: 'Linux' });
    const waits: number[] = [];
    answers = [
      '{"status":"pending"}',
      '{"status":"slow_down","interval":10}',
      '{"status":"approved","apiKey":"pd_new"}',
    ];
    const result = await waitForSignIn(base, signIn, new AbortController().signal, async (ms) => {
      waits.push(ms);
    });
    expect(result).toEqual({ status: 'approved', apiKey: 'pd_new' });
    expect(waits).toEqual([5000, 5000, 10000]);
  });

  test('a denied or expired request ends the wait', async () => {
    const signIn: SignIn = { deviceCode: 'pdc_1', userCode: 'X', verificationUrl: base, interval: 5, expiresIn: 600 };
    answers = ['{"status":"denied"}'];
    expect(await waitForSignIn(base, signIn, new AbortController().signal, noWait)).toEqual({ status: 'denied' });
    answers = ['{"status":"expired"}'];
    expect(await waitForSignIn(base, signIn, new AbortController().signal, noWait)).toEqual({ status: 'expired' });
  });

  test('cancelling stops the wait', async () => {
    const signIn: SignIn = { deviceCode: 'pdc_1', userCode: 'X', verificationUrl: base, interval: 5, expiresIn: 600 };
    const cancel = new AbortController();
    const waiting = waitForSignIn(base, signIn, cancel.signal);
    cancel.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
  });
});

describe('connectFailure', () => {
  // The JetBrains plugin's Glue.connectFailure says the same, checked by GlueTest.
  const url = 'https://piwi.corp:8443';
  const fetchFailed = (cause: object) => Object.assign(new TypeError('fetch failed'), { cause });

  test('names a refused key, an address that is not Piwi and another status', () => {
    expect(connectFailure(new InstanceError(401), url)).toBe('the instance refused the key (401)');
    expect(connectFailure(new InstanceError(404), url)).toBe(
      "not a Piwi instance: nothing answers Piwi's requests at this address (404)",
    );
    expect(connectFailure(new InstanceError(502), url)).toBe('the instance answered 502');
  });

  test('names a certificate the editor does not trust by its host, and where to trust it', () => {
    const reason = connectFailure(fetchFailed({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self-signed' }), url);
    expect(reason.startsWith('VS Code does not trust the certificate of piwi.corp.')).toBe(true);
    expect(reason).toContain('NODE_EXTRA_CA_CERTS');
  });

  test('says why nothing answered, and falls back to the error’s own message', () => {
    expect(connectFailure(fetchFailed({ code: 'ECONNREFUSED' }), 'http://localhost:3000')).toBe(
      'nothing answers there. Is the instance running, on that port?',
    );
    expect(connectFailure(fetchFailed({ code: 'ENOTFOUND' }), 'https://piwi.example')).toBe(
      'unknown host piwi.example',
    );
    expect(connectFailure(Object.assign(new Error('aborted'), { name: 'TimeoutError' }), url)).toBe(
      'no answer within 15 seconds',
    );
    expect(connectFailure(new Error('boom'), url)).toBe('boom');
  });
});
