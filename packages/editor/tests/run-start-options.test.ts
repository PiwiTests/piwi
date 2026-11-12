/**
 * How a run the editor starts begins, as the person chose for every run of the window (`RunStartOptions`): headed, and
 * with Hold failures on or off from its start, over what its breakpoints and a `page.pause()` decided. The project's
 * reporter stops headless at a breakpoint unless a test says otherwise.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RUN_TAKES } from '@piwitests/core/run-channel';
import type { RunCommand } from '../src/protocol';
import { FakeWorker, service, waitFor, writeRunWorkspace, type Service } from './run-fixtures';

let dir = '';
let svc: Service;
const uri = (file: string) => pathToFileURL(path.join(dir, file)).href;

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-start-options-')));
  writeRunWorkspace(dir);
  fs.writeFileSync(
    path.join(dir, 'tests/pause.spec.ts'),
    "import { test } from '@playwright/test';\n\ntest('pauses', async ({ page }) => {\n  await page.pause();\n});\n",
  );
  writeReporter('0.62.0');
  svc = await service(dir, true);
});

/** The project's `@piwitests/reporter` at `version`; none with null. */
function writeReporter(version: string | null): void {
  const manifest = path.join(dir, 'node_modules/@piwitests/reporter/package.json');
  if (version === null) return fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ name: '@piwitests/reporter', version }));
}

afterAll(() => {
  svc?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The command of the cart test with `extra` over its fields, once the run channel opens. */
async function runOf(extra: object = {}): Promise<RunCommand> {
  for (;;) {
    const run = (await svc.client.sendRequest('piwi/runArgs', {
      uri: uri('tests/cart.spec.ts'),
      testIds: [],
      locations: ['tests/cart.spec.ts:3'],
      ...extra,
    })) as RunCommand;
    if (run.env?.PIWI_RUN_CHANNEL) return run;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The run's Hold failures once its first worker connects. */
async function holdOf(run: RunCommand) {
  const [channelPath, token] = run.env!.PIWI_RUN_CHANNEL!.split('#') as [string, string];
  const worker = new FakeWorker(channelPath, dir).attach(token, run.ref!, 0, [...RUN_TAKES]);
  try {
    return (await waitFor(() => svc.latest(run.ref!)?.hold ?? undefined)) as { on: boolean; by: string };
  } finally {
    worker.socket.destroy();
  }
}

describe('a run started as the person chose', () => {
  test('runs headed and holds its failures when asked, and lets them go when asked though a breakpoint would hold them; a breakpoint never runs it headed', async () => {
    const plain = await runOf();
    expect(plain.args).not.toContain('--headed');
    expect(await holdOf(plain)).toEqual({ on: false, by: 'start' });

    const chosen = await runOf({ headed: true, holdFailures: true });
    expect(chosen.args).toContain('--headed');
    expect(await holdOf(chosen)).toEqual({ on: true, by: 'start' });

    const breakpoint = { uri: uri('tests/cart.spec.ts'), line: 2 };
    const held = await runOf({ breakpoints: [breakpoint] });
    expect(held.args).not.toContain('--headed');
    expect(await holdOf(held)).toEqual({ on: true, by: 'start' });
    const letGo = await runOf({ breakpoints: [breakpoint], holdFailures: false });
    expect(letGo.args).not.toContain('--headed');
    const shown = await runOf({ breakpoints: [breakpoint], headed: true });
    expect(shown.args).toContain('--headed');
    expect(await holdOf(letGo)).toEqual({ on: false, by: 'start' });
  });

  test('runs a breakpoint headed while the project’s reporter stops at none headless, or its version is unknown', async () => {
    const breakpoint = { uri: uri('tests/cart.spec.ts'), line: 2 };
    try {
      writeReporter('0.61.0');
      await svc.client.sendRequest('piwi/refresh');
      expect((await runOf({ breakpoints: [breakpoint] })).args).toContain('--headed');
      expect((await runOf()).args).not.toContain('--headed');
      writeReporter(null);
      await svc.client.sendRequest('piwi/refresh');
      expect((await runOf({ breakpoints: [breakpoint] })).args).toContain('--headed');
    } finally {
      writeReporter('0.62.0');
      await svc.client.sendRequest('piwi/refresh');
    }
    expect((await runOf({ breakpoints: [breakpoint] })).args).not.toContain('--headed');
  });

  test('runs a repeated run headed when asked, holding no failure even when asked, as nobody attends it', async () => {
    const repeated = (await svc.client.sendRequest('piwi/runArgs', {
      uri: uri('tests/cart.spec.ts'),
      testIds: [],
      locations: ['tests/cart.spec.ts:3'],
      repeat: 3,
      headed: true,
      holdFailures: true,
    })) as RunCommand;
    expect(repeated.args).toEqual(['tests/cart.spec.ts:3', '--repeat-each=3', '--retries=0', '--headed']);
    // Its workers keep a run connection, but the run has no Hold failures to turn on.
    const [channelPath, token] = repeated.env!.PIWI_RUN_CHANNEL!.split('#') as [string, string];
    const worker = new FakeWorker(channelPath, dir).attach(token, repeated.ref!, 0, [...RUN_TAKES]);
    try {
      expect(await worker.next('attached')).toMatchObject({ holds: [] });
      expect(await waitFor(() => svc.latest(repeated.ref!))).not.toHaveProperty('hold');
    } finally {
      worker.socket.destroy();
    }
  });

  test('lets the failures of a spec that pauses go on when asked, headed still', async () => {
    const pausing = await runOf({ locations: ['tests/pause.spec.ts:3'], holdFailures: false });
    expect(pausing.args).toContain('--headed');
    expect(await holdOf(pausing)).toEqual({ on: false, by: 'start' });
  });
});
