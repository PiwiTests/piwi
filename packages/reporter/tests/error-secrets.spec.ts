import { describe, it, afterEach, expect } from 'vitest';
import { HIDDEN_VALUE } from '@piwitests/core/mask';
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

/** A value in a credential's shape, built from parts so no scanner reads it as a live key. */
const KEY = ['pd_', 'a3'.repeat(32)].join('');
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2lnbmF0dXJl'].join('.');

describe('a failed test’s error, on the wire', () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('has each credential’s shape hidden: in its text, its steps’ errors and its hooks’ errors', async () => {
    let body: any;
    server = await startServer((req, res) => {
      if (req.url !== '/api/test-runs/submit') return textRes(res, 404, 'nope');
      body = JSON.parse(req.body);
      jsonRes(res, 200, { runId: 1, projectId: 1 });
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: `piwi-error-secrets-${process.pid}`,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'signs in', parent: suite });
    suite.allTests = () => [test];
    const message = [
      'Error: expect(received).toBe(expected) // Object.is equality',
      '',
      'Expected: "ok"',
      `Received: "${KEY}"`,
      `Error: 401 for Authorization Bearer ${JWT}`,
    ].join('\n');
    const steps = [
      {
        title: 'Before Hooks',
        category: 'hook',
        startTime: new Date(0),
        duration: 5,
        error: { message: `Error: seeding failed with ${KEY}` },
        steps: [],
      },
      {
        title: 'Expect "toBe"',
        category: 'expect',
        startTime: new Date(5),
        duration: 1,
        error: { message },
        steps: [],
      },
    ];
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestBegin(test, fakeResult({}));
    reporter.onTestEnd(test, { ...fakeResult({ status: 'failed', steps }), errors: [{ message }] });
    await reporter.onEnd({ status: 'failed' } as any);

    const [sent] = body.testCases;
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(KEY);
    expect(wire).not.toContain(JWT);
    expect(sent.error).toContain(`Received: "${HIDDEN_VALUE}"`);
    expect(sent.error).toContain(`Error: 401 for Authorization Bearer ${HIDDEN_VALUE}`);
    expect(sent.steps.find((s: { title: string }) => s.title === 'Expect "toBe"').error.message).toBe(sent.error);
    expect(sent.stepEvents.find((e: { title: string }) => e.title === 'Before Hooks').error).toBe(
      `Error: seeding failed with ${HIDDEN_VALUE}`,
    );
  });
});
