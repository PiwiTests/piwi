import { afterEach, describe, expect, it } from 'vitest';
import { collectStepMetrics, extractTestStepEvents, pauseSpans } from '@piwitests/core/step-analysis';
import { pauseStepEvents, readPauses } from '../src/internal/collect/pause-events.js';
import type { PauseRecord } from '../src/internal/capture/pause-at.js';
import { ATTACHMENT_NAMES } from '../src/internal/capture/attachments.js';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { fakeConfig, fakeResult, fakeSuite, fakeTestCase, jsonRes, startServer, textRes, type FakeServer } from './_helpers.js';

function pause(line: number, startedAt: number, duration: number, reason: PauseRecord['reason'] = 'breakpoint') {
  return { title: 'Navigate', location: `tests/checkout.spec.ts:${line}:5`, reason, startedAt, duration };
}

describe('readPauses', () => {
  it('reads the attachment’s stops and nothing else', () => {
    const stops = [pause(4, 1_050, 5_000)];
    expect(readPauses(Buffer.from(JSON.stringify(stops)))).toEqual(stops);
    expect(readPauses(Buffer.from(JSON.stringify([...stops, { title: 'x' }, null])))).toEqual(stops);
    expect(readPauses(Buffer.from('{'))).toEqual([]);
    expect(readPauses(Buffer.from('{}'))).toEqual([]);
    expect(readPauses(undefined)).toEqual([]);
  });
});

describe('pauseStepEvents', () => {
  it('sends each stop as a pause step event: the held call, why it stopped and where', () => {
    expect(pauseStepEvents([pause(4, 1_050, 5_000), pause(9, 7_000, 300, 'step')])).toEqual([
      {
        title: 'Navigate',
        category: 'pause',
        startedAt: 1_050,
        duration: 5_000,
        status: 'breakpoint',
        location: 'tests/checkout.spec.ts:4:5',
      },
      {
        title: 'Navigate',
        category: 'pause',
        startedAt: 7_000,
        duration: 300,
        status: 'step',
        location: 'tests/checkout.spec.ts:9:5',
      },
    ]);
    expect(pauseStepEvents([])).toEqual([]);
  });

  it('keeps the steps on their clock, and the statistics read them without the stopped time', () => {
    const at = (ms: number) => new Date(ms);
    const steps = [
      { title: 'Before Hooks', category: 'hook', startTime: at(0), duration: 300, steps: [] },
      { title: 'Navigate', category: 'pw:api', startTime: at(300), duration: 4_100, params: { url: '/a' }, steps: [] },
      { title: 'Click', category: 'pw:api', startTime: at(4_450), duration: 50, steps: [] },
      { title: 'After Hooks', category: 'hook', startTime: at(4_550), duration: 100, steps: [] },
    ];
    const pauses = [pause(4, 350, 4_000)];
    const events = [...extractTestStepEvents(steps, at(0)), ...pauseStepEvents(pauses)];
    expect(events.map((e) => [e.title, e.category, e.startedAt, e.duration])).toEqual([
      ['Before Hooks', 'hook', 0, 300],
      ['After Hooks', 'hook', 4_550, 100],
      ['Navigate', 'pause', 350, 4_000],
    ]);
    // The dashboard reads the stops back from the step events it stores.
    const metrics = collectStepMetrics(steps, null, pauseSpans(events));
    expect(metrics.steps.map((s) => s.duration)).toEqual([300, 4_100, 50, 100]);
    expect(metrics.slowestStep).toEqual({ title: 'Before Hooks', duration: 300 });
    expect(metrics.navigationTotalDuration).toBe(100);
  });
});

describe('a test that stood paused, on the wire', () => {
  let server: FakeServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('sends its steps as measured, its stops with its step events, and its statistics without the stopped time', async () => {
    let body: any;
    server = await startServer((req, res) => {
      if (req.url !== '/api/test-runs/submit') return textRes(res, 404, 'nope');
      body = JSON.parse(req.body);
      jsonRes(res, 200, { runId: 1, projectId: 1 });
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: `piwi-paused-${process.pid}`,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'pays', parent: suite });
    suite.allTests = () => [test];
    const t0 = Date.parse('2024-01-01T00:00:00.000Z');
    const at = (ms: number) => new Date(t0 + ms);
    const steps = [
      { title: 'Before Hooks', category: 'hook', startTime: at(0), duration: 300, steps: [] },
      { title: 'Click', category: 'pw:api', startTime: at(300), duration: 4_100, steps: [] },
      { title: 'Wait for timeout', category: 'pw:api', startTime: at(4_400), duration: 200, steps: [] },
      { title: 'After Hooks', category: 'hook', startTime: at(4_600), duration: 100, steps: [] },
    ];
    const pauses = [{ ...pause(12, t0 + 350, 4_000), title: 'Click' }];
    const attachments = [
      { name: ATTACHMENT_NAMES.pauses, contentType: 'application/json', body: Buffer.from(JSON.stringify(pauses)) },
    ];
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestBegin(test, fakeResult({ startTime: at(0) }));
    reporter.onTestEnd(test, fakeResult({ startTime: at(0), duration: 700, steps, attachments }));
    await reporter.onEnd({ status: 'passed' } as any);

    const [sent] = body.testCases;
    expect(sent.duration).toBe(700);
    expect(sent.steps.map((s: { title: string; duration: number }) => [s.title, s.duration])).toEqual([
      ['Before Hooks', 300],
      ['Click', 4_100],
      ['Wait for timeout', 200],
      ['After Hooks', 100],
    ]);
    expect(sent.stepEvents).toContainEqual(
      expect.objectContaining({ category: 'pause', title: 'Click', startedAt: t0 + 350, duration: 4_000 }),
    );
    expect(sent.stepEvents.find((e: { title: string }) => e.title === 'After Hooks').startedAt).toBe(t0 + 4_600);
    expect([sent.slowestStep, sent.slowestStepDuration]).toEqual(['Before Hooks', 300]);
    expect(sent.wastedTimeMs).toBe(200);
  });
});
