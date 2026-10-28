import { afterEach, describe, expect, it } from 'vitest';
import {
  ARIA_SNAPSHOT_CONTENT_TYPE,
  ATTACHMENT_NAMES,
  findPiwiAttachment,
  isPiwiAttachment,
} from '../src/internal/capture/attachments.js';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import {
  fakeConfig,
  fakeResult,
  fakeSuite,
  fakeTestCase,
  jsonRes,
  startServer,
  textRes,
  type FakeServer,
} from './_helpers.js';

/** An attachment as Playwright Test makes it from a browser server's `x-playwright-attachment` header. */
const fromHeader = (name: string, value: string) => ({ name, contentType: 'text/plain', body: Buffer.from(value) });

const json = (name: string, value: unknown) => ({
  name,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(value)),
});

describe('findPiwiAttachment', () => {
  it('takes the attachment of the name with the content type the capture fixtures write', () => {
    const real = json(ATTACHMENT_NAMES.locators, []);
    const attachments = [fromHeader(ATTACHMENT_NAMES.locators, '[{"x":1}]'), real];
    expect(findPiwiAttachment(attachments, ATTACHMENT_NAMES.locators)).toBe(real);
    expect(findPiwiAttachment([fromHeader(ATTACHMENT_NAMES.pauses, '[]')], ATTACHMENT_NAMES.pauses)).toBeUndefined();
    expect(findPiwiAttachment(undefined, ATTACHMENT_NAMES.pauses)).toBeUndefined();
  });

  it('takes the ARIA snapshot only with its own content type, never a text/plain one', () => {
    const real = {
      name: ATTACHMENT_NAMES.ariaSnapshot,
      contentType: ARIA_SNAPSHOT_CONTENT_TYPE,
      body: Buffer.from('- main'),
    };
    const attachments = [fromHeader(ATTACHMENT_NAMES.ariaSnapshot, '- grid'), real];
    expect(findPiwiAttachment(attachments, ATTACHMENT_NAMES.ariaSnapshot)).toBe(real);
    const alone = [fromHeader(ATTACHMENT_NAMES.ariaSnapshot, '- grid')];
    expect(findPiwiAttachment(alone, ATTACHMENT_NAMES.ariaSnapshot)).toBeUndefined();
    expect(isPiwiAttachment(json(ATTACHMENT_NAMES.ariaSnapshot, '- main'), ATTACHMENT_NAMES.ariaSnapshot)).toBe(false);
  });
});

describe('a test whose browser server sent piwi-* attachment headers', () => {
  let server: FakeServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('sends the capture fixtures’ data, never the headers’', async () => {
    let body: any;
    server = await startServer((req, res) => {
      if (req.url !== '/api/test-runs/submit') return textRes(res, 404, 'nope');
      body = JSON.parse(req.body);
      jsonRes(res, 200, { runId: 1, projectId: 1 });
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: `piwi-grid-headers-${process.pid}`,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      captureCodeReach: true,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'pays', parent: suite });
    suite.allTests = () => [test];
    const network = [{ url: 'https://shop.test/api/cart', method: 'GET', status: 200 }];
    const attachments = [
      fromHeader(ATTACHMENT_NAMES.network, '[{"url":"https://grid.test/"}]'),
      fromHeader(ATTACHMENT_NAMES.codeReach, '["src/grid.ts"]'),
      fromHeader(ATTACHMENT_NAMES.pauses, '[{"location":"tests/grid.spec.ts:3","startedAt":0,"duration":5}]'),
      json(ATTACHMENT_NAMES.network, network),
      json(ATTACHMENT_NAMES.codeReach, ['src/cart.ts']),
    ];
    const steps = [{ title: 'Click', category: 'pw:api', startTime: new Date(0), duration: 10, steps: [] }];
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestBegin(test, fakeResult({}));
    reporter.onTestEnd(test, fakeResult({ steps, attachments }));
    await reporter.onEnd({ status: 'passed' } as any);

    const [sent] = body.testCases;
    expect(sent.networkRequests).toEqual(network);
    expect(sent.codeReach).toEqual(['src/cart.ts']);
    expect((sent.stepEvents ?? []).some((event: { category: string }) => event.category === 'pause')).toBe(false);
  });

  it('sends no ARIA snapshot when the only one is a header’s', async () => {
    let body: any;
    server = await startServer((req, res) => {
      if (req.url !== '/api/test-runs/submit') return textRes(res, 404, 'nope');
      body = JSON.parse(req.body);
      jsonRes(res, 200, { runId: 1, projectId: 1 });
    });
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: `piwi-grid-aria-${process.pid}`,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    const suite = fakeSuite();
    const test = fakeTestCase({ title: 'pays', parent: suite });
    suite.allTests = () => [test];
    reporter.onBegin(fakeConfig(), suite);
    reporter.onTestBegin(test, fakeResult({}));
    reporter.onTestEnd(
      test,
      fakeResult({ attachments: [fromHeader(ATTACHMENT_NAMES.ariaSnapshot, '- heading "Grid"')] }),
    );
    await reporter.onEnd({ status: 'passed' } as any);

    const [sent] = body.testCases;
    expect(sent.ariaSnapshot).toBeNull();
  });
});
