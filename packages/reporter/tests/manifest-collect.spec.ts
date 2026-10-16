import { describe, it, expect } from 'vitest';
import {
  parseManifestJson,
  hasInstrumentationHeader,
  configDirFromConfig,
  fetchInstrumentationManifest,
  fetchOriginManifest,
  instrumentationManifestUrls,
  type FetchLike,
} from '../src/internal/manifest/collect';

describe('parseManifestJson', () => {
  it('parses routes and pages, dropping malformed entries', () => {
    const manifest = parseManifestJson(
      JSON.stringify({
        routes: [
          { method: 'GET', pattern: '/api/cart', responses: [200, 'x'] },
          { method: 'POST' }, // no pattern — dropped
          'nope',
        ],
        pages: [{ pattern: '/checkout', name: 'Checkout' }, {}],
      }),
    );
    expect(manifest?.routes).toHaveLength(1);
    expect(manifest?.routes?.[0]).toMatchObject({ method: 'GET', pattern: '/api/cart', responses: [200] });
    expect(manifest?.pages).toHaveLength(1);
  });

  it('returns null for invalid JSON or an empty manifest', () => {
    expect(parseManifestJson('not json')).toBeNull();
    expect(parseManifestJson('{}')).toBeNull();
  });
});

describe('hasInstrumentationHeader', () => {
  it('detects the instrumentation markers on a plain header object', () => {
    expect(hasInstrumentationHeader({ 'x-piwi-logs': 'abc' })).toBe(true);
    expect(hasInstrumentationHeader({ 'x-piwi-trace': 'abc' })).toBe(true);
    expect(hasInstrumentationHeader({ 'content-type': 'text/html' })).toBe(false);
  });

  it('works with a Headers instance', () => {
    const headers = new Headers({ 'x-piwi-logs': 'abc' });
    expect(hasInstrumentationHeader(headers)).toBe(true);
  });
});

describe('configDirFromConfig', () => {
  it('prefers the config file directory for the committed manifest', () => {
    expect(configDirFromConfig({ configFile: '/repo/playwright.config.ts' })).toBe('/repo');
    expect(configDirFromConfig({ rootDir: '/repo/tests' })).toBe('/repo/tests');
  });
});

describe('fetchInstrumentationManifest', () => {
  it('fetches /__piwi/manifest only when the base response is instrumented', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/__piwi/manifest')) {
        return { ok: true, status: 200, headers: {}, text: async () => JSON.stringify({ routes: [{ method: 'GET', pattern: '/api/cart' }] }) };
      }
      return { ok: true, status: 200, headers: { 'x-piwi-trace': 'abc' }, text: async () => '' };
    };
    const manifest = await fetchInstrumentationManifest('https://app.test', fetchImpl);
    expect(manifest?.routes?.[0]?.pattern).toBe('/api/cart');
  });

  it('returns null when the base response carries no instrumentation header', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, headers: {}, text: async () => '' });
    expect(await fetchInstrumentationManifest('https://app.test', fetchImpl)).toBeNull();
  });

  it('passes an abort signal so a slow base URL never hangs the run', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      signals.push(init?.signal);
      if (url.endsWith('/__piwi/manifest')) {
        return { ok: true, status: 200, headers: {}, text: async () => JSON.stringify({ routes: [{ method: 'GET', pattern: '/api/cart' }] }) };
      }
      return { ok: true, status: 200, headers: { 'x-piwi-trace': 'abc' }, text: async () => '' };
    };
    await fetchInstrumentationManifest('https://app.test', fetchImpl);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it('fetches under the base URL path first, then at the origin root', async () => {
    expect(instrumentationManifestUrls('https://app.test')).toEqual(['https://app.test/__piwi/manifest']);
    expect(instrumentationManifestUrls('https://app.test/')).toEqual(['https://app.test/__piwi/manifest']);
    expect(instrumentationManifestUrls('https://app.test/shop/')).toEqual([
      'https://app.test/shop/__piwi/manifest',
      'https://app.test/__piwi/manifest',
    ]);
    expect(instrumentationManifestUrls('https://app.test/shop')).toEqual([
      'https://app.test/shop/__piwi/manifest',
      'https://app.test/__piwi/manifest',
    ]);
  });

  it('falls back to the origin root when the base path serves no manifest, even with an HTML page', async () => {
    const requested: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      requested.push(url);
      if (url === 'https://app.test/shop/__piwi/manifest') {
        return { ok: true, status: 200, headers: {}, text: async () => '<!doctype html><title>Shop</title>' };
      }
      if (url === 'https://app.test/__piwi/manifest') {
        return { ok: true, status: 200, headers: {}, text: async () => JSON.stringify({ routes: [{ method: 'GET', pattern: '/api/cart' }] }) };
      }
      return { ok: true, status: 200, headers: { 'x-piwi-logs': 'abc' }, text: async () => '' };
    };
    const manifest = await fetchInstrumentationManifest('https://app.test/shop/', fetchImpl);
    expect(manifest?.routes?.[0]?.pattern).toBe('/api/cart');
    expect(requested).toEqual(['https://app.test/shop/', 'https://app.test/shop/__piwi/manifest', 'https://app.test/__piwi/manifest']);
  });

  it('returns null when a request rejects (e.g. an aborted timeout)', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new DOMException('The operation was aborted.', 'TimeoutError');
    };
    expect(await fetchInstrumentationManifest('https://app.test', fetchImpl)).toBeNull();
  });
});

describe('fetchOriginManifest', () => {
  it('fetches the manifest at the origin root with no probe', async () => {
    const requested: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      requested.push(url);
      return { ok: true, status: 200, headers: {}, text: async () => JSON.stringify({ routes: [{ method: 'GET', pattern: '/api/cart' }] }) };
    };
    const manifest = await fetchOriginManifest('http://localhost:5282', fetchImpl);
    expect(manifest?.routes?.[0]?.pattern).toBe('/api/cart');
    expect(requested).toEqual(['http://localhost:5282/__piwi/manifest']);
  });

  it('returns null for a page that is not a manifest, or a failed request', async () => {
    const html: FetchLike = async () => ({ ok: true, status: 200, headers: {}, text: async () => '<!doctype html>' });
    expect(await fetchOriginManifest('http://localhost:5282', html)).toBeNull();
    const notFound: FetchLike = async () => ({ ok: false, status: 404, headers: {}, text: async () => '' });
    expect(await fetchOriginManifest('http://localhost:5282', notFound)).toBeNull();
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await fetchOriginManifest('http://localhost:5282', down)).toBeNull();
  });
});
