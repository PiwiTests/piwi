import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { HOST_REFUSED_MESSAGE, isAllowedHostWithoutAuth } from '../../server/utils/allowed-host';

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../server/utils/auth', () => ({ isAuthEnabled: () => auth.enabled }));

describe('isAllowedHostWithoutAuth', () => {
  test('answers an IP address, IPv6 in brackets', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:3000', '192.168.1.20:7494', '10.0.0.5', '[::1]', '[::1]:7494']) {
      expect(isAllowedHostWithoutAuth(host), host).toBe(true);
    }
    expect(isAllowedHostWithoutAuth('[fe80::1]:80')).toBe(true);
  });

  test('answers a name with no dot and a name under .localhost', () => {
    for (const host of ['localhost', 'localhost:7494', 'LOCALHOST:7494', 'piwi', 'piwi:3000', 'piwi_server', 'web-1']) {
      expect(isAllowedHostWithoutAuth(host), host).toBe(true);
    }
    for (const host of ['piwi.localhost', 'app.piwi.localhost:7494']) {
      expect(isAllowedHostWithoutAuth(host), host).toBe(true);
    }
  });

  test('refuses any other name', () => {
    for (const host of [
      'evil.example',
      'evil.example:7494',
      '127.0.0.1.nip.io',
      'localhost.evil.example',
      'xlocalhost.example',
      'localhost.',
      'piwi.internal',
    ]) {
      expect(isAllowedHostWithoutAuth(host), host).toBe(false);
    }
    expect(isAllowedHostWithoutAuth('evil-localhost.com')).toBe(false);
  });

  test('refuses a malformed Host', () => {
    for (const host of [
      '',
      ' ',
      '[::1',
      '[evil.example]',
      '[::1]:x',
      'localhost:x',
      'a@localhost',
      'localhost, evil.example',
    ]) {
      expect(isAllowedHostWithoutAuth(host), host).toBe(false);
    }
  });

  test('answers the host of PIWI_SITE_URL, whatever the port', () => {
    const siteUrl = 'https://Piwi.Example.com/dashboard';
    expect(isAllowedHostWithoutAuth('piwi.example.com', { siteUrl })).toBe(true);
    expect(isAllowedHostWithoutAuth('piwi.example.com:443', { siteUrl })).toBe(true);
    expect(isAllowedHostWithoutAuth('PIWI.EXAMPLE.COM', { siteUrl })).toBe(true);
    expect(isAllowedHostWithoutAuth('other.example.com', { siteUrl })).toBe(false);
    expect(isAllowedHostWithoutAuth('example.com', { siteUrl })).toBe(false);
    expect(isAllowedHostWithoutAuth('piwi.example.com', { siteUrl: 'not a url' })).toBe(false);
    expect(isAllowedHostWithoutAuth('piwi.example.com', { siteUrl: '' })).toBe(false);
  });

  test('answers the names PIWI_ALLOWED_HOSTS lists, whatever the port', () => {
    const allowedHosts = ' host.docker.internal , Piwi.Default.Svc.Cluster.Local:3000,piwi.lan ';
    for (const host of [
      'host.docker.internal',
      'host.docker.internal:3000',
      'HOST.DOCKER.INTERNAL',
      'piwi.default.svc.cluster.local',
      'piwi.default.svc.cluster.local:7494',
      'piwi.lan:3000',
    ]) {
      expect(isAllowedHostWithoutAuth(host, { allowedHosts }), host).toBe(true);
    }
    for (const host of ['docker.internal', 'evil.host.docker.internal', 'piwi.lan.evil.example', 'evil.example']) {
      expect(isAllowedHostWithoutAuth(host, { allowedHosts }), host).toBe(false);
    }
  });

  test('answers a domain and every name under it for an entry starting with a dot', () => {
    const allowedHosts = '.example.lan';
    for (const host of ['example.lan', 'piwi.example.lan', 'a.b.example.lan:3000']) {
      expect(isAllowedHostWithoutAuth(host, { allowedHosts }), host).toBe(true);
    }
    for (const host of ['evilexample.lan', 'example.lan.evil.example', 'other.lan']) {
      expect(isAllowedHostWithoutAuth(host, { allowedHosts }), host).toBe(false);
    }
  });

  test('answers every host for the entry *', () => {
    for (const allowedHosts of ['*', ' * ', 'piwi.lan, *']) {
      expect(isAllowedHostWithoutAuth('evil.example', { allowedHosts }), allowedHosts).toBe(true);
      expect(isAllowedHostWithoutAuth('not a host', { allowedHosts }), allowedHosts).toBe(true);
    }
  });

  test('ignores an entry that names no host', () => {
    for (const allowedHosts of ['.', '..', 'evil..example', '.com.', 'evil.example.', '*.example.lan', 'a b', '']) {
      for (const host of ['evil.example', 'evil.example.', 'x.example.lan', 'a.com.']) {
        expect(isAllowedHostWithoutAuth(host, { allowedHosts }), `${allowedHosts} → ${host}`).toBe(false);
      }
    }
  });

  test('answers a request with no Host, which no browser sends', () => {
    expect(isAllowedHostWithoutAuth(undefined)).toBe(true);
    expect(isAllowedHostWithoutAuth(null)).toBe(true);
  });
});

