import { describe, it, afterEach, expect, vi } from 'vitest';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { startServer, jsonRes, textRes, fakeConfig, fakeSuite, fakeTestCase, fakeResult, type FakeServer } from './_helpers.js';

/** A step of Playwright's reporter API, as the attempt lists it. */
const step = (category: string, title: string, steps: unknown[] = []) => ({ category, title, steps });
const calls = [step('pw:api', 'Navigate to "/shop/login"'), step('pw:api', "Click getByRole('button')")];

describe('a spec that runs without the capture fixtures in a run that can stop', () => {
  let server: FakeServer | undefined;
  const env = { ...process.env };

  afterEach(async () => {
    process.env = { ...env };
    vi.restoreAllMocks();
    if (server) await server.close();
    server = undefined;
  });

  /** What the reporter warned while three tests of two specs ended, as `steps` shows each. */
  async function warnings(steps: (file: string) => unknown[]): Promise<string[]> {
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') jsonRes(res, 200, { runId: 1, projectId: 1 });
      else textRes(res, 404, 'nope');
    });
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => void warned.push(String(message)));
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-uncaptured-' + process.pid,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    const suite = fakeSuite();
    const tests = [
      fakeTestCase({ id: 'a', title: 'a', parent: suite, file: `${process.cwd()}/tests/plain.spec.ts` }),
      fakeTestCase({ id: 'b', title: 'b', parent: suite, file: `${process.cwd()}/tests/plain.spec.ts` }),
      fakeTestCase({ id: 'c', title: 'c', parent: suite, file: `${process.cwd()}/tests/captured.spec.ts` }),
    ];
    suite.allTests = () => tests;
    reporter.onBegin(fakeConfig(), suite);
    for (const test of tests) {
      reporter.onTestBegin(test, fakeResult({}));
      reporter.onTestEnd(test, fakeResult({ steps: steps(test.location.file) }));
    }
    await reporter.onEnd({ status: 'passed' } as any);
    return warned.filter((line) => line.includes('capture fixtures'));
  }

  const asTheyRan = (file: string) =>
    file.endsWith('captured.spec.ts')
      ? [step('hook', 'Before Hooks', [step('fixture', 'Fixture "piwiCapture"')]), ...calls]
      : [step('hook', 'Before Hooks', [step('fixture', 'Fixture "page"')]), ...calls];

  it('says once which spec cannot stop, and why', async () => {
    process.env.PIWI_PAUSE_AT = 'tests/plain.spec.ts:4';
    expect(await warnings(asTheyRan)).toEqual([
      "[Piwi Dashboard] tests/plain.spec.ts ran without Piwi's capture fixtures, so its tests never stop at a " +
        "breakpoint or at Pause: import `test` from your fixtures file (the one that extends piwiFixtures) instead of '@playwright/test'.",
    ]);
  });

  it('names the other specs in one line as the run ends, and reads no call of a hook that ran before the fixtures', async () => {
    process.env.PIWI_PAUSE_AT = 'tests/plain.spec.ts:4';
    const lines = await warnings((file) =>
      file.endsWith('captured.spec.ts') ? calls : [step('hook', 'Before Hooks', [step('fixture', 'Fixture "page"')]), ...calls],
    );
    expect(lines).toEqual([
      "[Piwi Dashboard] tests/plain.spec.ts ran without Piwi's capture fixtures, so its tests never stop at a " +
        "breakpoint or at Pause: import `test` from your fixtures file (the one that extends piwiFixtures) instead of '@playwright/test'.",
      "[Piwi Dashboard] 1 more spec file ran without Piwi's capture fixtures, so their tests never stop at a breakpoint " +
        'or at Pause either: tests/captured.spec.ts.',
    ]);
    // A beforeAll that called the page and failed: its test's own fixtures never ran.
    const failedHook = [step('hook', 'Before Hooks', [step('hook', 'beforeAll hook', [step('pw:api', 'GET "/health"')])])];
    expect(await warnings(() => failedHook)).toEqual([]);
  });

  it('says nothing in a run that cannot stop, or of a test that made no Playwright call', async () => {
    delete process.env.PIWI_PAUSE_AT;
    delete process.env.PIWI_RUN_CHANNEL;
    expect(await warnings(asTheyRan)).toEqual([]);
    process.env.PIWI_PAUSE_AT = 'tests/plain.spec.ts:4';
    expect(await warnings(() => [step('hook', 'Before Hooks')])).toEqual([]);
  });
});
