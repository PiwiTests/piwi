/**
 * Code from a stopped test, through the service: a fake worker on the run channel stopped in a spec or a page object,
 * the client's requests (`piwi/stopAction`, `piwi/stopRequests`, `piwi/locatorAtCaret`) and the code it is sent to
 * write (`piwi/stopCode`), a check made through a hand-off in its `check` mode, Piwi Picker's commands on the hub, and
 * what is refused.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { lineReader, parseHandoffToTest, type HandoffToTest } from '@piwitests/core/ide-recorder';
import { parseHubMessage, type HubAnswer, type HubMessage } from '@piwitests/core/run-hub';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import { RUN_TAKES, type RunTake } from '@piwitests/core/run-channel';
import type { LocatorAtCaretResult, StopActionResult, StopRequestsResult } from '../src/protocol';
import { FakeWorker, last, service, waitFor, writeRunWorkspace, type Service } from './run-fixtures';

const SPEC = [
  "import { test } from '@playwright/test';",
  '',
  "test('pays', async ({ page }) => {",
  "  await page.goto('/cart');",
  "  await page.getByRole('button', { name: 'Pay' }).click();",
  '});',
  '',
].join('\n');

const PAGE_OBJECT = [
  "import { expect, type Page } from '@playwright/test';",
  '',
  'export class CheckoutPage {',
  '  constructor(private readonly page: Page) {}',
  '',
  '  async pay() {',
  "    await this.page.getByRole('button', { name: 'Pay' }).click();",
  '  }',
  '}',
  '',
].join('\n');

const KEPT = {
  id: 1,
  method: 'GET',
  url: 'http://localhost:3000/api/cart',
  status: 200,
  type: 'application/json',
  size: 12,
  time: 840,
};
const RESPONSE = { method: 'GET', url: KEPT.url, status: 200, type: 'application/json', body: '{"items":[]}' };
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

let dir = '';
let dist = '';
const uri = (file: string) => pathToFileURL(path.join(dir, file)).href;

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-stop-actions-')));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  // The spec the fixture's command runs, beside the files the tests stop in.
  writeRunWorkspace(dir);
  write('tests/checkout.spec.ts', SPEC);
  write('tests/pages/checkout.page.ts', PAGE_OBJECT);
  // What a check needs from the service's dist: the recorder's bundle and its catalogs.
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-stop-dist-'));
  fs.writeFileSync(path.join(dist, 'record-ide.js'), '// the recorder\n');
  fs.writeFileSync(path.join(dist, 'record-ide-messages.json'), '{"en":{}}');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

/** A worker of a fresh run, attached, running a test, stopped at `file`:`line` (1-based). */
async function stoppedWorker(
  svc: Service,
  file: string,
  line: number,
  bar: boolean,
  takes: RunTake[] = [...RUN_TAKES],
  reason: 'breakpoint' | 'failure' = 'breakpoint',
) {
  const { ref, channel } = await svc.command();
  const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, takes);
  worker.begin('pays');
  worker.send({
    type: 'stopped',
    stop: 1,
    reason,
    title: reason === 'failure' ? 'Failed: Timed out' : "Click getByRole('button', { name: 'Pay' })",
    place: { file, line, column: 5 },
    locator: "getByRole('button', { name: 'Pay' })",
    bar,
  });
  const stop = await waitFor(() => svc.latest(ref)?.workers[0]?.stop ?? undefined);
  return { ref, channel, worker, since: stop.since };
}

/** Answers the worker's next request of `what` with `value`. */
async function answer(worker: FakeWorker, after: number, what: string, value: unknown) {
  const asked = await worker.next('request', after);
  expect(asked).toMatchObject({ what });
  worker.send({ type: 'answer', request: asked.request, what, value } as never);
  return asked;
}

/** The test's half of a hand-off in its `check` mode: what it heard, and what it sends. */
function checkHandoff(channel: { path: string; token: string }, stop: { ref: string; worker: number; stop: number }) {
  const socket = net.connect(channel.path);
  socket.setEncoding('utf8');
  const heard: HandoffToTest[] = [];
  socket.on(
    'data',
    lineReader(
      (line) => {
        const message = parseHandoffToTest(line);
        if (message) heard.push(message);
      },
      () => socket.destroy(),
    ),
  );
  const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
  send({
    type: 'attach',
    token: channel.token,
    file: path.join(dir, 'tests/checkout.spec.ts'),
    line: 5,
    reason: 'breakpoint',
    testIdAttribute: null,
    baseURL: 'http://localhost:3000',
    mode: 'check',
    stop,
  });
  return { socket, heard, send };
}

