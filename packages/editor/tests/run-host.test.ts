/**
 * The run control as a host other than the language server builds it (`src/run-host.ts`, the desktop app's server):
 * the record channel's socket handing run connections to the sessions, the hub with the host's own token, a peer the
 * host joins to the hub with a transport of its own, and the intents the host declines.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { parseHubMessage, type HubMessage, type HubSession } from '@piwitests/core/run-hub';
import { RecordChannel, RunHub, RunSessions, StopActions, type HubPeer } from '../src/run-host';
import { FakeWorker, waitFor } from './run-fixtures';

const TOKEN = `pd_${'0f'.repeat(32)}`;
const ORIGIN = `chrome-extension://${'b'.repeat(32)}`;

let dir = '';
let channel: RecordChannel;
let hub: RunHub;
let sessions: RunSessions;
let surfaces = 0;

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-host-')));
  sessions = new RunSessions({
    notify: (session) => hub?.push(session),
    answersStops: () => hub.answersStops(),
    notice: () => {},
    rootOf: (cwd) => (cwd === dir ? dir : null),
    writesCode: () => true,
    declines: (what) => (what === 'record' ? 'No editor here takes a recording.' : null),
    host: 'the desktop app',
  });
  const actions = new StopActions({
    sessions,
    writesCode: () => true,
    notify: () => {},
    notice: () => {},
    target: () => null,
    lineNow: () => ({ refusal: 'none' }),
    language: () => null,
  });
  channel = (await RecordChannel.open({
    onAttach: (handoff) => channel.refuse(handoff.id, 'none'),
    onRun: (socket, attach) => sessions.attach(socket, attach),
  }))!;
  hub = (await RunHub.open({
    sessions,
    actions,
    runInfo: () => ({ command: null, label: null, project: null }),
    welcome: () => ({ pid: process.pid, version: '1.0.0', client: 'Host', roots: [dir] }),
    surfacesChanged: () => {
      surfaces++;
      sessions.surfacesChanged();
    },
    token: TOKEN,
    closing: 'The host stopped.',
  }))!;
});

afterAll(() => {
  hub?.close();
  channel?.close();
  sessions?.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A peer of the host's own transport: what it heard. */
function join(): { peer: HubPeer; heard: HubMessage[]; closed: { value: boolean } } {
  const heard: HubMessage[] = [];
  const closed = { value: false };
  const peer = hub.join({
    send: (message) => void heard.push(message),
    buffered: () => 0,
    close: () => {
      closed.value = true;
    },
  });
  return { peer, heard, closed };
}

const sessionOf = (heard: HubMessage[], ref: string): HubSession | undefined =>
  heard
    .filter((m): m is Extract<HubMessage, { type: 'session' }> => m.type === 'session' && m.session.ref === ref)
    .pop()?.session;

describe('a host of its own', () => {
  test('takes hello with the token it gave the hub', async () => {
    expect(hub.token).toBe(TOKEN);
    const socket = new WebSocket(hub.url, { origin: ORIGIN });
    const messages: HubMessage[] = [];
    socket.on('message', (data) => {
      const message = parseHubMessage(String(data));
      if (message) messages.push(message);
    });
    await new Promise((resolve) => socket.on('open', resolve));
    socket.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    expect(await waitFor(() => messages.find((m) => m.type === 'welcome'))).toMatchObject({ client: 'Host' });
    socket.close();
  });

  test('joins a peer that hears and commands the hub as a WebSocket does, and answers stops while subscribed', async () => {
    const { peer, heard } = join();
    // Not subscribed, it hears nothing and answers no stop.
    expect(hub.answersStops()).toBe(false);
    const before = surfaces;
    expect(await peer.command({ type: 'subscribe', id: 1 })).toEqual({
      type: 'answer',
      id: 1,
      ok: true,
      message: 'Following 0 runs.',
    });
    expect(hub.answersStops()).toBe(true);
    expect(surfaces).toBe(before + 1);

    const worker = new FakeWorker(channel.path, dir).attach(channel.token, 'host-1', 0, ['pick', 'record', 'view']);
    worker.begin();
    worker.stopAt(1, 9);
    const stop = await waitFor(() => sessionOf(heard, 'host-1')?.workers[0]?.stop ?? undefined);
    // A headless stop waits: the peer can answer it.
    expect(worker.heard.some((m) => m.type === 'control')).toBe(false);
    expect(sessionOf(heard, 'host-1')!.workers[0]!.intents).toEqual(['pick', 'view']);
    expect(await peer.command({ type: 'record', id: 2, ref: 'host-1', worker: 0, since: stop.since })).toMatchObject({
      ok: false,
      message: 'No editor here takes a recording.',
    });
    expect(
      await peer.command({ type: 'runControl', id: 3, ref: 'host-2', worker: null, action: 'pause', since: null }),
    ).toMatchObject({ ok: false, message: 'No worker of this run is connected to the desktop app.' });

    // The peer leaves: nobody answers the stop any more, and it goes on.
    peer.leave();
    expect(await worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
    expect(await peer.command({ type: 'subscribe', id: 4 })).toMatchObject({ ok: false });
    worker.socket.destroy();
  });

  test('lets a joined peer go as it closes', () => {
    const { closed } = join();
    const other = new RunSessions({
      notify: () => {},
      answersStops: () => false,
      notice: () => {},
      rootOf: () => null,
    });
    expect(other.intentsOf('none', 0)).toEqual([]);
    hub.close();
    expect(closed.value).toBe(true);
  });
});
