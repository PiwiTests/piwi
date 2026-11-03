import { describe, test, expect } from 'vitest';
import { isCrossSiteWrite } from '../../server/utils/cross-site';

describe('isCrossSiteWrite', () => {
  test('refuses state-changing requests a browser sends from another site', () => {
    expect(isCrossSiteWrite({ method: 'POST', secFetchSite: 'cross-site', origin: 'https://evil.example' })).toBe(true);
    expect(isCrossSiteWrite({ method: 'DELETE', secFetchSite: 'same-site', origin: 'https://a.example.com' })).toBe(
      true,
    );
    expect(isCrossSiteWrite({ method: 'patch', secFetchSite: 'cross-site', origin: null })).toBe(true);
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
  });

  describe('a browser that sends no Sec-Fetch-Site', () => {
    const write = (origin: string | null, extra: Partial<Parameters<typeof isCrossSiteWrite>[0]> = {}) =>
      isCrossSiteWrite({ method: 'POST', origin, host: 'localhost:7494', ...extra });

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

    test('is allowed from the origin of PIWI_SITE_URL', () => {
      const behindProxy = { host: 'piwi:3000', siteUrl: 'https://piwi.example.com/' };
      expect(write('https://piwi.example.com', behindProxy)).toBe(false);
      expect(write('https://evil.example', behindProxy)).toBe(true);
      expect(write('http://piwi.example.com', behindProxy)).toBe(true);
    });

    test('is allowed from the browser extension', () => {
      expect(write('chrome-extension://abc')).toBe(false);
      expect(write('safari-web-extension://uuid')).toBe(false);
    });

    test('is never refused for a read', () => {
      expect(isCrossSiteWrite({ method: 'GET', origin: 'https://evil.example', host: 'localhost:7494' })).toBe(false);
    });
  });

  test('allows a request with neither header, as servers, the reporter and CLIs send', () => {
    expect(isCrossSiteWrite({ method: 'POST', host: 'localhost:7494' })).toBe(false);
    expect(isCrossSiteWrite({ method: 'DELETE', origin: null, host: 'piwi.example.com' })).toBe(false);
  });
});
