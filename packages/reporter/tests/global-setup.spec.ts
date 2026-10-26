import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { createGlobalSetup } from '../src/public/global-setup.js';
import { getSetupFilePath, readSetupInfo } from '../src/internal/support/setup-file.js';
import {
  ariaSampleIdentity,
  clearAriaSampleFile,
  loadAriaSampleSet,
  resetAriaSampleCache,
} from '../src/internal/support/aria-sampling.js';

interface RecordedReq {
  method: string;
  url: string;
  body: string;
}

function startServer(
  handler: (req: RecordedReq, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string; requests: RecordedReq[] }> {
  const requests: RecordedReq[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const rec: RecordedReq = { method: req.method ?? 'GET', url: req.url ?? '/', body };
      requests.push(rec);
      handler(rec, res);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no addr'));
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, requests });
    });
  });
}

function jsonRes(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

const PIWI_REPORTER_ENTRY: [string, Record<string, unknown>] = ['@piwitests/reporter', {}];

/** Delete a project's setup file if the test didn't consume it via readSetupInfo. */
function cleanupSetupFile(projectName: string): void {
  const p = getSetupFilePath(projectName);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

describe('createGlobalSetup', () => {
  const cleanupNames: string[] = [];
  afterEach(() => {
    for (const name of cleanupNames.splice(0)) {
      cleanupSetupFile(name);
      clearAriaSampleFile(name);
    }
    resetAriaSampleCache();
  });

  it('fetches the green ARIA sample set at run start and stashes it for the workers', async () => {
    const { server, url } = await startServer((req, res) => {
      if (req.url === '/api/test-runs/setup') return jsonRes(res, 200, { runId: 5, setupToken: 't' });
      if (req.url === '/api/projects/menu') return jsonRes(res, 200, { items: [{ id: 9, name: 'sampling-project' }] });
      if (req.url === '/api/projects/9/aria-sampling')
        return jsonRes(res, 200, { tests: [{ filePath: 'tests/a.spec.ts', title: 'due for a sample' }] });
      return jsonRes(res, 404, {});
    });
    cleanupNames.push('sampling-project');
    process.env.PIWI_PROJECT_NAME = 'sampling-project';
    try {
      const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'sampling-project' });
      await setupFn({ reporter: [PIWI_REPORTER_ENTRY] });

      resetAriaSampleCache();
      const set = loadAriaSampleSet('sampling-project');
      expect(set).not.toBeNull();
      expect(set!.has(ariaSampleIdentity('tests/a.spec.ts', 'due for a sample'))).toBe(true);
    } finally {
      delete process.env.PIWI_PROJECT_NAME;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('leaves no sample set when the server predates the aria-sampling endpoint', async () => {
    const { server, url } = await startServer((req, res) => {
      if (req.url === '/api/test-runs/setup') return jsonRes(res, 200, { runId: 5, setupToken: 't' });
      if (req.url === '/api/projects/menu') return jsonRes(res, 200, { items: [{ id: 9, name: 'old-server' }] });
      return jsonRes(res, 404, {}); // aria-sampling unknown on an old server
    });
    cleanupNames.push('old-server');
    try {
      const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'old-server' });
      await setupFn({ reporter: [PIWI_REPORTER_ENTRY] });

      resetAriaSampleCache();
      expect(loadAriaSampleSet('old-server')).toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not fetch the sample set when sampleAriaOnPass is off', async () => {
    const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, { runId: 5, setupToken: 't' }));
    cleanupNames.push('sampling-off');
    try {
      const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'sampling-off', sampleAriaOnPass: false });
      await setupFn({ reporter: [PIWI_REPORTER_ENTRY] });
      expect(requests.some((r) => r.url.includes('aria-sampling') || r.url.includes('/menu'))).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("uploads the instrumentation manifest of every project's base URL", async () => {
    const instrumented = (pattern: string) =>
      startServer((req, res) => {
        if (req.url === '/__piwi/manifest') return jsonRes(res, 200, { routes: [{ method: 'GET', pattern }] });
        res.writeHead(200, { 'X-Piwi-Logs': 'H4sIAAAAAAAAA4uOBQApu0wNAgAAAA==' });
        res.end('<!doctype html>');
      });
    const shop = await instrumented('/cart');
    const admin = await instrumented('/users');
    const { server, url, requests } = await startServer((req, res) => {
      if (req.url === '/api/test-runs/setup') return jsonRes(res, 200, { runId: 5, setupToken: 't' });
      if (req.url === '/api/projects/menu') return jsonRes(res, 200, { items: [{ id: 9, name: 'two-apps' }] });
      return jsonRes(res, 200, {});
    });
    cleanupNames.push('two-apps');
    try {
      const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'two-apps', sampleAriaOnPass: false });
      await setupFn({
        reporter: [PIWI_REPORTER_ENTRY],
        projects: [{ use: { baseURL: shop.url } }, { use: { baseURL: admin.url } }, { use: { baseURL: shop.url } }],
      });

      const uploads = requests.filter((r) => r.url === '/api/projects/9/surface/manifest');
      const patterns = uploads.map((r) => JSON.parse(r.body).manifest.routes[0].pattern).sort();
      expect(patterns).toEqual(['/cart', '/users']);
    } finally {
      await Promise.all(
        [server, shop.server, admin.server].map((s) => new Promise<void>((r) => s.close(() => r()))),
      );
    }
  });

  it('registers the run and writes the setup file for the reporter to pick up', async () => {
    const { server, url, requests } = await startServer((_req, res) =>
      jsonRes(res, 200, { runId: 42, setupToken: 'tok-abc' }),
    );
    cleanupNames.push('global-setup-register');
    try {
      const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'global-setup-register' });
      await setupFn({ reporter: [PIWI_REPORTER_ENTRY] });

      expect(requests.filter((r) => r.url === '/api/test-runs/setup')).toHaveLength(1);
      expect(requests[0]!.method).toBe('POST');
      expect(requests[0]!.url).toBe('/api/test-runs/setup');
      const body = JSON.parse(requests[0]!.body);
      expect(body.projectName).toBe('global-setup-register');

      const info = readSetupInfo('global-setup-register');
      expect(info).toEqual({ runId: 42, setupToken: 'tok-abc', projectName: 'global-setup-register' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  describe('shard identity in the setup call', () => {
    async function setupBody(name: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
      const { server, url, requests } = await startServer((_req, res) =>
        jsonRes(res, 200, { runId: 3, setupToken: 't' }),
      );
      cleanupNames.push(name);
      try {
        const setupFn = createGlobalSetup({ serverUrl: url, projectName: name });
        await setupFn({ reporter: [PIWI_REPORTER_ENTRY], ...config });
        return JSON.parse(requests.find((r) => r.url === '/api/test-runs/setup')!.body);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }

    afterEach(() => {
      delete process.env.PIWI_SHARD;
    });

    it("reports Playwright's own --shard", async () => {
      const body = await setupBody('global-setup-pw-shard', { shard: { current: 2, total: 3 } });
      expect(body.shardIndex).toBe(2);
      expect(body.shardTotal).toBe(3);
    });

    it('reports the shard `piwi run --shard` leaves in PIWI_SHARD', async () => {
      process.env.PIWI_SHARD = '3/4';
      const body = await setupBody('global-setup-env-shard', { shard: null });
      expect(body.shardIndex).toBe(3);
      expect(body.shardTotal).toBe(4);
    });

    it('reports no shard for a run that is not one', async () => {
      const body = await setupBody('global-setup-no-shard', { shard: null });
      expect(body.shardIndex).toBeUndefined();
      expect(body.shardTotal).toBeUndefined();
    });
  });

  it('does nothing when no serverUrl is configured (and still chains userSetup)', async () => {
    let userSetupCalled = false;
    const setupFn = createGlobalSetup({ projectName: 'global-setup-no-url' }, async () => {
      userSetupCalled = true;
      return 'chained-result';
    });
    const result = await setupFn({ reporter: [PIWI_REPORTER_ENTRY] });
    expect(userSetupCalled).toBe(true);
    expect(result).toBe('chained-result');
  });

  it('respects enabled: false even when serverUrl is set', async () => {
    const { server, url, requests } = await startServer((_req, res) =>
      jsonRes(res, 200, { runId: 1, setupToken: 't' }),
    );
    try {
      const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'global-setup-disabled', enabled: false });
      await setupFn({ reporter: [PIWI_REPORTER_ENTRY] });
      expect(requests).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not register when the piwi reporter is absent from the Playwright config', async () => {
    const { server, url, requests } = await startServer((_req, res) =>
      jsonRes(res, 200, { runId: 1, setupToken: 't' }),
    );
    try {
      const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'global-setup-no-reporter' });
      await setupFn({ reporter: [['list', {}]] });
      expect(requests).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('swallows HTTP failures without throwing, and still chains userSetup', async () => {
    const { server, url } = await startServer((_req, res) => jsonRes(res, 500, { error: 'boom' }));
    try {
      let userSetupCalled = false;
      const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'global-setup-http-fail' }, async () => {
        userSetupCalled = true;
      });
      await expect(setupFn({ reporter: [PIWI_REPORTER_ENTRY] })).resolves.not.toThrow();
      expect(userSetupCalled).toBe(true);
      expect(readSetupInfo('global-setup-http-fail')).toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not register when Playwright runs in UI mode (still chains userSetup)', async () => {
    const { server, url, requests } = await startServer((_req, res) =>
      jsonRes(res, 200, { runId: 1, setupToken: 't' }),
    );
    const savedArgv = process.argv;
    process.argv = ['node', 'playwright', 'test', '--ui'];
    try {
      let userSetupCalled = false;
      const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'global-setup-ui-mode' }, async () => {
        userSetupCalled = true;
        return 'chained-result';
      });
      const result = await setupFn({ reporter: [PIWI_REPORTER_ENTRY] });
      expect(requests).toHaveLength(0);
      expect(userSetupCalled).toBe(true);
      expect(result).toBe('chained-result');
      expect(readSetupInfo('global-setup-ui-mode')).toBeNull();
    } finally {
      process.argv = savedArgv;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not register when Playwright runs in list mode (still chains userSetup)', async () => {
    const { server, url, requests } = await startServer((_req, res) =>
      jsonRes(res, 200, { runId: 1, setupToken: 't' }),
    );
    const savedArgv = process.argv;
    process.argv = ['node', 'playwright', 'test', '--list'];
    try {
      let userSetupCalled = false;
      const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'global-setup-list-mode' }, async () => {
        userSetupCalled = true;
        return 'chained-result';
      });
      const result = await setupFn({ reporter: [PIWI_REPORTER_ENTRY] });
      expect(requests).toHaveLength(0);
      expect(userSetupCalled).toBe(true);
      expect(result).toBe('chained-result');
      expect(readSetupInfo('global-setup-list-mode')).toBeNull();
    } finally {
      process.argv = savedArgv;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('extracts serverUrl/projectName from an inline reporter entry when no options are passed', async () => {
    const { server, url, requests } = await startServer((_req, res) =>
      jsonRes(res, 200, { runId: 7, setupToken: 'ttt' }),
    );
    cleanupNames.push('global-setup-inline');
    try {
      const setupFn = createGlobalSetup();
      await setupFn({ reporter: [['@piwitests/reporter', { serverUrl: url, projectName: 'global-setup-inline' }]] });

      expect(requests.filter((r) => r.url === '/api/test-runs/setup')).toHaveLength(1);
      const body = JSON.parse(requests[0]!.body);
      expect(body.projectName).toBe('global-setup-inline');
      expect(readSetupInfo('global-setup-inline')?.runId).toBe(7);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  describe('checkBaseUrl', () => {
    /** A port nothing listens on. */
    async function closedPortUrl(): Promise<string> {
      const { server, url } = await startServer(() => {});
      await new Promise<void>((r) => server.close(() => r()));
      return url;
    }

    it('stops the run before registering it when the base URL does not answer', async () => {
      const { server, url, requests } = await startServer((_req, res) =>
        jsonRes(res, 200, { runId: 3, setupToken: 't' }),
      );
      cleanupNames.push('base-url-down');
      const baseURL = await closedPortUrl();
      let userSetupCalled = false;
      try {
        const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'base-url-down', checkBaseUrl: true }, () => {
          userSetupCalled = true;
        });
        const config = { reporter: [PIWI_REPORTER_ENTRY], projects: [{ name: 'chromium', use: { baseURL } }] };
        await expect(setupFn(config)).rejects.toThrow(
          `[Piwi Dashboard] The app under test did not answer, so no test ran:\n  ${baseURL} (chromium): connect ECONNREFUSED`,
        );
        expect(requests).toHaveLength(0);
        expect(readSetupInfo('base-url-down')).toBeNull();
        expect(userSetupCalled).toBe(false);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }, 20_000);

    it('registers the run as usual when the base URL answers', async () => {
      const { server, url, requests } = await startServer((req, res) =>
        req.url === '/' ? jsonRes(res, 404, {}) : jsonRes(res, 200, { runId: 4, setupToken: 't' }),
      );
      cleanupNames.push('base-url-up');
      try {
        const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'base-url-up', checkBaseUrl: true });
        await setupFn({
          reporter: [PIWI_REPORTER_ENTRY],
          projects: [{ name: 'chromium', use: { baseURL: `${url}/` } }],
        });
        expect(requests.map((r) => r.url)).toContain('/api/test-runs/setup');
        expect(requests[0]!.url).toBe('/');
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('says so when a remote browser reaches the base URL from its own network', async () => {
      const { server, url } = await startServer((_req, res) => jsonRes(res, 200, { runId: 6, setupToken: 't' }));
      cleanupNames.push('base-url-remote');
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => void logs.push(msg));
      try {
        const setupFn = createGlobalSetup({ serverUrl: url, projectName: 'base-url-remote', checkBaseUrl: true });
        const connectOptions = { wsEndpoint: 'ws://grid.example.test/' };
        await setupFn({ reporter: [PIWI_REPORTER_ENTRY], projects: [{ name: 'grid', use: { baseURL: `${url}/`, connectOptions } }] });
        expect(logs.some((l) => l.startsWith(`[Piwi Dashboard] Base URL answered: ${url}/. The check ran from`))).toBe(true);
      } finally {
        spy.mockRestore();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('is off by default, and PIWI_CHECK_BASE_URL turns it on', async () => {
      const { server, url, requests } = await startServer((_req, res) =>
        jsonRes(res, 200, { runId: 5, setupToken: 't' }),
      );
      cleanupNames.push('base-url-default');
      const baseURL = await closedPortUrl();
      const config = { reporter: [PIWI_REPORTER_ENTRY], projects: [{ name: 'chromium', use: { baseURL } }] };
      try {
        await createGlobalSetup({ serverUrl: url, projectName: 'base-url-default' })(config);
        expect(requests.filter((r) => r.url === '/api/test-runs/setup')).toHaveLength(1);

        process.env.PIWI_CHECK_BASE_URL = 'true';
        await expect(createGlobalSetup({ serverUrl: url, projectName: 'base-url-default' })(config)).rejects.toThrow(
          'The app under test did not answer',
        );
        expect(requests.filter((r) => r.url === '/api/test-runs/setup')).toHaveLength(1);
      } finally {
        delete process.env.PIWI_CHECK_BASE_URL;
        await new Promise<void>((r) => server.close(() => r()));
      }
    }, 20_000);
  });
});
