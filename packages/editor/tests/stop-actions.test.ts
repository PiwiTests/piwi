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
import { parseHubMessage, type HubAnswer, type HubCodeMessage, type HubMessage } from '@piwitests/core/run-hub';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import { RUN_TAKES, type RunTake } from '@piwitests/core/run-channel';
import type { LocatorAtCaretResult, StopActionResult, StopCode, StopRequestsResult } from '../src/protocol';
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

/** A spec whose test stops at its first statement, and one with a second page. */
const FIRST = [
  "import { test } from '@playwright/test';",
  '',
  "test('pays', async ({ page }) => {",
  "  await page.goto('/cart');",
  '});',
  '',
].join('\n');
const ADMIN = [
  "import { test } from './fixtures';",
  '',
  "test('refunds', async ({ page, adminPage }) => {",
  "  await page.goto('/cart');",
  "  await adminPage.getByRole('button', { name: 'Refund' }).click();",
  "  await page.getByRole('button', { name: 'Pay' }).click();",
  '});',
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
  write('tests/first.spec.ts', FIRST);
  write('tests/disk.spec.ts', FIRST);
  write('tests/admin.spec.ts', ADMIN);
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
/** A text once the edits are made, as a client makes them: against the text they were placed in. */
function applyEdits(text: string, edits: StopCode['edits']): string {
  const lines = text.split('\n');
  const offset = (p: { line: number; character: number }) =>
    lines.slice(0, p.line).reduce((sum, line) => sum + line.length + 1, 0) + p.character;
  return [...edits]
    .sort((a, b) => offset(b.range.start) - offset(a.range.start))
    .reduce((out, e) => out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end)), text);
}

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
      // The client says it wrote the code once it did; the answer, that it was sent to the client to write.
      const said = 'Piwi wrote the mock above checkout.spec.ts:5.';
      const goesOn = ' The stopped test goes on with the code it started with: the new lines run next time.';
      expect(await mocking).toEqual({
        ok: true,
        message: `Piwi sent the mock to Test Editor to write above checkout.spec.ts:5.${goesOn}`,
      });
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
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true);
    const caret = (params: object) =>
      svc.client.sendRequest('piwi/locatorAtCaret', { ref, since, ...params }) as Promise<LocatorAtCaretResult>;
    try {
      // In the stopped file, off the page the code there runs on.
      const counting = caret({ uri: uri('tests/checkout.spec.ts'), line: 4 });
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

  test('counts no locator of a page the test may not have stopped on, and none for a command naming no stop', async () => {
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/admin.spec.ts', 5, true);
    const caret = (params: object) =>
      svc.client.sendRequest('piwi/locatorAtCaret', { ref, since, ...params }) as Promise<LocatorAtCaretResult>;
    try {
      // Stopped on `adminPage`: its own locator counts.
      const own = caret({ uri: uri('tests/admin.spec.ts'), line: 4 });
      await answer(worker, 0, 'locator', { ok: true, message: '1 element matches.', count: 1 });
      expect(await own).toMatchObject({ ok: true, locator: "getByRole('button', { name: 'Refund' })" });
      // `page` may be another page, and so may `this.page` of another file: refused, the outline taken down.
      const other = caret({ uri: uri('tests/admin.spec.ts'), line: 5 });
      await answer(worker, 1, 'locator', { ok: true, message: 'The outline is gone.', count: null });
      expect(await other).toEqual({
        ok: false,
        message:
          'The test is stopped on adminPage: page may be another page, so Piwi counts a locator that starts from adminPage.',
        locator: "getByRole('button', { name: 'Pay' })",
        count: null,
      });
      const elsewhere = caret({ uri: uri('tests/pages/checkout.page.ts'), line: 6 });
      await answer(worker, 2, 'locator', { ok: true, message: 'The outline is gone.', count: null });
      expect(await elsewhere).toEqual({
        ok: false,
        message:
          'The test is stopped in admin.spec.ts: this.page here may be another page than the one it stopped on, so Piwi counts a locator of that file.',
        locator: "getByRole('button', { name: 'Pay' })",
        count: null,
      });
      expect(
        await svc.client.sendRequest('piwi/locatorAtCaret', { ref, uri: uri('tests/admin.spec.ts'), line: 4 }),
      ).toEqual({ ok: false, message: 'The command needs the stop it answers.', locator: null, count: null });
      expect(await svc.client.sendRequest('piwi/stopRequests', { ref })).toEqual({
        ok: false,
        message: 'The command needs the stop it answers.',
        requests: [],
      });
      expect(worker.heard.filter((m) => m.type === 'request')).toHaveLength(3);
    } finally {
      worker.socket.destroy();
    }
  });

  test('writes the code of a second action above the stopped statement, where the first one moved it', async () => {
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/first.spec.ts', 4, true);
    const file = uri('tests/first.spec.ts');
    try {
      const region = action({ ref, since, action: 'assert-region' });
      await answer(worker, 0, 'assert-region', { ok: true, message: 'Pick the region.' });
      await region;
      worker.send({ type: 'region', stop: 1, locator: "getByTestId('summary')", snapshot: '- text: x' });
      const first = await waitFor(() => (last(svc.codes)?.uri === file ? last(svc.codes) : undefined));
      expect(first.line).toBe(3);
      // The client writes it as an editor does: the file opened as it is on disk, then one change per edit.
      const opened = FIRST;
      await svc.client.sendNotification('textDocument/didOpen', {
        textDocument: { uri: file, languageId: 'typescript', version: 1, text: opened },
      });
      await svc.client.sendNotification('textDocument/didChange', {
        textDocument: { uri: file, version: 2 },
        contentChanges: [...first.edits].reverse().map((e) => ({ range: e.range, text: e.newText })),
      });
      const written = applyEdits(opened, first.edits);

      const mocking = action({ ref, since, action: 'mock', request: 1 });
      await answer(worker, 1, 'mock', { ok: true, message: 'GET', response: RESPONSE });
      expect(await mocking).toMatchObject({
        ok: true,
        message: 'Piwi sent the mock to Test Editor to write above first.spec.ts:8.',
      });
      const second = last(svc.codes)!;
      // The import the first one added and its three lines are above the stopped statement now.
      expect(second.line).toBe(7);
      const lines = applyEdits(written, second.edits).split('\n');
      expect(lines.findIndex((l) => l.includes('page.route('))).toBeGreaterThan(
        lines.findIndex((l) => l.startsWith('test(')),
      );
      expect(lines[second.line + second.code.split('\n').length]).toBe("  await page.goto('/cart');");
    } finally {
      await svc.client.sendNotification('textDocument/didClose', { textDocument: { uri: file } });
      worker.socket.destroy();
    }
  });

  test('refuses to write in a file written on disk since the run started, and above a declaration', async () => {
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/disk.spec.ts', 4, true);
    try {
      const later = new Date(Date.now() + 2000);
      fs.writeFileSync(path.join(dir, 'tests/disk.spec.ts'), `// a line added\n${FIRST}`);
      fs.utimesSync(path.join(dir, 'tests/disk.spec.ts'), later, later);
      const mocking = action({ ref, since, action: 'mock', request: 1 });
      await answer(worker, 0, 'mock', { ok: true, message: 'GET', response: RESPONSE });
      expect(await mocking).toEqual({
        ok: false,
        message:
          'disk.spec.ts was written on disk since the run started, which Piwi cannot follow: run the test again to write code at its stop.',
      });
      // Nothing starts in the test's window for a check that could not be written.
      expect(await action({ ref, since, action: 'assert' })).toMatchObject({ ok: false, message: /written on disk/ });
      expect(worker.heard.filter((m) => m.type === 'request')).toHaveLength(1);
    } finally {
      worker.socket.destroy();
    }
    // A stop on a test's declaration (a test timeout that names no call) writes nothing above it.
    const declared = await stoppedWorker(svc, 'tests/checkout.spec.ts', 3, true);
    try {
      expect(await action({ ref: declared.ref, since: declared.since, action: 'assert-region' })).toEqual({
        ok: false,
        message: 'The test is stopped outside a test or a function of this file: nothing can be written there.',
      });
      expect(declared.worker.heard.filter((m) => m.type === 'request')).toEqual([]);
    } finally {
      declared.worker.socket.destroy();
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

  test('writes the code of a rerun under the same ref above its stopped line, the files as they stand when it ran', async () => {
    const file = path.join(dir, 'tests/rerun.spec.ts');
    const spec = [
      "import { test } from '@playwright/test';",
      '',
      "test('pays', async ({ page }) => {",
      "  await page.goto('/cart');",
      "  await page.getByRole('button', { name: 'Pay' }).click();",
      "  await page.getByRole('link', { name: 'Orders' }).click();",
      '});',
      '',
    ].join('\n');
    fs.writeFileSync(file, spec);
    const doc = pathToFileURL(file).href;
    await svc.client.sendNotification('textDocument/didOpen', {
      textDocument: { uri: doc, languageId: 'typescript', version: 1, text: spec },
    });
    const { ref, channel } = await svc.command();
    const first = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    let again: FakeWorker | null = null;
    try {
      first.begin('pays');
      await waitFor(() => svc.latest(ref)?.workers[0]?.test ?? undefined);
      first.socket.destroy();
      await svc.client.sendNotification('piwi/commandEnded', { ref, exitCode: 0 });
      await waitFor(() => (svc.latest(ref)?.ended ? true : undefined));
      // Between the runs, three lines written above the click, and saved: the rerun runs them.
      const added = '  // one\n  // two\n  // three\n';
      await svc.client.sendNotification('textDocument/didChange', {
        textDocument: { uri: doc, version: 2 },
        contentChanges: [{ range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }, text: added }],
      });
      const saved = spec.replace("  await page.getByRole('button'", `${added}  await page.getByRole('button'`);
      fs.writeFileSync(file, saved);
      await new Promise((r) => setTimeout(r, 100));
      // The rerun (JetBrains' Rerun starts the command again, its environment and ref as they were) stops at the click.
      again = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
      again.begin('pays');
      again.send({
        type: 'stopped',
        stop: 1,
        reason: 'breakpoint',
        title: "Click getByRole('button', { name: 'Pay' })",
        place: { file: 'tests/rerun.spec.ts', line: 8, column: 5 },
        locator: "getByRole('button', { name: 'Pay' })",
        bar: true,
      });
      const stop = await waitFor(() =>
        svc.latest(ref)?.ended === false ? svc.latest(ref)?.workers[0]?.stop : undefined,
      );
      const mocking = action({ ref, since: stop!.since, action: 'mock', request: 1 });
      await answer(again, 0, 'mock', { ok: true, message: 'GET', response: RESPONSE });
      expect(await mocking).toMatchObject({ ok: true, message: expect.stringContaining('rerun.spec.ts:8.') });
      expect(last(svc.codes)).toMatchObject({ uri: doc, line: 7 });
      expect(saved.split('\n')[7]).toBe("  await page.getByRole('button', { name: 'Pay' }).click();");
    } finally {
      await svc.client.sendNotification('textDocument/didClose', { textDocument: { uri: doc } });
      first.socket.destroy();
      again?.socket.destroy();
    }
  });

  test('writes in a file saved with a byte order mark, which an editor’s document holds without it', async () => {
    const file = path.join(dir, 'tests/bom.spec.ts');
    fs.writeFileSync(file, `\uFEFF${SPEC}`);
    const doc = pathToFileURL(file).href;
    await svc.client.sendNotification('textDocument/didOpen', {
      textDocument: { uri: doc, languageId: 'typescript', version: 1, text: SPEC },
    });
    await new Promise((r) => setTimeout(r, 50));
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/bom.spec.ts', 5, true);
    try {
      const mocking = action({ ref, since, action: 'mock', request: 1 });
      await answer(worker, 0, 'mock', { ok: true, message: 'GET', response: RESPONSE });
      expect(await mocking).toMatchObject({ ok: true });
      expect(last(svc.codes)).toMatchObject({ uri: doc, version: 1, line: 4 });
    } finally {
      await svc.client.sendNotification('textDocument/didClose', { textDocument: { uri: doc } });
      worker.socket.destroy();
    }
  });

  test('writes code above the failing line at a failure the pause bar holds', async () => {
    const { ref, worker, since } = await stoppedWorker(
      svc,
      'tests/checkout.spec.ts',
      5,
      true,
      [...RUN_TAKES],
      'failure',
    );
    try {
      expect(svc.latest(ref)!.workers[0]!.stop).toMatchObject({ reason: 'failure', title: 'Failed: Timed out' });
      const mocking = action({ ref, since, action: 'mock', request: 1 });
      await answer(worker, 0, 'mock', { ok: true, message: 'GET', response: RESPONSE });
      expect(await mocking).toMatchObject({ ok: true });
      expect(last(svc.codes)).toMatchObject({ ref, since, action: 'mock', line: 4 });
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
        await svc.client.sendRequest('piwi/locatorAtCaret', {
          ref,
          since,
          uri: uri('tests/checkout.spec.ts'),
          line: 4,
        }),
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

  test('tells the client why a check it started was not made: the recorder missing from the installation', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-stop-empty-'));
    const svc = await service(dir, true, { distDir: empty }, { stopCode: true });
    const { ref, channel, worker, since } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true);
    const notices = svc.notices.length;
    try {
      const asserting = svc.client.sendRequest('piwi/stopAction', { ref, since, action: 'assert' });
      await answer(worker, 0, 'assert', { ok: true, message: 'Check an element.' });
      expect(await asserting).toEqual({ ok: true, message: 'Check an element.' });
      const test = checkHandoff(channel, { ref, worker: 0, stop: 1 });
      const refused = await waitFor(() => test.heard.find((m) => m.type === 'refused'));
      expect(refused).toMatchObject({
        message: expect.stringMatching(/^The recorder is missing from this installation/),
      });
      expect(await waitFor(() => svc.notices[notices])).toEqual({
        root: dir,
        severity: 'warning',
        message: `Nothing was checked: ${(refused as { message: string }).message}`,
      });
      test.socket.destroy();
    } finally {
      worker.socket.destroy();
      svc.stop();
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('lets a failure no surface can answer go at once, saying and showing nothing', async () => {
    const svc = await service(dir, false);
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    try {
      worker.begin('pays');
      worker.send({
        type: 'stopped',
        stop: 1,
        reason: 'failure',
        title: 'Failed: Timed out',
        place: { file: 'tests/checkout.spec.ts', line: 5, column: 5 },
        locator: null,
        bar: false,
      });
      expect(await worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
      await new Promise((r) => setTimeout(r, 100));
      expect(svc.notices).toEqual([]);
      expect(svc.sessions.some((s) => s.workers.some((w) => w.stop))).toBe(false);
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
      expect(mocked).toMatchObject({
        ok: true,
        message: expect.stringMatching(/^Piwi sent the mock to Test Editor to write above/),
      });
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

  test('tells each follower once what each code came to, at the stop it was made at, whoever started it', async () => {
    const svc = await service(dir, true, { distDir: dist }, { stopCode: true });
    const published = await waitFor(() => svc.published[0] ?? undefined);
    const follower = await hubClient(published.hub!, true);
    // Paired, not following the runs: it hears none of it.
    const bystander = await hubClient(published.hub!, false);
    const { ref, channel, worker, since } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true);
    const codes = () => follower.messages.filter((m): m is HubCodeMessage => m.type === 'code');
    try {
      // Mock a request from Piwi Picker: what it came to says what its answer says, and what to check in the code.
      follower.send({ type: 'mock', id: 2, ref, since, request: 1 });
      await answer(worker, 0, 'mock', {
        ok: true,
        message: 'GET',
        response: { ...RESPONSE, body: '{"items":[],"token":"t0k3n-of-the-cart"}' },
      });
      const mocked = await follower.reply(2);
      expect(await waitFor(() => codes()[0])).toEqual({
        type: 'code',
        ref,
        worker: 0,
        since,
        action: 'mock',
        ok: true,
        message: mocked.message,
        warnings: ['A value named or shaped like a credential is written as <hidden>.'],
      });
      expect(JSON.stringify(codes())).not.toContain('route');

      // Assert a region from the editor's client: Piwi Picker hears what it came to as well.
      const region = svc.client.sendRequest('piwi/stopAction', { ref, since, action: 'assert-region' });
      await answer(worker, 1, 'assert-region', { ok: true, message: 'Pick the region.' });
      await region;
      worker.send({ type: 'region', stop: 1, locator: "getByTestId('summary')", snapshot: '- text: x' });
      expect(await waitFor(() => codes()[1])).toEqual({
        type: 'code',
        ref,
        worker: 0,
        since,
        action: 'assert-region',
        ok: true,
        message: "Piwi sent the region's ARIA snapshot to Test Editor to write above checkout.spec.ts:5.",
      });

      // Assert from Piwi Picker: its answer says the check starts, and the check written comes after.
      follower.send({ type: 'assert', id: 3, ref, since });
      await answer(worker, 2, 'assert', { ok: true, message: 'Check an element.' });
      expect(await follower.reply(3)).toMatchObject({ ok: true, message: 'Check an element.' });
      const test = checkHandoff(channel, { ref, worker: 0, stop: 1 });
      try {
        await waitFor(() => test.heard.find((m) => m.type === 'load'));
        test.send({ type: 'loaded' });
        test.send({
          type: 'binding',
          call: 1,
          outside: false,
          payload: { kind: 'message', message: { type: 'piwi-append-recording-event', event: CHECK } },
        });
        expect(await waitFor(() => codes()[2])).toEqual({
          type: 'code',
          ref,
          worker: 0,
          since,
          action: 'assert',
          ok: true,
          message: 'Piwi sent the check to Test Editor to write above checkout.spec.ts:5.',
        });
      } finally {
        test.socket.destroy();
      }

      // Refused once it started: a region whose locator Piwi cannot write; the client hears it as a notice.
      const notices = svc.notices.length;
      worker.send({ type: 'region', stop: 1, locator: "getByRole('x')); process.exit(1); ((0", snapshot: '- a' });
      const refusal = "The region's locator, getByRole('x')); process.exit(1); ((0, is not one Piwi can write.";
      expect(await waitFor(() => codes()[3])).toEqual({
        type: 'code',
        ref,
        worker: 0,
        since,
        action: 'assert-region',
        ok: false,
        message: refusal,
      });
      expect(await waitFor(() => svc.notices[notices])).toMatchObject({ message: refusal });

      // A refusal its answer carries (the response no longer kept), and the actions that write no code, push nothing.
      follower.send({ type: 'mock', id: 4, ref, since, request: 9 });
      await answer(worker, 3, 'mock', { ok: false, message: 'The test kept no such response.', response: null });
      expect(await follower.reply(4)).toMatchObject({ ok: false });
      follower.send({ type: 'pick', id: 5, ref, since });
      await answer(worker, 4, 'pick', { ok: true, message: 'Pick an element.' });
      await follower.reply(5);
      await new Promise((r) => setTimeout(r, 100));
      // Each once, to the follower alone.
      expect(codes()).toHaveLength(4);
      expect(bystander.messages.filter((m) => m.type === 'code')).toEqual([]);
    } finally {
      worker.socket.destroy();
      follower.socket.close();
      bystander.socket.close();
      svc.stop();
    }
  });

  test('tells the client and each follower why a region picked brought no snapshot', async () => {
    const svc = await service(dir, true, { distDir: dist }, { stopCode: true });
    const published = await waitFor(() => svc.published[0] ?? undefined);
    const follower = await hubClient(published.hub!, true);
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true);
    const codes = () => follower.messages.filter((m): m is HubCodeMessage => m.type === 'code');
    try {
      follower.send({ type: 'assert-region', id: 2, ref, since });
      await answer(worker, 0, 'assert-region', { ok: true, message: 'Pick the region.' });
      expect(await follower.reply(2)).toMatchObject({ ok: true, message: 'Pick the region.' });
      const notices = svc.notices.length;
      const why = "getByRole('listitem') finds 3 elements: pick a region it finds alone.";
      worker.send({ type: 'region', stop: 1, refused: why });
      expect(await waitFor(() => codes()[0])).toEqual({
        type: 'code',
        ref,
        worker: 0,
        since,
        action: 'assert-region',
        ok: false,
        message: why,
      });
      expect(await waitFor(() => svc.notices[notices])).toEqual({ root: dir, severity: 'warning', message: why });
      // Of a stop that ended, the client alone hears why.
      worker.send({ type: 'region', stop: 7, refused: 'The ARIA snapshot of x could not be read.' });
      expect(await waitFor(() => svc.notices[notices + 1])).toMatchObject({
        message: 'The ARIA snapshot of x could not be read.',
      });
      expect(codes()).toHaveLength(1);
    } finally {
      worker.socket.destroy();
      follower.socket.close();
      svc.stop();
    }
  });

  test('holds a failure no pause bar shows only while a connection follows the runs, a Runs window open', async () => {
    const svc = await service(dir, true, { distDir: dist }, { stopCode: true });
    const published = await waitFor(() => svc.published[0] ?? undefined);
    // Piwi Picker's background worker, paired, with no Runs window open: subscribed, not following.
    const picker = await hubClient(published.hub!, true);
    const { ref, channel } = await svc.command();
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    const fail = (stop: number) =>
      worker.send({
        type: 'stopped',
        stop,
        reason: 'failure',
        title: 'Failed: Timed out',
        place: { file: 'tests/checkout.spec.ts', line: 5, column: 5 },
        locator: null,
        bar: false,
      });
    const controls = () => worker.heard.filter((m) => m.type === 'control');
    try {
      worker.begin('pays');
      fail(1);
      expect(await worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
      await new Promise((r) => setTimeout(r, 100));
      expect(svc.sessions.some((s) => s.workers.some((w) => w.stop))).toBe(false);
      // A Runs window opens: the next failure waits for an answer.
      picker.send({ type: 'follow', id: 2, on: true });
      expect(await picker.reply(2)).toMatchObject({ ok: true });
      fail(2);
      await waitFor(() => svc.latest(ref)?.workers[0]?.stop ?? undefined);
      await new Promise((r) => setTimeout(r, 100));
      expect(controls()).toHaveLength(1);
      // The last Runs window closes: the failure goes on.
      picker.send({ type: 'follow', id: 3, on: false });
      expect(await worker.next('control', 1)).toEqual({ type: 'control', action: 'resume', stop: 2 });
      worker.send({ type: 'running', stop: 2 });
      // Following again, then the connection closes: the failure it held goes on as well.
      picker.send({ type: 'follow', id: 4, on: true });
      await picker.reply(4);
      fail(3);
      await new Promise((r) => setTimeout(r, 100));
      expect(controls()).toHaveLength(2);
      picker.socket.close();
      expect(await worker.next('control', 2)).toEqual({ type: 'control', action: 'resume', stop: 3 });
      expect(svc.notices).toEqual([]);
    } finally {
      worker.socket.destroy();
      svc.stop();
    }
  });

  test('lists the responses a test kept with the credentials of their URLs hidden, whatever its reporter hid', async () => {
    const svc = await service(dir, true, { distDir: dist }, { stopCode: true });
    const published = await waitFor(() => svc.published[0] ?? undefined);
    const follower = await hubClient(published.hub!, true);
    const { ref, worker, since } = await stoppedWorker(svc, 'tests/checkout.spec.ts', 5, true);
    // As a reporter that hides none of them lists them.
    const clear = [
      { ...KEPT, url: 'http://localhost:3000/api/chunked?token=abc123', size: null },
      { ...KEPT, id: 2, url: 'http://localhost:3000/api/cart?page=2' },
    ];
    const hidden = [
      { ...clear[0], url: 'http://localhost:3000/api/chunked?token=<hidden>' },
      { ...clear[1], url: 'http://localhost:3000/api/cart?page=2' },
    ];
    try {
      follower.send({ type: 'requests', id: 2, ref, since });
      await answer(worker, 0, 'requests', { ok: true, message: 'The test kept 2 responses.', requests: clear });
      expect(await follower.reply(2)).toMatchObject({ ok: true, requests: hidden });
      const listing = svc.client.sendRequest('piwi/stopRequests', { ref, since }) as Promise<StopRequestsResult>;
      await answer(worker, 1, 'requests', { ok: true, message: 'The test kept 2 responses.', requests: clear });
      expect((await listing).requests).toEqual(hidden);
      expect(JSON.stringify(follower.messages)).not.toContain('abc123');
    } finally {
      worker.socket.destroy();
      follower.socket.close();
      svc.stop();
    }
  });
});

/** A connection to the hub, as Piwi Picker opens one: hello, and `subscribe` when it follows the runs. */
async function hubClient(hub: { url: string; token: string }, subscribe: boolean) {
  const socket = new WebSocket(hub.url, { origin: ORIGIN });
  const messages: HubMessage[] = [];
  socket.on('message', (data) => {
    const message = parseHubMessage(String(data));
    if (message) messages.push(message);
  });
  await new Promise((resolve) => socket.on('open', resolve));
  const send = (message: object) => socket.send(JSON.stringify(message));
  const reply = (id: number) => waitFor(() => messages.find((m): m is HubAnswer => m.type === 'answer' && m.id === id));
  send({ type: 'hello', token: hub.token });
  await waitFor(() => messages.find((m) => m.type === 'welcome'));
  if (subscribe) {
    send({ type: 'subscribe', id: 1 });
    await reply(1);
  }
  return { socket, messages, send, reply };
}
