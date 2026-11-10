import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FullConfig } from '@playwright/test/reporter';
import { afterEach, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunMainToHub, type RunMainToHub } from '@piwitests/core/run-channel';
import { RunHubLink } from '../src/internal/streaming/run-hub-link.js';

/**
 * The run's page on the instance, as the run's own connection tells the hub: each page that reads and differs from
 * the last, so the run the stream opened replaces the one the global setup registered, and nothing after `run-end`.
 */

const TOKEN = 'run-hub-page-token-0123456789';
const PAGE = 'https://piwi.example.com/test-runs/';
const CONFIG = { version: '1.60.0', workers: 1, shard: null } as unknown as FullConfig;

let folder = '';
let hub: net.Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (hub ? hub.close(() => resolve()) : resolve()));
  hub = null;
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

/** A hub on a socket of its own, the lines it heard, and the environment naming it. */
async function listen(): Promise<{ heard: RunMainToHub[]; closed: Promise<void>; env: NodeJS.ProcessEnv }> {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-hub-page-'));
  const socketPath = path.join(folder, 'channel.sock');
  const heard: RunMainToHub[] = [];
  let close: () => void = () => {};
  const closed = new Promise<void>((resolve) => (close = resolve));
  hub = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('close', close);
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunMainToHub(line);
          if (message) heard.push(message);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub!.listen(socketPath, resolve));
  const env = {
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: 'ed-0a1b2c3d',
  };
  return { heard, closed, env };
}

describe('the run’s page on the hub', () => {
  it('tells each page once, the stream’s run in place of the global setup’s, and nothing after the run ended', async () => {
    const { heard, closed, env } = await listen();
    const link = RunHubLink.open(env, CONFIG, 3, '0.68.0');
    expect(link).not.toBeNull();
    link!.page(78, `${PAGE}78`);
    link!.page(78, `${PAGE}78`);
    link!.page(null, null);
    link!.page(79, 'javascript:alert(1)');
    link!.page(79, `${PAGE}79`);
    await link!.end('passed');
    link!.page(80, `${PAGE}80`);
    await closed;
    expect(heard.filter((m) => m.type === 'run-page')).toEqual([
      { type: 'run-page', id: 78, url: `${PAGE}78` },
      { type: 'run-page', id: 79, url: `${PAGE}79` },
    ]);
    expect(heard.at(-1)?.type).toBe('run-end');
  });
});
