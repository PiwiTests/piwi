import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  ciServerBaseUrlProblem,
  ciServerHosts,
  mayReachPrivateAddress,
  sendCiServerRequest,
  type OutgoingCiRequest,
} from '../../server/utils/ci-server-dispatch';

const ENV = ['PIWI_CI_SERVER_URL', 'PIWI_CI_SERVER_HOSTS', 'PIWI_DESKTOP_TOKEN', 'NUXT_PUBLIC_DESKTOP'];

let server: Server;
let base: string;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('{"number":7}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  for (const name of ENV) delete process.env[name];
  hits = 0;
});

const request = (): OutgoingCiRequest => ({
  method: 'POST',
  url: `${base}job/e2e/buildWithParameters`,
  headers: {},
  body: null,
  credential: null,
  droppedInputs: [],
});

describe('a private address', () => {
  test('is refused on a host the operator did not list', async () => {
    await expect(sendCiServerRequest(request())).rejects.toThrow('URL host is not allowed');
    expect(hits).toBe(0);
    expect(ciServerBaseUrlProblem(base)).toContain('PIWI_CI_SERVER_HOSTS');
  });

  test('is reached on a host PIWI_CI_SERVER_HOSTS lists', async () => {
    process.env.PIWI_CI_SERVER_HOSTS = 'jenkins.internal, 127.0.0.1';
    const answer = await sendCiServerRequest(request());
    expect(answer.status).toBe(201);
    expect(JSON.parse(answer.text)).toEqual({ number: 7 });
    expect(hits).toBe(1);
    expect(ciServerBaseUrlProblem(base)).toBeNull();
  });

  test('is reached on the host of PIWI_CI_SERVER_URL', async () => {
    process.env.PIWI_CI_SERVER_URL = base;
    expect(ciServerHosts()).toEqual([{ host: '127.0.0.1', port: new URL(base).port }]);
    expect((await sendCiServerRequest(request())).status).toBe(201);
  });

  test('is reached only on the port of PIWI_CI_SERVER_URL, or a port a listed entry names', () => {
    process.env.PIWI_CI_SERVER_URL = 'http://jenkins.internal:8080/';
    expect(mayReachPrivateAddress('http://jenkins.internal:8080/job/e2e/')).toBe(true);
    expect(mayReachPrivateAddress('http://jenkins.internal:7494/api/')).toBe(false);
    expect(mayReachPrivateAddress('http://jenkins.internal/')).toBe(false);
    process.env.PIWI_CI_SERVER_HOSTS = 'build.internal:9090, [::1]:8081';
    expect(mayReachPrivateAddress('http://build.internal:9090/')).toBe(true);
    expect(mayReachPrivateAddress('http://build.internal:9091/')).toBe(false);
    expect(mayReachPrivateAddress('http://[::1]:8081/')).toBe(true);
    expect(mayReachPrivateAddress('http://[::1]:8082/')).toBe(false);
  });

  test('a listed host:80 is reached on port 80 only', () => {
    process.env.PIWI_CI_SERVER_HOSTS = 'jenkins.internal:80, [fd00::1]:80, 10.0.0.5:443';
    expect(ciServerHosts()).toEqual([
      { host: 'jenkins.internal', port: '80' },
      { host: 'fd00::1', port: '80' },
      { host: '10.0.0.5', port: '443' },
    ]);
    expect(mayReachPrivateAddress('http://jenkins.internal/job/e2e/')).toBe(true);
    expect(mayReachPrivateAddress('http://jenkins.internal:6379/')).toBe(false);
    expect(mayReachPrivateAddress('https://jenkins.internal/')).toBe(false);
    expect(mayReachPrivateAddress('http://[fd00::1]:22/')).toBe(false);
    expect(mayReachPrivateAddress('https://10.0.0.5/')).toBe(true);
    expect(mayReachPrivateAddress('http://10.0.0.5/')).toBe(false);
  });

  test('an entry with anything besides a host and a port allows nothing', () => {
    process.env.PIWI_CI_SERVER_HOSTS =
      'jenkins.internal:8080/, jenkins.internal:8080?, jenkins.internal:8080#x, jenkins.internal:8080\\, jenkins.internal:, me@jenkins.internal';
    expect(ciServerHosts()).toEqual([]);
    expect(mayReachPrivateAddress('http://jenkins.internal:6379/')).toBe(false);
  });

  test('is reached from the desktop app', async () => {
    process.env.PIWI_DESKTOP_TOKEN = 'desktop';
    expect(mayReachPrivateAddress(base)).toBe(true);
    expect((await sendCiServerRequest(request())).status).toBe(201);
  });

  test('a host is matched whole, without its case', () => {
    process.env.PIWI_CI_SERVER_HOSTS = 'Jenkins.Internal';
    expect(mayReachPrivateAddress('http://jenkins.internal:8080/')).toBe(true);
    expect(mayReachPrivateAddress('http://jenkins.internal.attacker.example/')).toBe(false);
    expect(mayReachPrivateAddress('http://ci.jenkins.internal/')).toBe(false);
  });
});

describe('the base URL', () => {
  test('must be https on a host nobody listed', () => {
    expect(ciServerBaseUrlProblem('https://jenkins.example.com/')).toBeNull();
    expect(ciServerBaseUrlProblem('http://jenkins.example.com/')).toContain('https');
    expect(ciServerBaseUrlProblem(null)).toBe('No CI server is configured for this project.');
    expect(ciServerBaseUrlProblem('ftp://jenkins.example.com/')).toBe('No CI server is configured for this project.');
  });
});
