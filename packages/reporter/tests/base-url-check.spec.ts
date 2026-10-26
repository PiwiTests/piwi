import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import {
  baseUrlTargets,
  checkBaseUrl,
  checkBaseUrls,
  cliProjectNames,
  exposeNetworkCovers,
  remoteBrowserNote,
  selectedProjects,
  type BaseUrlProbe,
  type ProbeOutcome,
} from '../src/internal/support/base-url-check.js';

const PW = ['node', '/app/node_modules/.bin/playwright', 'test'];

/** A local server answering every request with `status`, or one that is closed when `status` is null. */
async function serve(status: number | null): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status ?? 200);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  if (status === null) await close();
  return { url: `http://127.0.0.1:${port}/`, close: status === null ? async () => {} : close };
}

/** A probe answering from a script, one outcome per call. */
function scripted(...outcomes: ProbeOutcome[]): BaseUrlProbe & { calls: number } {
  const probe = Object.assign(
    async () => {
      probe.calls++;
      return outcomes[Math.min(probe.calls, outcomes.length) - 1]!;
    },
    { calls: 0 },
  );
  return probe;
}

const target = {
  url: 'https://staging.example.test/',
  projects: ['chromium'],
  ignoreHTTPSErrors: false,
  remoteBrowser: false,
};
const fast = { delayMs: 0 };

describe('which projects the run selects', () => {
  it('reads --project in both forms, and none when it is absent', () => {
    expect(cliProjectNames([...PW])).toBeNull();
    expect(cliProjectNames([...PW, '--project=chromium'])).toEqual(['chromium']);
    expect(cliProjectNames([...PW, '--project', 'chromium', 'firefox', '--headed'])).toEqual(['chromium', 'firefox']);
  });

  it('matches names case-insensitively, with * as a wildcard, and adds their dependencies', () => {
    const projects = [
      { name: 'setup' },
      { name: 'Chromium', dependencies: ['setup'] },
      { name: 'mobile-safari' },
      { name: 'mobile-chrome' },
    ];
    const names = (argv: string[]) => selectedProjects(projects, argv).map((p) => p.name);
    expect(names([...PW, '--project', 'chromium'])).toEqual(['setup', 'Chromium']);
    expect(names([...PW, '--project', 'chromium', '--no-deps'])).toEqual(['Chromium']);
    expect(names([...PW, '--project=mobile-*'])).toEqual(['mobile-safari', 'mobile-chrome']);
    expect(names([...PW])).toHaveLength(4);
  });

  it("takes Playwright's filteredProjects over the command line, and adds their dependencies", () => {
    const setup = { name: 'setup' };
    const chromium = { name: 'chromium', dependencies: ['setup'] };
    const slow = { name: 'slow' };
    const projects = [setup, chromium, slow];
    const names = (argv: string[], filtered: object[]) => selectedProjects(projects, argv, filtered).map((p) => p.name);
    expect(names([...PW], [chromium])).toEqual(['setup', 'chromium']);
    expect(names([...PW, '--no-deps'], [chromium])).toEqual(['chromium']);
    expect(names([...PW, '--project=chromium'], [{ name: 'slow' }])).toEqual(['slow']);
    expect(names([...PW], [])).toEqual([]);
  });

  it('matches an unnamed project in filteredProjects by identity only', () => {
    const selected = {};
    const other = { default: false };
    expect(selectedProjects([selected, other], PW, [selected])).toEqual([selected]);
  });
});

