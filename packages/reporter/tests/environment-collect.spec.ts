import { afterEach, describe, it, expect } from 'vitest';
import { chromium } from '@playwright/test';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { attachBrowserEnvironment, readBrowserEnvironment } from '../src/internal/capture/browser-environment';
import {
  startServer,
  jsonRes,
  textRes,
  fakeConfig,
  fakeSuite,
  fakeTestCase,
  fakeResult,
  type FakeServer,
} from './_helpers.js';
import {
  ciImage,
  collectRunnerEnvironment,
  detectContainer,
  langVariables,
  prettyName,
  type RunnerSystem,
} from '../src/internal/collect/environment';
import { fetchEnvironment, parseServerEnvironment, type FetchLike } from '../src/internal/manifest/collect';
import { parseBrowserEnvironment, RunEnvironments, serverRestarted } from '../src/internal/collect/run-environments';
import { clockOffset } from '@piwitests/core/wire';

function system(overrides: Partial<RunnerSystem> = {}): RunnerSystem {
  return {
    platform: () => 'linux',
    release: () => '6.8.0-1017-azure',
    version: () => '#17~22.04.1-Ubuntu SMP',
    arch: () => 'x64',
    hostname: () => 'fv-az123-45',
    cpuModel: () => 'AMD EPYC 7763 64-Core Processor',
    cores: () => 4,
    totalMemory: () => 16 * 1024 ** 3,
    nodeVersion: 'v24.3.0',
    icuVersion: '77.1',
    osRelease: () => 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n',
    dockerEnv: () => false,
    intl: () => ({ timeZone: 'UTC', locale: 'en-US' }),
    utcOffsetMinutes: () => 0,
    ...overrides,
  };
}

describe('collectRunnerEnvironment', () => {
  it('reads the closed field list', () => {
    const snapshot = collectRunnerEnvironment({ TZ: 'UTC', LANG: 'C.UTF-8', SECRET: 'x' }, 2, system());
    expect(snapshot).toMatchObject({
      kind: 'runner',
      v: 1,
      shardIndex: 2,
      timeZone: 'UTC',
      tzVariable: 'UTC',
      locale: 'en-US',
      langVariables: 'LANG=C.UTF-8',
      os: 'linux 6.8 · Ubuntu 24.04.1 LTS',
      arch: 'x64',
      nodeVersion: 'v24.3.0',
      icuVersion: '77.1',
      container: null,
      cores: 4,
      hostname: 'fv-az123-45',
    });
    expect(JSON.stringify(snapshot)).not.toContain('SECRET');
  });

  it('records an unset TZ as null', () => {
    const snapshot = collectRunnerEnvironment(
      {},
      null,
      system({ intl: () => ({ timeZone: 'Europe/Paris', locale: 'fr-FR' }) }),
    );
    expect(snapshot.tzVariable).toBeNull();
    expect(snapshot.timeZone).toBe('Europe/Paris');
    expect(snapshot.langVariables).toBeNull();
  });

  it('falls back to the OS version without /etc/os-release, and survives a reader that throws', () => {
    const snapshot = collectRunnerEnvironment(
      {},
      null,
      system({
        osRelease: () => null,
        platform: () => 'darwin',
        release: () => '25.1.0',
        version: () => 'Darwin Kernel Version 25.1.0',
        cpuModel: () => {
          throw new Error('no cpus');
        },
      }),
    );
    expect(snapshot.os).toBe('darwin 25.1 · Darwin Kernel Version 25.1.0');
    expect(snapshot.cpuModel).toBeNull();
  });

  it('reads the distribution name with or without quotes', () => {
    expect(prettyName('PRETTY_NAME=Debian GNU/Linux 13')).toBe('Debian GNU/Linux 13');
    expect(prettyName("PRETTY_NAME='Alpine Linux v3.20'")).toBe('Alpine Linux v3.20');
    expect(prettyName('NAME=x')).toBeNull();
  });

  it('keeps only the locale variables that are set', () => {
    expect(langVariables({ LANG: 'fr_FR.UTF-8', LC_TIME: 'en_GB.UTF-8', LC_ALL: '' })).toBe(
      'LANG=fr_FR.UTF-8 LC_TIME=en_GB.UTF-8',
    );
  });
});

