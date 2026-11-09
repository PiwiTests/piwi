import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { LIVE_VIEW_ENV } from '@piwitests/core/live-view';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { createGlobalSetup } from '../src/public/global-setup.js';
import { getSetupFilePath } from '../src/internal/support/setup-file.js';
import { recoveryFilePath } from '../src/internal/streaming/crash-recovery.js';
import {
  startServer,
  jsonRes,
  textRes,
  fakeConfig,
  fakeSuite,
  fakeTestCase,
  fakeResult,
  withoutCi,
  type FakeServer,
} from './_helpers.js';

/**
 * What the reporter says of the instance's live view as a run starts and goes on: why a run holds no key, by its real
 * cause, in a CI run's log and in `PIWI_LIVE_VIEW` for a run outside CI; which specs a CI run's live view covers; and
 * nothing at all for a run that merges blob reports.
 */

const projectName = 'piwi-live-lines-' + process.pid;
const KEY = `pdl_${'k'.repeat(43)}`;

/** A step of Playwright's reporter API, as the attempt lists it. */
const step = (category: string, title: string, steps: unknown[] = []) => ({ category, title, steps });
const calls = [step('pw:api', 'Navigate to "/shop"'), step('pw:api', "Click getByRole('button')")];
/** The steps of a test that imports `test` from a file extending the capture fixtures. */
const captured = [step('hook', 'Before Hooks', [step('fixture', 'Fixture "piwiCapture"')]), ...calls];
/** The steps of a test that imports `test` from `@playwright/test`. */
const uncaptured = [step('hook', 'Before Hooks', [step('fixture', 'Fixture "page"')]), ...calls];
/** The steps of a test of an API alone, from `@playwright/test`: no page to watch. */
const apiOnly = [step('hook', 'Before Hooks', [step('fixture', 'Fixture "request"')]), step('pw:api', 'GET "/api/cart"')];

/** How the instance answers the global setup's `/setup`. */
type Setup = 'key' | 'no-key' | 'down' | 'no-setup';

interface Heard {
  lines: string[];
  liveView: string | undefined;
}

