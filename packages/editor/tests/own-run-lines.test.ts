/**
 * A spec's test lines in a config no instance reads: the service answers `piwi/fileSummary` with the state of each test
 * the editor's own run tells (running, at a stop, then its result), and the run status names those tests for the
 * client to draw the spec again. A service started in-process on a workspace with no instance, and a fake worker.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { FileSummary, RunStatusResult } from '../src/protocol';
import { FakeWorker, service, waitFor, writeRunWorkspace, type Service } from './run-fixtures';

let dir = '';
let svc: Service;
const statuses: RunStatusResult[] = [];
const spec = () => pathToFileURL(path.join(dir, 'tests/cart.spec.ts')).href;
const summary = () => svc.client.sendRequest('piwi/fileSummary', { uri: spec() }) as Promise<FileSummary>;
/** The spec's test line once it says `status`, asked again until it does. */
const lineSaying = async (status: string) => {
  const until = Date.now() + 5000;
  for (;;) {
    const line = (await summary()).lines.find((l) => l.status === status);
    if (line) return line;
    if (Date.now() > until) throw new Error(`no line says ${status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-own-run-lines-')));
  writeRunWorkspace(dir);
  // The test the fake worker runs, in its describe block.
  fs.writeFileSync(
    path.join(dir, 'tests/cart.spec.ts'),
    "import { test } from '@playwright/test';\n\ntest.describe('cart', () => {\n  test('adds a mug', async ({ page }) => {});\n});\n",
  );
  svc = await service(dir, true);
  svc.client.onNotification('piwi/runStatusChanged', (status: RunStatusResult) => void statuses.push(status));
});

afterAll(() => {
  svc?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a spec’s test lines with no instance: running, at a stop, then the result the run kept', async () => {
  // No instance, no run: the spec shows nothing.
  expect(await summary()).toEqual({ file: null, lines: [] });
  const { ref, channel } = await svc.command();
  const worker = new FakeWorker(channel.path, dir).attach(channel.token, ref, 0);
  try {
    worker.begin();
    expect(await lineSaying('running')).toEqual({
      line: 3,
      title: 'running in your run',
      status: 'running',
      endLine: 3,
    });
    // The run status names the test, for the client to draw the spec again.
    const told = (words: string) =>
      waitFor(() =>
        [...statuses].reverse().find((s) => s.runTests?.[0]?.tests[0]?.words === words) ? true : undefined,
      );
    await told('running');
    expect(statuses[statuses.length - 1]?.runTests).toEqual([
      { root: dir, tests: [{ uri: spec(), title: ['cart', 'adds a mug'], status: 'running', words: 'running' }] },
    ]);

    worker.stopAt(1, 30);
    expect((await lineSaying('paused')).title).toBe('stopped at a breakpoint, line 30 of cart.page.ts, in your run');

    // Held at its failure, then failed: the state stays `failed`, the words change, and the client is told each time.
    worker.send({ type: 'running', stop: 1 });
    await svc.client.sendRequest('piwi/holdRun', { ref, on: true });
    worker.send({
      type: 'stopped',
      stop: 2,
      reason: 'failure',
      title: 'Failed: Timed out',
      place: { file: 'tests/cart.spec.ts', line: 4, column: 3 },
      locator: null,
      bar: false,
    });
    expect((await lineSaying('failed')).title).toBe('held at its failure, line 4, in your run');
    await told('held at its failure, line 4,');
    worker.send({ type: 'running', stop: 2 });
    worker.send({ type: 'test-end', testId: 'id-adds a mug', status: 'failed', pausedMs: 0 });
    await told('failed');
    expect((await summary()).lines).toEqual([{ line: 3, title: 'failed in your run', status: 'failed', endLine: 3 }]);

    // The run ends: its result stays on the line, the run reaching no instance.
    await svc.client.sendNotification('piwi/commandEnded', { ref, exitCode: 1 });
    await waitFor(() => (svc.latest(ref)?.ended ? true : undefined));
    expect((await summary()).lines).toEqual([{ line: 3, title: 'failed in your run', status: 'failed', endLine: 3 }]);
  } finally {
    worker.socket.destroy();
  }
}, 20_000);