const CHECK: RawCaptureEvent = {
  kind: 'assert',
  target: {
    tagName: 'output',
    role: 'status',
    accessibleName: null,
    testId: 'total',
    text: 'Total €72.00',
    alternatives: [{ locator: "getByTestId('total')", method: 'getByTestId', score: 90 }],
  },
  value: null,
  checked: null,
  inputType: null,
  isPasswordField: false,
  pageUrl: 'http://localhost:3000/cart',
  timestamp: 1,
  assertion: { matcher: 'toHaveText', expected: 'Total €72.00', actual: null, negated: false, note: null },
};

describe('code from a stop, with a client that writes it', () => {
  let svc: Service;
  beforeAll(async () => {
    svc = await service(dir, true, { distDir: dist }, { stopCode: true });
  });
  afterAll(() => svc.stop());

  const action = (params: object) => svc.client.sendRequest('piwi/stopAction', params) as Promise<StopActionResult>;

  test('lists the responses the test kept, and writes a mock of the one chosen above the stopped line', async () => {
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true);
    try {
      expect(svc.latest(ref)!.workers[0]!.takes).toEqual([...RUN_TAKES]);
      const listing = svc.client.sendRequest('piwi/stopRequests', { ref, since }) as Promise<StopRequestsResult>;
      await answer(worker, 0, 'requests', { ok: true, message: 'The test kept 1 response.', requests: [KEPT] });
      expect(await listing).toEqual({ ok: true, message: 'The test kept 1 response.', requests: [KEPT] });

      const mocking = action({ ref, since, action: 'mock', request: 1 });
      const asked = await answer(worker, 1, 'mock', { ok: true, message: 'GET', response: RESPONSE });
      expect(asked).toEqual({ type: 'request', request: expect.any(Number), what: 'mock', stop: 1, id: 1 });
      const said = 'Piwi wrote the mock above checkout.spec.ts:5.';
      const goesOn = ' The stopped test goes on with the code it started with: the new lines run next time.';
      expect(await mocking).toEqual({ ok: true, message: said + goesOn });
      const code = [
        "  await page.route('**/api/cart', (route) =>",
        '    route.fulfill({',
        '      json: {',
        '        "items": []',
        '      },',
        '    }),',
        '  );',
      ].join('\n');
      expect(last(svc.codes)).toEqual({
        ref,
        worker: 0,
        since,
        action: 'mock',
        uri: uri('tests/checkout.spec.ts'),
        version: null,
        line: 4,
        code,
        edits: [{ range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }, newText: `${code}\n` }],
        message: said + goesOn,
        warnings: [],
      });

      // A region picked in the test's window: the intent starts, then the worker sends what was picked.
      const region = action({ ref, since, action: 'assert-region' });
      await answer(worker, 2, 'assert-region', { ok: true, message: 'Pick the region.' });
      expect(await region).toEqual({ ok: true, message: 'Pick the region.' });
      worker.send({
        type: 'region',
        stop: 1,
        locator: "getByTestId('summary')",
        snapshot: '- heading "Summary" [level=2]',
      });
      const written = await waitFor(() => (last(svc.codes)?.action === 'assert-region' ? last(svc.codes) : undefined));
      // The first code of the run said the test goes on as it started; the next ones do not.
      expect(written.message).toBe("Piwi wrote the region's ARIA snapshot above checkout.spec.ts:5.");
      expect(written.code).toBe(
        [
          "  await expect(page.getByTestId('summary')).toMatchAriaSnapshot(`",
          '    - heading "Summary" [level=2]',
          '  `);',
        ].join('\n'),
      );
      // The spec imports test alone: expect comes with the block.
      expect(written.edits).toEqual([
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
          newText: "import { expect } from '@playwright/test';\n",
        },
        { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }, newText: `${written.code}\n` },
      ]);
      // A region of a stop that ended makes no code.
      worker.send({ type: 'region', stop: 7, locator: "getByTestId('x')", snapshot: '- text: x' });
      await new Promise((r) => setTimeout(r, 100));
      expect(svc.codes.filter((c) => c.action === 'assert-region')).toHaveLength(1);
    } finally {
      worker.socket.destroy();
    }
  });

  test('writes the check made with the check panel, through a hand-off in its check mode', async () => {
    const { ref, channel, worker, since } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true);
    const before = svc.codes.length;
    try {
      const asserting = action({ ref, since, action: 'assert' });
      await answer(worker, 0, 'assert', { ok: true, message: 'Check an element.' });
      expect(await asserting).toEqual({ ok: true, message: 'Check an element.' });
      const test = checkHandoff(channel, { ref, worker: 0, stop: 1 });
      try {
        const load = await waitFor(() => test.heard.find((m) => m.type === 'load'));
        expect(load).toEqual({ type: 'load', bundle: path.join(dist, 'record-ide.js') });
        test.send({ type: 'loaded' });
        // The recorder reads its settings: the check mode, the file it writes into.
        test.send({
          type: 'binding',
          call: 1,
          outside: false,
          payload: { kind: 'local-get', keys: 'piwiIdeSettings' },
        });
        expect(await waitFor(() => test.heard.find((m) => m.type === 'answer' && m.call === 1))).toMatchObject({
          value: { piwiIdeSettings: { file: 'checkout.spec.ts', testIdAttribute: null, check: true } },
        });
        test.send({
          type: 'binding',
          call: 2,
          outside: false,
          payload: { kind: 'message', message: { type: 'piwi-append-recording-event', event: CHECK } },
        });
        const written = await waitFor(() => svc.codes[before]);
        expect(written).toMatchObject({
          ref,
          since,
          action: 'assert',
          uri: uri('tests/checkout.spec.ts'),
          line: 4,
          code: "  await expect(page.getByTestId('total')).toHaveText('Total €72.00');",
          message:
            'Piwi wrote the check above checkout.spec.ts:5.' +
            ' The stopped test goes on with the code it started with: the new lines run next time.',
        });
        // The check is the hand-off's end: the recorder in the page stops, and the test hears it.
        expect(await waitFor(() => test.heard.find((m) => m.type === 'stop'))).toEqual({ type: 'stop' });
        expect(test.heard).toContainEqual({ type: 'dispatch', message: { type: 'piwi-recording-stopped' } });
      } finally {
        test.socket.destroy();
      }
      // A check whose stop the test went on from is refused at once.
      const late = checkHandoff(channel, { ref, worker: 0, stop: 9 });
      expect(await waitFor(() => late.heard.find((m) => m.type === 'refused'))).toEqual({
        type: 'refused',
        message: 'the test went on.',
      });
      late.socket.destroy();
    } finally {
      worker.socket.destroy();
    }
  });

  test('counts the locator at the caret on the stopped page, and takes its outline down', async () => {
    const { ref, worker } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true);
    const caret = (params: object) =>
      svc.client.sendRequest('piwi/locatorAtCaret', { ref, ...params }) as Promise<LocatorAtCaretResult>;
    try {
      // In the page object, off `this.page`.
      const counting = caret({ uri: uri('tests/pages/checkout.page.ts'), line: 6 });
      const asked = await answer(worker, 0, 'locator', { ok: true, message: '1 element matches.', count: 1 });
      expect(asked).toEqual({
        type: 'request',
        request: expect.any(Number),
        what: 'locator',
        stop: 1,
        locator: "getByRole('button', { name: 'Pay' })",
      });
      expect(await counting).toEqual({
        ok: true,
        message: '1 element matches.',
        locator: "getByRole('button', { name: 'Pay' })",
        count: 1,
      });
      // A line without a locator says so, and the outline goes.
      const none = caret({ uri: uri('tests/checkout.spec.ts'), line: 3 });
      expect(
        await answer(worker, 1, 'locator', { ok: true, message: 'The outline is gone.', count: null }),
      ).toMatchObject({
        locator: null,
      });
      expect(await none).toEqual({ ok: false, message: 'No locator on this line.', locator: null, count: null });
      // The caret left: the outline goes.
      const left = caret({ uri: null, line: null });
      await answer(worker, 2, 'locator', { ok: true, message: 'The outline is gone.', count: null });
      expect(await left).toEqual({ ok: true, message: 'The outline is gone.', locator: null, count: null });
    } finally {
      worker.socket.destroy();
    }
  });

  test('writes in a page object on the page in scope there', async () => {
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/pages/checkout.page.ts', 7, false);
    try {
      const mocking = action({ ref, since, action: 'mock', request: 1 });
      await answer(worker, 0, 'mock', { ok: true, message: 'GET', response: RESPONSE });
      expect(await mocking).toMatchObject({ ok: true });
      expect(last(svc.codes)).toMatchObject({
        uri: uri('tests/pages/checkout.page.ts'),
        line: 6,
        code: expect.stringMatching(/^ {4}await this\.page\.route\('\*\*\/api\/cart', \(route\) =>\n/),
      });
    } finally {
      worker.socket.destroy();
    }
  });

  test('refuses an action at a stop it does not fit, without asking the worker', async () => {
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, false);
    try {
      expect(await action({ ref, since, action: 'assert' })).toEqual({
        ok: false,
        message: "Assert needs the pause bar in the test's window, and this test runs headless: run it headed.",
      });
      expect(await action({ ref, since, action: 'assert-region' })).toMatchObject({
        message: expect.stringMatching(/^Assert a region needs the pause bar/),
      });
      expect(await action({ ref, since: 'then', action: 'mock', request: 1 })).toEqual({
        ok: false,
        message: 'The test went on.',
      });
      expect(await action({ ref, since, action: 'mock' })).toEqual({
        ok: false,
        message: 'Mock a request needs the response to mock: one of those the test kept.',
      });
      expect(await action({ ref, action: 'mock', request: 1 })).toEqual({
        ok: false,
        message: 'The command needs the stop it answers.',
      });
      expect(await action({ ref, since, action: 'dance' })).toEqual({
        ok: false,
        message: 'Piwi does not know the action "dance".',
      });
      expect(worker.heard.filter((m) => m.type === 'request')).toEqual([]);
      // A response the worker no longer keeps.
      const mocking = action({ ref, since, action: 'mock', request: 4 });
      await answer(worker, 0, 'mock', { ok: false, message: 'The test kept no such response.', response: null });
      expect(await mocking).toEqual({ ok: false, message: 'The test kept no such response.' });
    } finally {
      worker.socket.destroy();
    }
  });

  test('refuses what a reporter that predates the code actions does not take', async () => {
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true, ['pick', 'record']);
    try {
      expect(await action({ ref, since, action: 'assert' })).toEqual({
        ok: false,
        message: "@piwitests/reporter 0.60.0 cannot start Assert from outside the test's window: update it.",
      });
      expect(await svc.client.sendRequest('piwi/stopRequests', { ref, since })).toEqual({
        ok: false,
        message: '@piwitests/reporter 0.60.0 cannot list the responses its test kept: update it.',
        requests: [],
      });
      expect(
        await svc.client.sendRequest('piwi/locatorAtCaret', { ref, uri: uri('tests/checkout.spec.ts'), line: 4 }),
      ).toEqual({
        ok: false,
        message: '@piwitests/reporter 0.60.0 cannot count a locator on the stopped page: update it.',
        locator: "getByRole('button', { name: 'Pay' })",
        count: null,
      });
      expect(worker.heard.filter((m) => m.type === 'request')).toEqual([]);
    } finally {
      worker.socket.destroy();
    }
  });

  test('says why when the code cannot go where the test stopped', async () => {
    const { worker } = await stoppedWorker(svc, 'tests/pages/checkout.page.ts', 3, false);
    const notices = svc.notices.length;
    try {
      worker.send({ type: 'region', stop: 1, locator: "getByTestId('summary')", snapshot: '- text: x' });
      expect(await waitFor(() => svc.notices[notices])).toEqual({
        root: dir,
        severity: 'warning',
        message: 'The test is stopped outside a test or a function of this file: nothing can be written there.',
      });
    } finally {
      worker.socket.destroy();
    }
  });
});