describe('ciImage', () => {
  it('reads the hosted image on GitHub Actions and Azure Pipelines', () => {
    expect(ciImage({ GITHUB_ACTIONS: 'true', ImageOS: 'ubuntu24', ImageVersion: '20261102.1' })).toBe(
      'ubuntu24 20261102.1',
    );
    expect(ciImage({ TF_BUILD: 'True', ImageOS: 'win22', ImageVersion: '20261101.2' })).toBe('win22 20261101.2');
  });

  it('falls back to the runner OS and architecture on a self-hosted GitHub runner', () => {
    expect(ciImage({ GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ARCH: 'ARM64' })).toBe('Linux ARM64');
  });

  it('reads the GitLab runner version and tags', () => {
    expect(ciImage({ GITLAB_CI: 'true', CI_RUNNER_VERSION: '17.5.0', CI_RUNNER_TAGS: '["docker"]' })).toBe(
      'runner 17.5.0 tags ["docker"]',
    );
  });

  it('is null for other providers and outside CI', () => {
    expect(ciImage({ JENKINS_URL: 'x', ImageOS: 'ubuntu24' })).toBeNull();
    expect(ciImage({ CIRCLECI: 'true' })).toBeNull();
    expect(ciImage({})).toBeNull();
  });
});

describe('detectContainer', () => {
  it('names Kubernetes, then Docker', () => {
    expect(detectContainer({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, { dockerEnv: () => true })).toBe('kubernetes');
    expect(detectContainer({}, { dockerEnv: () => true })).toBe('docker');
    expect(detectContainer({}, { dockerEnv: () => false })).toBeNull();
  });
});

describe('server environment', () => {
  const answer = {
    v: 1,
    runtime: '.NET 10.0.1',
    timeZone: 'UTC',
    instance: 'abc',
    startedAt: '2026-11-06T10:00:00.000Z',
    now: 10_050,
    connectionString: 'Server=db;Password=secret',
  };

  it('reads the listed fields only', () => {
    const parsed = parseServerEnvironment(JSON.stringify(answer));
    expect(parsed?.runtime).toBe('.NET 10.0.1');
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(parseServerEnvironment('{"v":2}')).toBeNull();
    expect(parseServerEnvironment('nope')).toBeNull();
  });

  it('measures the clock offset against the midpoint of the request', () => {
    expect(clockOffset(10_000, 10_040, 13_020)).toEqual({ clockOffsetMs: 3000, clockOffsetErrorMs: 20 });
  });

  it('builds the snapshot of an origin, and records nothing for a 404', async () => {
    let now = 10_000;
    const fetchImpl: FetchLike = async (url) => {
      now += 100;
      if (url.startsWith('http://old')) return { ok: false, status: 404, headers: {}, text: async () => '' };
      return { ok: true, status: 200, headers: {}, text: async () => JSON.stringify(answer) };
    };
    const snapshot = await fetchEnvironment('http://api.test', fetchImpl, () => now);
    expect(snapshot).toMatchObject({
      kind: 'server',
      origin: 'http://api.test',
      runtime: '.NET 10.0.1',
      clockOffsetMs: 0,
      clockOffsetErrorMs: 50,
    });
    expect(snapshot).not.toHaveProperty('now');
    expect(await fetchEnvironment('http://old.test', fetchImpl, () => now)).toBeNull();
  });

  it('tells a restart by the instance, else by a start time that moved', () => {
    expect(serverRestarted({ instance: 'a' }, { instance: 'b' })).toBe(true);
    expect(serverRestarted({ instance: 'a', startedAt: 'x' }, { instance: 'a', startedAt: 'y' })).toBe(false);
    expect(serverRestarted({ startedAt: '2026-11-06T10:00:00.000Z' }, { startedAt: '2026-11-06T10:00:00.900Z' })).toBe(
      false,
    );
    expect(serverRestarted({ startedAt: '2026-11-06T10:00:00.000Z' }, { startedAt: '2026-11-06T10:05:00.000Z' })).toBe(
      true,
    );
  });
});

describe('RunEnvironments', () => {
  const runner = collectRunnerEnvironment({}, 1, system());
  const browser = {
    kind: 'browser',
    v: 1,
    project: 'chromium',
    browserVersion: '141.0.7390.37',
    timeZone: 'UTC',
  };
  const attachment = (body: unknown) => ({
    name: 'piwi-environment',
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(body)),
  });

  it('keeps the first browser snapshot of each project, stamped with the shard', async () => {
    const run = new RunEnvironments(runner, [], async () => ({
      ok: false,
      status: 404,
      headers: {},
      text: async () => '',
    }));
    run.noteTestEnd([attachment(browser)]);
    run.noteTestEnd([attachment({ ...browser, browserVersion: 'other' })]);
    const all = await run.atEnd();
    expect(all.filter((s) => s.kind === 'browser')).toEqual([{ ...browser, shardIndex: 1 }]);
    expect(all[0]).toBe(runner);
  });

  it('reads each base URL once and marks a server that restarted', async () => {
    let instance = 'first';
    const calls: string[] = [];
    const run = new RunEnvironments(runner, ['http://app.test/shop/'], async (url) => {
      calls.push(url);
      const body = JSON.stringify({ v: 1, instance, now: Date.now() });
      return { ok: true, status: 200, headers: {}, text: async () => body };
    });
    run.noteTestEnd([]);
    run.noteTestEnd([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    instance = 'second';
    const servers = (await run.atEnd()).filter((s) => s.kind === 'server');
    expect(calls).toEqual(['http://app.test/__piwi/environment', 'http://app.test/__piwi/environment']);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ origin: 'http://app.test', instance: 'first', restarted: true });
  });

  it('ignores an attachment that is not a browser snapshot', () => {
    expect(parseBrowserEnvironment(Buffer.from('{"kind":"runner","v":1}'))).toBeNull();
    expect(parseBrowserEnvironment(Buffer.from('nope'))).toBeNull();
  });
});