describe('the live view lines of a run', () => {
  const env = { ...process.env };
  const argv = process.argv;
  let server: FakeServer | undefined;

  afterEach(async () => {
    process.env = { ...env };
    process.argv = argv;
    vi.restoreAllMocks();
    if (server) {
      fs.rmSync(recoveryFilePath(server.url, projectName), { force: true });
      await server.close();
    }
    server = undefined;
    fs.rmSync(getSetupFilePath(projectName), { force: true });
  });

  /**
   * Run four tests of three spec files, in CI or not, with the global setup answered as `setup` says, the files of
   * `uncapturedFiles` running without the capture fixtures: the reporter's lines, and what it named in
   * `PIWI_LIVE_VIEW` for the workers.
   */
  async function run(
    setup: Setup,
    opts: { ci: boolean; streaming?: boolean; uncapturedFiles?: string[]; apiFiles?: string[] },
  ): Promise<Heard> {
    const uncapturedFiles = opts.uncapturedFiles ?? ['plain', 'other'];
    const apiFiles = opts.apiFiles ?? [];
    process.env = withoutCi({ ...env });
    delete process.env[LIVE_VIEW_ENV];
    delete process.env.PIWI_PAUSE_AT;
    delete process.env.PIWI_RUN_CHANNEL;
    if (opts.ci) process.env.CI = 'true';
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/setup') {
        if (setup === 'down') return textRes(res, 503, 'Service Unavailable');
        return jsonRes(res, 200, { runId: 1, setupToken: 'setup', ...(setup === 'key' ? { liveView: { key: KEY } } : {}) });
      }
      if (req.url === '/api/test-runs/1/begin' || req.url === '/api/test-runs/start') {
        return jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      }
      if (req.url?.startsWith('/api/test-runs/1/') || req.url === '/api/test-runs/submit') {
        return jsonRes(res, 200, { runId: 1 });
      }
      textRes(res, 404, 'nope');
    });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void lines.push(String(line)));
    const options = { serverUrl: server.url, projectName, streaming: opts.streaming ?? true };
    if (setup !== 'no-setup') await createGlobalSetup(options)({ reporter: [['@piwitests/reporter', {}]] });
    const reporter = new PiwiDashboardReporter({
      ...options,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      captureResources: false,
      streamingBatchDelay: 50,
    });
    const suite = fakeSuite();
    const names = ['plain', 'plain', 'shop', 'other'];
    const tests = names.map((name, i) =>
      fakeTestCase({ id: `t${i}`, title: `t${i}`, parent: suite, file: `${process.cwd()}/tests/${name}.spec.ts` }),
    );
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig(), suite);
    const liveView = process.env[LIVE_VIEW_ENV];
    for (const [i, test] of tests.entries()) {
      reporter.onTestBegin(test, fakeResult({}));
      const steps = apiFiles.includes(names[i]!) ? apiOnly : uncapturedFiles.includes(names[i]!) ? uncaptured : captured;
      reporter.onTestEnd(test, fakeResult({ steps }));
    }
    await reporter.onEnd({ status: 'passed' } as never);
    return { lines: lines.filter((line) => /Live view|capture fixtures/.test(line)), liveView };
  }

  describe('in a CI run', () => {
    it("says the live view is on for the specs that use Piwi's fixtures, and names the first that does not", async () => {
      const { lines, liveView } = await run('key', { ci: true });
      expect(liveView).toBe(`${server!.url}/api/test-runs/1/live-view#${KEY}`);
      expect(lines).toEqual([
        "[Piwi Dashboard] Live view on for the specs that use Piwi's fixtures: people who may open this run can watch " +
          "their tests' pages on the dashboard while it runs. Nothing is stored.",
        "[Piwi Dashboard] tests/plain.spec.ts ran without Piwi's capture fixtures, so nobody can watch its tests live " +
          "on the dashboard: import `test` from your fixtures file (the one that extends piwiFixtures) instead of '@playwright/test'.",
        "[Piwi Dashboard] 1 more spec file ran without Piwi's capture fixtures, so nobody can watch their tests live " +
          'either: tests/other.spec.ts.',
      ]);
    });

    it('names no spec of an API alone, which has no page to watch', async () => {
      const { lines } = await run('key', { ci: true, uncapturedFiles: [], apiFiles: ['plain'] });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("Live view on for the specs that use Piwi's fixtures");
    });

    it('names no spec when every one uses the fixtures', async () => {
      const { lines } = await run('key', { ci: true, uncapturedFiles: [] });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("Live view on for the specs that use Piwi's fixtures");
    });

    it.each([
      ['no-key', /^\[Piwi Dashboard\] Live view off: .*Project → Settings → Live view/],
      ['no-setup', /^\[Piwi Dashboard\] Live view unavailable: the reporter's global setup did not register this run as it started \(wrapConfig adds it/],
      ['down', /^\[Piwi Dashboard\] Live view unavailable: the instance did not register this run as it started \(Request failed with status 503: Service Unavailable\)/],
    ] as const)('says why it has no live view when the global setup is %s, and names no spec', async (setup, line) => {
      const { lines, liveView } = await run(setup, { ci: true });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(line);
      expect(liveView).toBeUndefined();
    });

    it('says a run that does not stream has no live view, whatever its setup did', async () => {
      const { lines } = await run('no-setup', { ci: true, streaming: false });
      expect(lines).toEqual([
        '[Piwi Dashboard] Live view unavailable: this run does not stream its results (streaming: false), so nobody ' +
          'can watch its tests on the dashboard while it runs.',
      ]);
    });
  });

  describe('in a run outside CI', () => {
    it.each([
      ['no-key', true, 'none:off'],
      ['no-setup', true, 'none:unregistered'],
      ['down', true, 'none:setup-failed'],
      ['no-setup', false, 'none:streaming-off'],
    ] as const)('names why it cannot be shared live when the global setup is %s (streaming %s)', async (setup, streaming, why) => {
      const { lines, liveView } = await run(setup, { ci: false, streaming });
      expect(liveView).toBe(why);
      expect(lines).toEqual([]);
    });
  });

  it('says nothing of the live view in a run that merges blob reports', async () => {
    process.argv = ['node', '/path/to/playwright/cli.js', 'merge-reports', './blob-report'];
    const { lines, liveView } = await run('no-setup', { ci: true });
    expect(lines).toEqual([]);
    expect(liveView).toBeUndefined();
  });
});
