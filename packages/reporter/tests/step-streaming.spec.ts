import { describe, it, afterEach, expect } from 'vitest';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
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

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeStep(category: string, title = `step-${category}`): any {
  return {
    title,
    category,
    location: { file: '/tmp/test.spec.ts', line: 3, column: 4 },
    startTime: new Date('2024-01-01T00:00:00.000Z'),
    duration: 5,
    error: null,
  };
}

type EventsBody = { testCases: Array<Record<string, unknown>> };

/** Every event the fake dashboard received, across all `/events` batches. */
function streamed(bodies: EventsBody[]): Array<Record<string, unknown>> {
  return bodies.flatMap((b) => b.testCases ?? []);
}

describe('PiwiDashboardReporter live step streaming', () => {
  let server: FakeServer;
  const projectName = 'piwi-steps-' + process.pid;

  afterEach(async () => {
    if (server) await server.close();
  });

  /** A streaming reporter pointed at a fake dashboard that records every `/events` body. */
  async function startStreaming(): Promise<{ reporter: PiwiDashboardReporter; eventsBodies: EventsBody[] }> {
    const eventsBodies: EventsBody[] = [];
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        eventsBodies.push(JSON.parse(req.body));
        jsonRes(res, 200, {});
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 30,
      streamingBatchSize: 1,
    });
    return { reporter, eventsBodies };
  }

  it('streams pw:api and expect steps and skips test.step', async () => {
    const { reporter, eventsBodies } = await startStreaming();
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'the test', parent: suite });
    const result = fakeResult({ workerIndex: 0 });
    // Steps are fired straight after `onBegin`, while `/start` is still in
    // flight — the reporter must buffer them until the run id lands rather
    // than drop them, which is what real fixtures/hooks do at run start.
    reporter.onBegin(fakeConfig(), suite);

    reporter.onStepBegin(test, result, makeStep('pw:api'));
    reporter.onStepBegin(test, result, makeStep('test.step', 'no-step-begin'));
    reporter.onStepBegin(test, result, makeStep('expect'));
    const waitForBegins = async () =>
      waitFor(() => streamed(eventsBodies).filter((e) => e.type === 'step-begin').length >= 2).catch((e) => {
        throw new Error(
          `${(e as Error).message} — bodies=${JSON.stringify(eventsBodies)} urls=${server.requests.map((r) => r.url).join(',')}`,
        );
      });
    await waitForBegins();

    reporter.onStepEnd(test, result, makeStep('pw:api', 'ended-api'));
    reporter.onStepEnd(test, result, makeStep('test.step', 'no-step-end'));
    reporter.onStepEnd(test, result, makeStep('expect', 'ended-expect'));
    await waitFor(() => streamed(eventsBodies).filter((e) => e.type === 'step-end').length >= 2);

    const all = streamed(eventsBodies);
    const begins = all.filter((e) => e.type === 'step-begin');
    const ends = all.filter((e) => e.type === 'step-end');

    expect(begins.map((e) => e.stepCategory).sort()).toEqual(['expect', 'pw:api']);
    expect(begins.every((e) => e.parentTitle === 'the test')).toBeTruthy();
    expect(ends.map((e) => e.stepCategory).sort()).toEqual(['expect', 'pw:api']);
    expect(all.some((e) => e.title === 'no-step-begin')).toBeFalsy();
    expect(all.some((e) => e.title === 'no-step-end')).toBeFalsy();
  });

  it('streams an assertion step under the expect category Playwright reports', async () => {
    const { reporter, eventsBodies } = await startStreaming();
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'the test', parent: suite });
    const result = fakeResult({ workerIndex: 0 });
    reporter.onBegin(fakeConfig(), suite);

    // The step Playwright reports for `expect(page.getByLabel('Email')).toHaveValue(…)`.
    const assertion = { ...makeStep('expect', 'Expect "toHaveValue"'), subtitle: "getByLabel('Email')" };
    reporter.onStepBegin(test, result, assertion);
    reporter.onStepEnd(test, result, { ...assertion, error: { message: 'expect(locator).toHaveValue failed' } });
    await waitFor(() => streamed(eventsBodies).some((e) => e.type === 'step-end'));

    const all = streamed(eventsBodies);
    const live = {
      title: 'Expect "toHaveValue"',
      subtitle: "getByLabel('Email')",
      stepCategory: 'expect',
      parentTitle: 'the test',
      workerIndex: 0,
    };
    expect(all.find((e) => e.type === 'step-begin')).toMatchObject(live);
    expect(all.find((e) => e.type === 'step-end')).toMatchObject({ ...live, status: 'failed' });
  });

  it('skips the polling steps nested inside an assertion', async () => {
    const { reporter, eventsBodies } = await startStreaming();
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'the test', parent: suite });
    const result = fakeResult({ workerIndex: 0 });
    reporter.onBegin(fakeConfig(), suite);
    const begin = (step: any) => reporter.onStepBegin(test, result, step);
    const end = (step: any) => reporter.onStepEnd(test, result, step);

    // `expect.poll(() => page.evaluate(…)).toBe(3)`: every attempt nests a
    // `pw:api` call and an `expect` check under the outer assertion.
    const poll = makeStep('expect', 'Expect "poll toBe"');
    const pollCall = { ...makeStep('pw:api', 'Evaluate'), parent: poll };
    const pollCheck = { ...makeStep('expect', 'Expect "toBe"'), parent: poll, error: { message: 'Expected: 3' } };
    begin(poll);
    begin(pollCall);
    end(pollCall);
    begin(pollCheck);
    end(pollCheck);
    end(poll);

    // `toPass` retries a callback whose steps can sit deeper, under a `test.step`.
    const toPass = makeStep('expect', 'Expect "toPass"');
    const retryStep = { ...makeStep('test.step', 'submit the form'), parent: toPass };
    const retryClick = { ...makeStep('pw:api', 'Click'), parent: retryStep };
    begin(toPass);
    begin(retryStep);
    begin(retryClick);
    end(retryClick);
    end(retryStep);
    end(toPass);

    // Everything was queued before `/start` answered, so it lands in one batch.
    await waitFor(() => streamed(eventsBodies).filter((e) => e.type === 'step-end').length >= 2);

    const all = streamed(eventsBodies);
    const titles = (type: string) => all.filter((e) => e.type === type).map((e) => e.title);
    expect(titles('step-begin')).toEqual(['Expect "poll toBe"', 'Expect "toPass"']);
    expect(titles('step-end')).toEqual(['Expect "poll toBe"', 'Expect "toPass"']);
  });

  it('stops streaming steps once the dashboard says nobody watches the run', async () => {
    const eventsBodies: EventsBody[] = [];
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        eventsBodies.push(JSON.parse(req.body));
        jsonRes(res, 200, { success: true, processed: 1, watched: false });
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 30,
      streamingBatchSize: 1,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'the test', parent: suite });
    const result = fakeResult({ workerIndex: 0 });
    reporter.onBegin(fakeConfig(), suite);

    // Until the dashboard answers, steps stream as before.
    reporter.onStepBegin(test, result, makeStep('pw:api', 'before the answer'));
    await waitFor(() => (reporter as any).streamManager?.watched === false);

    reporter.onStepBegin(test, result, makeStep('pw:api', 'unwatched'));
    reporter.onStepEnd(test, result, makeStep('pw:api', 'unwatched'));
    reporter.onTestBegin(test, result);
    await waitFor(() => streamed(eventsBodies).some((e) => e.type === 'begin'));

    expect(streamed(eventsBodies).map((e) => `${e.type} ${e.title}`)).toEqual([
      'step-begin before the answer',
      'begin the test',
    ]);
  });

  it('sends the step a test is in when someone opens the run, though it began while nobody watched', async () => {
    const eventsBodies: EventsBody[] = [];
    let answers = 0;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        eventsBodies.push(JSON.parse(req.body));
        // Nobody watches at first; the run is open by the next request.
        jsonRes(res, 200, { success: true, processed: 1, watched: answers++ > 0 });
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 30,
      streamingBatchSize: 1,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'the test', parent: suite });
    const result = fakeResult({ workerIndex: 0 });
    reporter.onBegin(fakeConfig(), suite);

    reporter.onStepBegin(test, result, makeStep('pw:api', 'Navigate'));
    await waitFor(() => (reporter as any).streamManager?.watched === false);
    // The click the test waits in begins while nobody watches: it is not sent then.
    const stuck = makeStep('pw:api', "Click getByRole('button', { name: 'Continue' })");
    reporter.onStepBegin(test, result, stuck);
    reporter.onTestBegin(test, result);
    await waitFor(() => streamed(eventsBodies).filter((e) => e.type === 'step-begin').length >= 3);

    expect(streamed(eventsBodies).map((e) => `${e.type} ${e.title}`)).toEqual([
      'step-begin Navigate',
      'begin the test',
      'step-begin Navigate',
      "step-begin Click getByRole('button', { name: 'Continue' })",
    ]);
  });

  it('suite-level hooks keep parentTitle null and land in setupSteps', async () => {
    let finishBody = null as { setupSteps?: unknown[] } | null;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/start') {
        jsonRes(res, 200, { runId: 1, streamToken: 'tok' });
      } else if (req.url === '/api/test-runs/1/events') {
        jsonRes(res, 200, {});
      } else if (req.url === '/api/test-runs/1/finish') {
        finishBody = JSON.parse(req.body);
        jsonRes(res, 200, {});
      } else if (req.url === '/api/auth/me') {
        jsonRes(res, 200, {});
      } else {
        textRes(res, 404, 'nope');
      }
    });

    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName,
      streaming: true,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      streamingBatchDelay: 30,
      streamingBatchSize: 1,
    });

    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'the test', parent: suite });
    suite.allTests = () => [test];
    const result = fakeResult({ workerIndex: 0 });
    reporter.onBegin(fakeConfig(), suite);
    await waitFor(() => server.requests.some((r) => r.url === '/api/test-runs/start'));

    // Suite-level hook (no test): streamed as step events with parentTitle null
    // AND recorded as a setup step for the timeline.
    reporter.onStepBegin(undefined, result, makeStep('hook', 'beforeAll'));
    reporter.onStepEnd(undefined, result, makeStep('hook', 'beforeAll'));
    await reporter.onEnd({ status: 'passed' } as any);
    await waitFor(() => finishBody != null);

    const setup = finishBody?.setupSteps ?? [];
    expect(setup.some((s: any) => s.title === 'beforeAll' && s.category === 'hook')).toBeTruthy();
  });
});