describe('environments on the wire', () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  async function submit(options: Record<string, unknown> = {}): Promise<any> {
    let submitBody: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        submitBody = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 1, projectId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-environments-' + process.pid,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      ...options,
    });
    const suite = fakeSuite();
    const testCase = fakeTestCase({ title: 'formats a date', parent: suite });
    suite.allTests = () => [testCase];
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestBegin(testCase, fakeResult({ workerIndex: 0 }));
    const result = fakeResult({ status: 'passed', duration: 5, workerIndex: 0 });
    result.attachments = [
      {
        name: 'piwi-environment',
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ kind: 'browser', v: 1, project: 'chromium', timeZone: 'Asia/Tokyo' })),
      },
    ];
    reporter.onTestEnd(testCase, result);
    await reporter.onEnd({ status: 'passed' } as any);
    return submitBody;
  }

  it('sends the runner and each browser snapshot with the batch body', async () => {
    const body = await submit();
    const kinds = body.environments.map((s: { kind: string }) => s.kind);
    expect(kinds).toEqual(['runner', 'browser']);
    expect(body.environments[0].nodeVersion).toBe(process.version);
    expect(body.environments[1].timeZone).toBe('Asia/Tokyo');
  });

  it('sends none with collectEnvironmentInfo off', async () => {
    const body = await submit({ collectEnvironmentInfo: false });
    expect(body.environments).toBeUndefined();
  });
});

describe('the page read', () => {
  it('reports the emulated time zone and locale, read once per project', async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ timezoneId: 'Pacific/Auckland', locale: 'fr-FR' });
      const page = await context.newPage();
      const attached: Array<{ name: string; body: Buffer }> = [];
      const testInfo = {
        testId: 't1',
        project: { name: `env-read-${process.pid}`, use: { headless: true } },
        attach: async (name: string, { body }: { body: Buffer }) => void attached.push({ name, body }),
      } as never;
      await readBrowserEnvironment(page, testInfo);
      await readBrowserEnvironment(page, testInfo);
      await attachBrowserEnvironment(testInfo);
      expect(attached).toHaveLength(1);
      const snapshot = JSON.parse(attached[0]!.body.toString());
      expect(snapshot).toMatchObject({
        kind: 'browser',
        timeZone: 'Pacific/Auckland',
        locale: 'fr-FR',
        browserName: 'chromium',
        headless: true,
      });
      expect(snapshot.browserVersion).toBe(browser.version());
      expect(snapshot.formatSample).toContain('1 234,5');
    } finally {
      await browser.close();
    }
  });
});