describe('code from a stop, with a client that writes none', () => {
  test('refuses the actions that write code, and lets Pick and Record through', async () => {
    const svc = await service(dir, true, { distDir: dist });
    const { ref, worker, since, channel } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true);
    const refusal = "The editor cannot write code from a stop: update Piwi's extension in the editor.";
    try {
      for (const kind of ['assert', 'assert-region']) {
        expect(await svc.client.sendRequest('piwi/stopAction', { ref, since, action: kind })).toEqual({
          ok: false,
          message: refusal,
        });
      }
      expect(await svc.client.sendRequest('piwi/stopAction', { ref, since, action: 'mock', request: 1 })).toEqual({
        ok: false,
        message: refusal,
      });
      const picking = svc.client.sendRequest('piwi/stopAction', { ref, since, action: 'pick' });
      await answer(worker, 0, 'pick', { ok: true, message: 'Pick an element.' });
      expect(await picking).toEqual({ ok: true, message: 'Pick an element.' });
      const late = checkHandoff(channel, { ref, worker: 0, stop: 1 });
      expect(await waitFor(() => late.heard.find((m) => m.type === 'refused'))).toEqual({
        type: 'refused',
        message: refusal,
      });
      late.socket.destroy();
    } finally {
      worker.socket.destroy();
      svc.stop();
    }
  });

  test('lets a failure no surface can answer go at once, saying nothing', async () => {
    const svc = await service(dir, false);
    const { worker } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, false, [...RUN_TAKES], 'failure');
    try {
      expect(await worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
      await new Promise((r) => setTimeout(r, 100));
      expect(svc.notices).toEqual([]);
    } finally {
      worker.socket.destroy();
      svc.stop();
    }
  });
});

