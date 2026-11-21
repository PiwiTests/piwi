import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/internal/manifest/collect';
import { RunManifests, instrumentedOrigins } from '../src/internal/manifest/run-manifests';
import { HttpClient } from '../src/internal/transport/http-client';
import { Logger } from '../src/internal/support/logger';
import { jsonRes, startServer, type FakeServer } from './_helpers';

const logger = new Logger(false);

function manifestFetch(byOrigin: Record<string, string[]>, requested: string[] = []): FetchLike {
  return async (url) => {
    requested.push(url);
    const routes = byOrigin[new URL(url).origin];
    if (!routes) return { ok: false, status: 404, headers: {}, text: async () => '' };
    const body = { routes: routes.map((pattern) => ({ method: 'GET', pattern })) };
    return { ok: true, status: 200, headers: {}, text: async () => JSON.stringify(body) };
  };
}

describe('instrumentedOrigins', () => {
  it('keeps the origins whose responses carried backend logs or spans', () => {
    const origins = instrumentedOrigins([
      { method: 'GET', url: 'http://localhost:5281/Dashboard', status: 200, duration: 1, serverLogs: [] },
      { method: 'GET', url: 'http://localhost:5282/api/x?y=1', status: 200, duration: 1, serverTraces: [] },
      { method: 'GET', url: 'http://localhost:5283/static', status: 200, duration: 1 },
      { method: 'GET', url: 'not a url', status: 200, duration: 1, serverLogs: [] },
    ]);
    expect([...origins]).toEqual(['http://localhost:5281', 'http://localhost:5282']);
  });

  it('is empty without requests', () => {
    expect(instrumentedOrigins(undefined).size).toBe(0);
  });
});

describe('RunManifests', () => {
  let dashboard: FakeServer | null = null;

  afterEach(async () => {
    await dashboard?.close();
    dashboard = null;
  });

  it('uploads the manifest of each instrumented origin the base URLs leave out, once', async () => {
    dashboard = await startServer((req, res) => {
      if (req.url === '/api/projects/menu') return jsonRes(res, 200, { items: [{ id: 7, name: 'Shop' }] });
      jsonRes(res, 200, {});
    });
    const requested: string[] = [];
    const manifests = new RunManifests(
      ['http://localhost:5281/'],
      logger,
      manifestFetch({ 'http://localhost:5282': ['/Commande'], 'http://localhost:5283': ['/Dossier'] }, requested),
    );
    manifests.note([
      { method: 'GET', url: 'http://localhost:5281/', status: 200, duration: 1, serverLogs: [] },
      { method: 'GET', url: 'http://localhost:5282/Commande', status: 200, duration: 1, serverLogs: [] },
    ]);
    // Fetched as soon as it is noted, while its server is up.
    expect(requested).toEqual(['http://localhost:5282/__piwi/manifest']);
    manifests.note([{ method: 'GET', url: 'http://localhost:5283/Dossier', status: 200, duration: 1, serverLogs: [] }]);
    manifests.note([{ method: 'GET', url: 'http://localhost:5282/Panier', status: 200, duration: 1, serverLogs: [] }]);

    await manifests.upload(new HttpClient(dashboard.url, logger), null, 'shop', 'feature/x');

    expect(requested).toEqual(['http://localhost:5282/__piwi/manifest', 'http://localhost:5283/__piwi/manifest']);
    const uploads = dashboard.requests.filter((r) => r.method === 'PUT');
    expect(uploads.map((r) => r.url)).toEqual(['/api/projects/7/surface/manifest', '/api/projects/7/surface/manifest']);
    expect(uploads.map((r) => JSON.parse(r.body))).toEqual([
      {
        source: 'instrumentation',
        branch: 'feature/x',
        manifest: { routes: [{ method: 'GET', pattern: '/Commande' }] },
      },
      {
        source: 'instrumentation',
        branch: 'feature/x',
        manifest: { routes: [{ method: 'GET', pattern: '/Dossier' }] },
      },
    ]);
  });

  it('uploads the manifest of an origin noted by the last test', async () => {
    dashboard = await startServer((req, res) => {
      if (req.url === '/api/projects/menu') return jsonRes(res, 200, { items: [{ id: 7, name: 'Shop' }] });
      jsonRes(res, 200, {});
    });
    const manifests = new RunManifests([], logger, manifestFetch({ 'http://localhost:5282': ['/Commande'] }));
    manifests.note([{ method: 'GET', url: 'http://localhost:5282/', status: 200, duration: 1, serverLogs: [] }]);

    await manifests.upload(new HttpClient(dashboard.url, logger), null, 'Shop', null);

    expect(dashboard.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });

  it('asks the dashboard nothing when no origin served a manifest', async () => {
    dashboard = await startServer((_req, res) => jsonRes(res, 200, {}));
    const manifests = new RunManifests([], logger, manifestFetch({}));
    manifests.note([{ method: 'GET', url: 'http://localhost:5282/', status: 200, duration: 1, serverLogs: [] }]);

    await manifests.upload(new HttpClient(dashboard.url, logger), null, 'Shop', null);

    expect(dashboard.requests).toHaveLength(0);
  });
});
