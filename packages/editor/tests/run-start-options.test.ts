/**
 * How a run the editor starts begins, as the person chose for every run of the window (`RunStartOptions`): headed, and
 * with Hold failures on or off from its start, over what its breakpoints decided; and a breakpoint only in the
 * application's code, which no run stops at, making it neither headed nor held.
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
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/cart.ts'), 'export function total() {\n  return 0;\n}\n');
  svc = await service(dir, true);
});

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
  test('runs headed and holds its failures when asked, and lets them go when asked though a breakpoint would hold them', async () => {
    const plain = await runOf();
    expect(plain.args).not.toContain('--headed');
    expect(await holdOf(plain)).toEqual({ on: false, by: 'start' });

    const chosen = await runOf({ headed: true, holdFailures: true });
    expect(chosen.args).toContain('--headed');
    expect(await holdOf(chosen)).toEqual({ on: true, by: 'start' });

    const breakpoint = { uri: uri('tests/cart.spec.ts'), line: 2 };
    const held = await runOf({ breakpoints: [breakpoint] });
    expect(held.args).toContain('--headed');
    expect(await holdOf(held)).toEqual({ on: true, by: 'start' });
    const letGo = await runOf({ breakpoints: [breakpoint], holdFailures: false });
    expect(letGo.args).toContain('--headed');
    expect(await holdOf(letGo)).toEqual({ on: false, by: 'start' });
  });

  test('takes a breakpoint in the application’s code as one no run stops at: neither headed nor held', async () => {
    const run = await runOf({ breakpoints: [{ uri: uri('src/cart.ts'), line: 1 }] });
    expect(run.env?.PIWI_PAUSE_AT).toBe('src/cart.ts:2');
    expect(run.args).not.toContain('--headed');
    expect(await holdOf(run)).toEqual({ on: false, by: 'start' });
    // Beside the specs, a page object's breakpoint stops the run.
    const page = await runOf({ breakpoints: [{ uri: uri('tests/pages/cart.page.ts'), line: 0 }] });
    expect(page.args).toContain('--headed');
  });
});