describe('code from a stop, started from Piwi Picker', () => {
  test('starts each action at the stop it names; the code goes to the editor, never to the extension', async () => {
    const svc = await service(dir, true, { distDir: dist }, { stopCode: true });
    const published = await waitFor(() => svc.published[0] ?? undefined);
    const socket = new WebSocket(published.hub!.url, { origin: ORIGIN });
    const messages: HubMessage[] = [];
    socket.on('message', (data) => {
      const message = parseHubMessage(String(data));
      if (message) messages.push(message);
    });
    await new Promise((resolve) => socket.on('open', resolve));
    const send = (message: object) => socket.send(JSON.stringify(message));
    const reply = (id: number) =>
      waitFor(() => messages.find((m): m is HubAnswer => m.type === 'answer' && m.id === id));
    send({ type: 'hello', token: published.hub!.token });
    send({ type: 'subscribe', id: 1 });
    await reply(1);
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true);
    try {
      const session = await waitFor(() => {
        const heard = last(messages.filter((m) => m.type === 'session'));
        return heard?.type === 'session' && heard.session.ref === ref && heard.session.workers[0]?.stop
          ? heard.session
          : undefined;
      });
      expect(session.workers[0]!.intents).toEqual(['pick', 'record', 'assert', 'assert-region', 'mock']);

      send({ type: 'requests', id: 2, ref, since });
      await answer(worker, 0, 'requests', { ok: true, message: 'The test kept 1 response.', requests: [KEPT] });
      expect(await reply(2)).toEqual({
        type: 'answer',
        id: 2,
        ok: true,
        message: 'The test kept 1 response.',
        requests: [KEPT],
      });

      send({ type: 'mock', id: 3, ref, since, request: 1 });
      await answer(worker, 1, 'mock', { ok: true, message: 'GET', response: RESPONSE });
      const mocked = await reply(3);
      expect(mocked).toMatchObject({ ok: true, message: expect.stringMatching(/^Piwi wrote the mock above/) });
      expect(JSON.stringify(mocked)).not.toContain('route');
      expect(last(svc.codes)).toMatchObject({ action: 'mock', ref, since });

      send({ type: 'assert', id: 4, ref, since });
      await answer(worker, 2, 'assert', { ok: true, message: 'Check an element.' });
      expect(await reply(4)).toMatchObject({ ok: true, message: 'Check an element.' });
      send({ type: 'assert-region', id: 5, ref, since: 'then' });
      expect(await reply(5)).toMatchObject({ ok: false, message: 'The test went on.' });
      send({ type: 'mock', id: 6, ref, since });
      expect(await reply(6)).toMatchObject({ ok: false, message: expect.stringMatching(/^mock needs the response/) });
    } finally {
      worker.socket.destroy();
      socket.close();
      svc.stop();
    }
  });
});
