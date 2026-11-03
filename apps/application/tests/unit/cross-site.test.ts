import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiError } from '../../server/utils/api-error';
import { CROSS_SITE_REFUSED_WITHOUT_AUTH_MESSAGE, isCrossSiteWrite } from '../../server/utils/cross-site';

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../server/utils/auth', () => ({ isAuthEnabled: () => auth.enabled }));

describe('isCrossSiteWrite', () => {
  test('refuses state-changing requests a browser sends from another site', () => {
    expect(isCrossSiteWrite({ method: 'POST', secFetchSite: 'cross-site', origin: 'https://evil.example' })).toBe(true);
    expect(isCrossSiteWrite({ method: 'DELETE', secFetchSite: 'same-site', origin: 'https://a.example.com' })).toBe(
      true,
    );
    expect(isCrossSiteWrite({ method: 'patch', secFetchSite: 'cross-site', origin: null })).toBe(true);
    expect(
      isCrossSiteWrite({
        method: 'POST',
        secFetchSite: 'cross-site',
        origin: 'https://evil.example',
        authEnabled: true,
      }),
    ).toBe(true);
  });

  test('allows reads, same-origin requests and requests without browser metadata', () => {
    expect(isCrossSiteWrite({ method: 'GET', secFetchSite: 'cross-site' })).toBe(false);
    expect(isCrossSiteWrite({ method: 'OPTIONS', secFetchSite: 'cross-site' })).toBe(false);
    expect(isCrossSiteWrite({ method: 'POST', secFetchSite: 'same-origin' })).toBe(false);
    expect(isCrossSiteWrite({ method: 'POST', secFetchSite: 'none' })).toBe(false);
    expect(isCrossSiteWrite({ method: 'POST' })).toBe(false);
  });

  test('allows the browser extension', () => {
    expect(isCrossSiteWrite({ method: 'POST', secFetchSite: 'cross-site', origin: 'chrome-extension://abc' })).toBe(
      false,
    );
    expect(isCrossSiteWrite({ method: 'PUT', secFetchSite: 'cross-site', origin: 'moz-extension://uuid' })).toBe(false);
  });

  test('keeps judging by Sec-Fetch-Site when a browser sends it', () => {
    const own = { host: 'piwi.example.com' };
    expect(
      isCrossSiteWrite({ method: 'POST', secFetchSite: 'same-origin', origin: 'https://evil.example', ...own }),
    ).toBe(false);
    expect(
      isCrossSiteWrite({ method: 'POST', secFetchSite: 'cross-site', origin: 'https://piwi.example.com', ...own }),
    ).toBe(true);
    expect(
      isCrossSiteWrite({
        method: 'POST',
        secFetchSite: 'cross-site',
        origin: 'https://evil.example',
        allowedHosts: '*',
      }),
    ).toBe(true);
  });

  describe('a browser that sends no Sec-Fetch-Site, with authentication off', () => {
    const write = (origin: string | null, extra: Partial<Parameters<typeof isCrossSiteWrite>[0]> = {}) =>
      isCrossSiteWrite({ method: 'POST', origin, host: 'localhost:7494', authEnabled: false, ...extra });

    test('is refused when its Origin is another site', () => {
      expect(write('https://evil.example')).toBe(true);
      expect(write('http://localhost:7495')).toBe(true);
      expect(write('http://sub.localhost:7494')).toBe(true);
      expect(write('null')).toBe(true);
      expect(write('not an origin')).toBe(true);
      expect(write('https://evil.example', { host: null })).toBe(true);
    });

    test("is allowed from the request's own origin", () => {
      expect(write('http://localhost:7494')).toBe(false);
      expect(write('HTTP://LOCALHOST:7494')).toBe(false);
      expect(write('http://piwi.lan', { host: 'piwi.lan:80' })).toBe(false);
      expect(write('https://piwi.example.com', { host: 'piwi.example.com' })).toBe(false);
      expect(write('https://piwi.example.com', { host: 'piwi.example.com:443' })).toBe(false);
      expect(write('http://[::1]:7494', { host: '[::1]:7494' })).toBe(false);
    });

    test('compares the host and port alone, as behind a proxy that terminates TLS', () => {
      expect(write('https://localhost:7494')).toBe(false);
      expect(write('https://piwi.example.com', { host: 'piwi.example.com' })).toBe(false);
      expect(write('https://piwi.example.com', { host: 'piwi.example.com:80' })).toBe(true);
      expect(write('https://piwi.example.com:8443', { host: 'piwi.example.com' })).toBe(true);
      expect(write('https://evil.example', { host: 'piwi.example.com' })).toBe(true);
      expect(write('https://piwi.example.com', { host: 'evil.example@piwi.example.com' })).toBe(true);
    });

    test('is allowed from the host of PIWI_SITE_URL, as behind a proxy that rewrites Host', () => {
      const behindProxy = { host: '127.0.0.1:3000', siteUrl: 'http://piwi.corp/' };
      expect(write('http://piwi.corp', behindProxy)).toBe(false);
      expect(write('https://piwi.corp', behindProxy)).toBe(false);
      expect(write('http://piwi.corp:8080', behindProxy)).toBe(true);
      expect(write('http://evil.example', behindProxy)).toBe(true);
      expect(write('http://piwi.corp', { ...behindProxy, siteUrl: 'not a url' })).toBe(true);
    });

    test('is allowed from a host name PIWI_ALLOWED_HOSTS allows, whatever the port', () => {
      const behindProxy = { host: '127.0.0.1:3000', allowedHosts: 'piwi.corp, .example.lan' };
      expect(write('http://piwi.corp', behindProxy)).toBe(false);
      expect(write('http://PIWI.CORP:8080', behindProxy)).toBe(false);
      expect(write('http://example.lan', behindProxy)).toBe(false);
      expect(write('http://piwi.example.lan:3000', behindProxy)).toBe(false);
      expect(write('http://evil.piwi.corp', behindProxy)).toBe(true);
      expect(write('http://evilexample.lan', behindProxy)).toBe(true);
      expect(write('http://evil.example', behindProxy)).toBe(true);
    });

    test('is refused from another origin whatever the entry * of PIWI_ALLOWED_HOSTS', () => {
      expect(write('http://evil.example', { host: '127.0.0.1:3000', allowedHosts: '*' })).toBe(true);
      expect(write('http://evil.example', { host: '127.0.0.1:3000', allowedHosts: '*, evil.example' })).toBe(false);
      expect(write('http://localhost:7494', { allowedHosts: '*' })).toBe(false);
      expect(write('null', { allowedHosts: '*' })).toBe(true);
      expect(write('not an origin', { allowedHosts: '*' })).toBe(true);
    });

    test('is allowed from the browser extension', () => {
      expect(write('chrome-extension://abc')).toBe(false);
      expect(write('safari-web-extension://uuid')).toBe(false);
    });

    test('is never refused for a read', () => {
      expect(isCrossSiteWrite({ method: 'GET', origin: 'https://evil.example', host: 'localhost:7494' })).toBe(false);
    });
  });

  test('judges a browser that sends no Sec-Fetch-Site by nothing else with authentication on', () => {
    const write = (origin: string, host: string | null) =>
      isCrossSiteWrite({ method: 'POST', origin, host, authEnabled: true });
    expect(write('http://piwi.corp', '127.0.0.1:3000')).toBe(false);
    expect(write('http://piwi.corp', 'piwi:3000')).toBe(false);
    expect(write('http://piwi.corp', null)).toBe(false);
    expect(write('null', 'localhost:7494')).toBe(false);
  });

  test('allows a request with neither header, as servers, the reporter and CLIs send', () => {
    expect(isCrossSiteWrite({ method: 'POST', host: 'localhost:7494' })).toBe(false);
    expect(isCrossSiteWrite({ method: 'DELETE', origin: null, host: 'piwi.example.com' })).toBe(false);
  });
});