describe('the allowed-host middleware', () => {
  interface FakeEvent {
    node: { req: { headers: Record<string, string> } };
    status?: number;
    headers?: Record<string, string>;
  }

  beforeEach(() => {
    auth.enabled = false;
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: '' } }));
    vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.node.req.headers[name]);
    vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => void (event.status = status));
    vi.stubGlobal('setResponseHeaders', (event: FakeEvent, headers: Record<string, string>) => {
      event.headers = headers;
    });
    vi.stubEnv('PIWI_SITE_URL', '');
    vi.stubEnv('PIWI_ALLOWED_HOSTS', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const call = async (headers: Record<string, string>) => {
    const middleware = (await import('../../server/middleware/allowed-host')).default as unknown as (
      event: FakeEvent,
    ) => unknown;
    const event: FakeEvent = { node: { req: { headers } } };
    return { body: middleware(event), event };
  };

  test('refuses another host with a plain 403 when authentication is off', async () => {
    const { body, event } = await call({ host: 'rebound.example:7494', 'x-forwarded-host': 'localhost' });
    expect(body).toBe(HOST_REFUSED_MESSAGE);
    expect(event.status).toBe(403);
    expect(event.headers?.['Content-Type']).toBe('text/plain; charset=utf-8');
  });

  test('passes a local host, and the host of PIWI_SITE_URL', async () => {
    expect((await call({ host: '127.0.0.1:3000' })).body).toBeUndefined();
    expect((await call({ host: 'localhost:7494' })).body).toBeUndefined();
    vi.stubEnv('PIWI_SITE_URL', 'https://piwi.example.com');
    expect((await call({ host: 'piwi.example.com' })).body).toBeUndefined();
    vi.stubEnv('PIWI_SITE_URL', '');
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: 'https://piwi.example.com' } }));
    expect((await call({ host: 'piwi.example.com' })).body).toBeUndefined();
  });

  test('passes a name PIWI_ALLOWED_HOSTS lists', async () => {
    vi.stubEnv('PIWI_ALLOWED_HOSTS', 'host.docker.internal');
    expect((await call({ host: 'host.docker.internal:3000' })).body).toBeUndefined();
    expect((await call({ host: 'rebound.example' })).body).toBe(HOST_REFUSED_MESSAGE);
  });

  test('passes every host when authentication is on', async () => {
    auth.enabled = true;
    const { body, event } = await call({ host: 'piwi.example.com' });
    expect(body).toBeUndefined();
    expect(event.status).toBeUndefined();
  });
});