describe('baseUrlTargets', () => {
  it('lists each base URL once, with the projects that use it and their request options', () => {
    const config = {
      projects: [
        { name: 'chromium', use: { baseURL: 'https://staging.example.test', ignoreHTTPSErrors: true } },
        { name: 'firefox', use: { baseURL: 'https://staging.example.test' } },
        { name: 'api', use: { baseURL: 'https://api.example.test', proxy: { server: 'http://proxy:3128' } } },
        { name: 'setup', use: {} },
        { name: 'files', use: { baseURL: 'file:///tmp/site' } },
      ],
    };
    expect(baseUrlTargets(config, PW)).toEqual([
      {
        url: 'https://staging.example.test',
        projects: ['chromium', 'firefox'],
        ignoreHTTPSErrors: true,
        proxy: undefined,
        remoteBrowser: false,
      },
      {
        url: 'https://api.example.test',
        projects: ['api'],
        ignoreHTTPSErrors: false,
        proxy: { server: 'http://proxy:3128' },
        remoteBrowser: false,
      },
    ]);
    expect(baseUrlTargets(config, [...PW, '--project=api']).map((t) => t.url)).toEqual(['https://api.example.test']);
  });

  it('leaves out a project declared default: false that the run does not select', () => {
    const chromium = { name: 'chromium', use: { baseURL: 'https://staging.example.test' } };
    const slow = { name: 'slow', default: false, use: { baseURL: 'https://perf.example.test' } };
    const config = { projects: [chromium, slow], filteredProjects: [chromium] };
    expect(baseUrlTargets(config, PW).map((t) => t.url)).toEqual(['https://staging.example.test']);
  });

  it('flags a base URL a remote browser reaches from its own network', () => {
    const grid = { wsEndpoint: 'ws://grid.example.test:3000/' };
    const config = {
      projects: [
        { name: 'local', use: { baseURL: 'http://localhost:3000', connectOptions: { ...grid, exposeNetwork: '<loopback>' } } },
        { name: 'staging', use: { baseURL: 'https://staging.example.test', connectOptions: grid } },
        { name: 'firefox', use: { baseURL: 'https://staging.example.test' } },
        { name: 'api', use: { baseURL: 'https://api.example.test' } },
      ],
    };
    const remote = (env: NodeJS.ProcessEnv) =>
      Object.fromEntries(baseUrlTargets(config, PW, env).map((t) => [t.url, t.remoteBrowser]));
    expect(remote({})).toEqual({
      'http://localhost:3000': false,
      'https://staging.example.test': true,
      'https://api.example.test': false,
    });
    expect(remote({ PW_TEST_CONNECT_WS_ENDPOINT: 'ws://other.example.test/' })).toEqual({
      'http://localhost:3000': true,
      'https://staging.example.test': true,
      'https://api.example.test': true,
    });
    expect(
      remote({ PW_TEST_CONNECT_WS_ENDPOINT: 'ws://other.example.test/', PW_TEST_CONNECT_EXPOSE_NETWORK: '*.example.test' }),
    ).toEqual({
      'http://localhost:3000': true,
      'https://staging.example.test': false,
      'https://api.example.test': false,
    });
  });
});

describe('exposeNetworkCovers', () => {
  const covers = (rule: string | undefined, ...urls: string[]) => urls.map((url) => exposeNetworkCovers(rule, url));

  it('covers nothing without a rule', () => {
    expect(covers(undefined, 'http://localhost/')).toEqual([false]);
    expect(covers('', 'http://localhost/')).toEqual([false]);
  });

  it('covers every host with *, and every host on one port with *:port', () => {
    expect(covers('*', 'https://app.example.test/', 'http://10.0.0.5:8080/')).toEqual([true, true]);
    expect(covers('*:443', 'https://app.example.test/', 'http://app.example.test/')).toEqual([true, false]);
  });

  it('covers the loopback names and addresses with <loopback>', () => {
    expect(
      covers(
        '<loopback>',
        'http://localhost:3000/',
        'http://app.localhost/',
        'http://127.0.0.1:8080/',
        'http://[::1]:3000/',
        'http://127.0.0.2/',
        'http://app.example.test/',
      ),
    ).toEqual([true, true, true, true, false, false]);
    expect(covers('<loopback>:3000', 'http://localhost:3000/', 'http://localhost:3001/')).toEqual([true, false]);
  });

  it('matches host names with wildcards, never an IP address', () => {
    expect(covers('*.example.test', 'https://app.example.test/', 'https://example.test/')).toEqual([true, false]);
    expect(covers('.example.test', 'https://app.example.test/')).toEqual([true]);
    expect(covers('app.example.test', 'https://app.example.test/', 'https://api.example.test/')).toEqual([true, false]);
    expect(covers('127.0.0.*', 'http://127.0.0.1/')).toEqual([false]);
  });

  it('matches an IP address exactly', () => {
    expect(covers('10.0.0.5', 'http://10.0.0.5:8080/', 'http://10.0.0.6/')).toEqual([true, false]);
    expect(covers('10.0.0.5:8080', 'http://10.0.0.5:8080/', 'http://10.0.0.5:9090/')).toEqual([true, false]);
  });

  it("compares a rule's port with the URL's, 80 or 443 when it names none", () => {
    expect(covers('app.example.test:80', 'http://app.example.test/', 'https://app.example.test/')).toEqual([true, false]);
    expect(covers('app.example.test:443', 'https://app.example.test/')).toEqual([true]);
  });

  it('covers a host that any entry of a comma-separated list covers', () => {
    expect(covers('<loopback>,*.example.test:443', 'http://localhost/', 'https://app.example.test/')).toEqual([
      true,
      true,
    ]);
    expect(covers('<loopback>,*.example.test:443', 'http://app.example.test/')).toEqual([false]);
  });
});