describe('the cross-site middleware', () => {
  interface FakeEvent {
    method: string;
    node: { req: { headers: Record<string, string> } };
  }

  beforeEach(() => {
    auth.enabled = false;
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl: '' } }));
    vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.node.req.headers[name]);
    vi.stubGlobal('apiError', apiError);
    vi.stubEnv('PIWI_SITE_URL', '');
    vi.stubEnv('PIWI_ALLOWED_HOSTS', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const call = async (headers: Record<string, string>) => {
    const middleware = (await import('../../server/middleware/cross-site')).default as unknown as (
      event: FakeEvent,
    ) => unknown;
    try {
      middleware({ method: 'POST', node: { req: { headers } } });
      return null;
    } catch (error) {
      return error as { statusCode: number; message: string };
    }
  };

  const proxied = { host: '127.0.0.1:3000', origin: 'http://piwi.corp' };

  test('accepts a write from the address a proxy rewrote with authentication on', async () => {
    auth.enabled = true;
    expect(await call(proxied)).toBeNull();
    expect(await call({ ...proxied, 'sec-fetch-site': 'cross-site' })).toMatchObject({
      statusCode: 403,
      message: 'Cross-site requests are not accepted',
    });
  });

  test('refuses it with authentication off, naming PIWI_SITE_URL and PIWI_ALLOWED_HOSTS', async () => {
    const refused = await call(proxied);
    expect(refused).toMatchObject({ statusCode: 403, message: CROSS_SITE_REFUSED_WITHOUT_AUTH_MESSAGE });
    expect(refused?.message).toContain('PIWI_SITE_URL');
    expect(refused?.message).toContain('PIWI_ALLOWED_HOSTS');
  });

  test('accepts it with authentication off once PIWI_SITE_URL or PIWI_ALLOWED_HOSTS names the host', async () => {
    vi.stubEnv('PIWI_SITE_URL', 'http://piwi.corp');
    expect(await call(proxied)).toBeNull();
    vi.stubEnv('PIWI_SITE_URL', '');
    vi.stubEnv('PIWI_ALLOWED_HOSTS', 'piwi.corp');
    expect(await call(proxied)).toBeNull();
    expect(await call({ ...proxied, origin: 'http://evil.example' })).toMatchObject({ statusCode: 403 });
  });
});
