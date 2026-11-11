/**
 * The runs nobody attends that the service builds (Verify ×3, a fix plan's verification, a Flake Lab command): on the
 * run channel, listed as the editor's other runs, holding no failure.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseRecordChannel } from '@piwitests/core/ide-recorder';
import type { RunCommand, RunCommandArgs } from '../src/protocol';
import { FakeWorker, service, waitFor, writeRunWorkspace, type Service } from './run-fixtures';

describe('a run nobody attends', () => {
  let dir = '';
  let svc: Service;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-unattended-')));
    writeRunWorkspace(dir);
    svc = await service(dir, true);
    // The channel opens once the service is initialized.
    await svc.command();
  });

  afterAll(() => {
    svc?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A worker of the run `command` names attaches, saying it holds failures: what it hears back. */
  const attached = async (command: RunCommand) => {
    const channel = parseRecordChannel(command.env?.PIWI_RUN_CHANNEL);
    expect(channel).not.toBeNull();
    const worker = new FakeWorker(channel!.path, dir).attach(channel!.token, command.ref!);
    try {
      return await worker.next('attached');
    } finally {
      worker.socket.destroy();
    }
  };

  test('Verify ×3 runs on the run channel, listed, its workers told they hold no failure', async () => {
    const verify = (await svc.client.sendRequest('piwi/runArgs', {
      uri: pathToFileURL(path.join(dir, 'tests/cart.spec.ts')).href,
      testIds: [],
      locations: ['tests/cart.spec.ts:3'],
      repeat: 3,
    })) as RunCommand;
    expect(verify.args).toEqual(['tests/cart.spec.ts:3', '--repeat-each=3', '--retries=0']);
    // It turns headed for no breakpoint and no `page.pause()`, and holds what the run channel holds alone.
    expect(verify.env).not.toHaveProperty('PIWI_PAUSE_AT');
    expect(verify.env).not.toHaveProperty('PIWI_RECORD_CHANNEL');
    expect(await attached(verify)).toMatchObject({ type: 'attached', holds: [] });
    // Listed as a run nobody attends: it has no Hold failures.
    const listed = await waitFor(() => svc.latest(verify.ref!));
    expect(listed.ended).toBe(false);
    expect(listed).not.toHaveProperty('hold');
    // A person cannot turn its Hold failures on.
    const hold = await svc.client.sendRequest('piwi/holdRun', { ref: verify.ref, on: true });
    expect(hold).toMatchObject({ ok: false });
  });

  test('a command the service follows runs with a ref of its own on the run channel, holding no failure', async () => {
    const asked: RunCommandArgs = {
      cwd: dir,
      command: 'npx piwi flake --test 12 --plan plan.json',
      env: { PIWI_ORIGIN: 'editor' },
      follow: true,
    };
    const followed = (await svc.client.sendRequest('piwi/followCommand', asked)) as RunCommand;
    expect(followed).toEqual({
      cwd: dir,
      command: asked.command,
      args: [],
      env: {
        PIWI_ORIGIN: 'editor',
        PIWI_ORIGIN_REF: followed.ref,
        PIWI_RUN_CHANNEL: expect.stringMatching(/#[\w-]{16,}$/),
      },
      ref: expect.stringMatching(/^ed-[0-9a-f]{8}$/),
    });
    expect(await attached(followed)).toMatchObject({ type: 'attached', holds: [] });
    expect(await waitFor(() => svc.latest(followed.ref!))).not.toHaveProperty('hold');
    // A Playwright command keeps its arguments, which name its task.
    const verification = (await svc.client.sendRequest('piwi/followCommand', {
      ...asked,
      command: 'npx playwright test tests/cart.spec.ts:3 --repeat-each=5',
    })) as RunCommand;
    expect(verification.args).toEqual(['tests/cart.spec.ts:3', '--repeat-each=5']);
    // A folder no Playwright config of the workspace holds, or no command, is not followed.
    expect(await svc.client.sendRequest('piwi/followCommand', { ...asked, cwd: os.tmpdir() })).toBeNull();
    expect(await svc.client.sendRequest('piwi/followCommand', { ...asked, command: ' ' })).toBeNull();
  });

  test('a run of each test once keeps its Hold failures, which a person turns on', async () => {
    const { command } = await svc.command();
    await attached(command);
    expect(await waitFor(() => svc.latest(command.ref!))).toMatchObject({ hold: { on: false, by: 'start' } });
    expect(await svc.client.sendRequest('piwi/holdRun', { ref: command.ref, on: true })).toMatchObject({ ok: true });
  });
});