describe('checkBaseUrl', () => {
  it('any answer counts, a redirect or a 404 included', async () => {
    for (const status of [200, 302, 401, 404, 500]) {
      expect(await checkBaseUrl(target, { ...fast, probe: scripted({ status }) })).toBeNull();
    }
  });

  it("a gateway's 502, 503 or 504 does not, after every attempt", async () => {
    const probe = scripted({ status: 503 });
    expect(await checkBaseUrl(target, { ...fast, probe })).toBe('503 service unavailable (3 attempts)');
    expect(probe.calls).toBe(3);
  });

  it('an app that comes back on a later attempt answered', async () => {
    const probe = scripted({ error: 'connect ECONNREFUSED 10.0.0.5:443' }, { status: 200 });
    expect(await checkBaseUrl(target, { ...fast, probe })).toBeNull();
    expect(probe.calls).toBe(2);
  });

  it('through Playwright: a live server answers, a gateway error and a closed port do not', async () => {
    const live = await serve(404);
    const gateway = await serve(502);
    const closed = await serve(null);
    try {
      const options = { attempts: 1, timeoutMs: 5000, delayMs: 0 };
      expect(await checkBaseUrl({ ...target, url: live.url }, options)).toBeNull();
      expect(await checkBaseUrl({ ...target, url: gateway.url }, options)).toBe('502 bad gateway (1 attempt)');
      expect(await checkBaseUrl({ ...target, url: closed.url }, options)).toMatch(/ECONNREFUSED/);
    } finally {
      await live.close();
      await gateway.close();
    }
  });
});

describe('checkBaseUrls', () => {
  const config = {
    projects: [
      { name: 'chromium', use: { baseURL: 'https://staging.example.test' } },
      { name: 'api', use: { baseURL: 'https://api.example.test' } },
    ],
  };

  it('resolves with what it checked when every base URL answers', async () => {
    const checked = await checkBaseUrls(config, { ...fast, argv: PW, probe: scripted({ status: 200 }) });
    expect(checked.map((t) => t.url)).toEqual(['https://staging.example.test', 'https://api.example.test']);
  });

  it('throws a message naming each base URL that did not answer and how to run anyway', async () => {
    const probe: BaseUrlProbe = async (t) =>
      t.url.includes('api') ? { status: 200 } : { error: 'getaddrinfo ENOTFOUND staging.example.test' };
    const error = await checkBaseUrls(config, { ...fast, argv: PW, attempts: 1, probe }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      [
        '[Piwi Dashboard] The app under test did not answer, so no test ran:',
        '  https://staging.example.test (chromium): getaddrinfo ENOTFOUND staging.example.test (1 attempt)',
        'Bring the environment back and run again, or set checkBaseUrl: false (PIWI_CHECK_BASE_URL=false) to run the tests anyway.',
      ].join('\n'),
    );
    expect((error as Error).stack).toBe((error as Error).message);
  });

  it('says when a remote browser reaches a base URL from its own network', async () => {
    const remote = {
      projects: [
        { name: 'grid', use: { baseURL: 'https://staging.example.test', connectOptions: { wsEndpoint: 'ws://grid/' } } },
      ],
    };
    const probe = scripted({ error: 'getaddrinfo ENOTFOUND staging.example.test' });
    const error = await checkBaseUrls(remote, { ...fast, argv: PW, env: {}, attempts: 1, probe }).catch((e: Error) => e);
    expect((error as Error).message.split('\n').slice(1, 3)).toEqual([
      '  https://staging.example.test (grid): getaddrinfo ENOTFOUND staging.example.test (1 attempt)',
      "    The check ran from this machine's network, but the remote browser (connectOptions) reaches staging.example.test from its own, since exposeNetwork does not cover that host.",
    ]);
    expect(remoteBrowserNote(target)).toBeNull();
  });

  it('has nothing to check without a base URL', async () => {
    const probe = scripted({ error: 'unreachable' });
    expect(await checkBaseUrls({ projects: [{ name: 'unit', use: {} }] }, { argv: PW, probe })).toEqual([]);
    expect(probe.calls).toBe(0);
  });
});
