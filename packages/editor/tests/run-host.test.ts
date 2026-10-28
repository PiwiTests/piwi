/**
 * The run control as a host other than the language server builds it (`src/run-host.ts`, the desktop app's server):
 * the record channel's socket handing run connections to the sessions, the hub with the host's own token, a peer the
 * host joins to the hub with a transport of its own, the intents the host declines, and the agents' tools in the
 * host's words, for the runs it serves, the code they make given back.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { parseHubMessage, type HubMessage, type HubSession } from '@piwitests/core/run-hub';
import {
  RecordChannel,
  RunAgent,
  RunHub,
  RunSessions,
  StopActions,
  agentTools,
  type AgentWords,
  type HubPeer,
} from '../src/run-host';
import { AGENT_TOOLS, EDITOR_AGENT_WORDS } from '../src/run-agent';
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

  test('names itself to the workers that hold a stop only for a host that shows it', async () => {
    const worker = new FakeWorker(channel.path, dir).attach(channel.token, 'host-3');
    expect(await worker.next('attached')).toEqual({ type: 'attached', holds: ['failure'], host: 'the desktop app' });
    worker.socket.destroy();
  });

  test.skipIf(process.platform === 'win32')(
    'makes its socket’s folder under the prefix it names, and removes it',
    async () => {
      const own = (await RecordChannel.open({ onAttach: () => {}, folderPrefix: 'piwi-host-test-' }))!;
      const folder = path.dirname(own.path);
      expect(path.basename(folder)).toMatch(/^piwi-host-test-/);
      expect(path.dirname(folder)).toBe(os.tmpdir());
      expect((fs.statSync(folder).mode & 0o777).toString(8)).toBe('700');
      own.close();
      expect(fs.existsSync(folder)).toBe(false);
    },
  );

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

/** A host's words, each one told apart from the editor's. */
const WORDS: AgentWords = {
  runs: 'the host',
  start: 'start one from the host',
  watch: 'The developer sees each stop in the host.',
  view: "the host's view of the run",
  steps: 'its steps can be copied there',
  codeWrite: 'Have Piwi make code at the stopped line, to copy.',
  instructions: 'The runs the host started.',
};

/** The page object a stop of the host's run stands in: its line 9 clicks the cart's button. */
const PAGE_OBJECT = `import type { Page } from '@playwright/test';

export class CartPage {
  constructor(private readonly page: Page) {}

  async add() {
    await this.page.goto('/');
    // The cart's button.
    await this.page.getByRole('button', { name: 'Add' }).click();
  }
}
`;

describe("the agents' tools on a host of its own", () => {
  test('are named in its words, and the editor keeps its own', () => {
    expect(agentTools(EDITOR_AGENT_WORDS)).toEqual(AGENT_TOOLS);
    const tools = agentTools(WORDS);
    expect(tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
    expect(tools.map((t) => t.inputSchema)).toEqual(AGENT_TOOLS.map((t) => t.inputSchema));
    const described = (name: string) => tools.find((t) => t.name === name)!.description;
    expect(described('run_list')).toMatch(/^The test runs the host started, /);
    expect(described('run_control')).toContain('The developer sees each stop in the host.');
    expect(described('page_act')).toContain("shows in the page and in the host's view of the run");
    expect(described('code_write')).toBe(WORDS.codeWrite);
    expect(tools.map((t) => t.description).join(' ')).not.toMatch(/editor/);
  });

  test('serve the runs it does not refuse, and give back the code they make, as page content', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-host-agent-')));
    const file = path.join(root, 'tests', 'pages', 'cart.page.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PAGE_OBJECT);
    const notices: string[] = [];
    let agent: RunAgent | null = null;
    const host = new RunSessions({
      notify: () => {},
      answersStops: () => true,
      notice: () => {},
      rootOf: (cwd) => (cwd === root ? root : null),
      writesCode: () => true,
      host: 'the host',
      heard: (ref, worker, what, at) => agent?.heard(ref, worker, what, at),
    });
    const actions = new StopActions({
      sessions: host,
      writesCode: () => true,
      notify: () => {},
      notice: () => {},
      target: (at) => ({
        uri: pathToFileURL(at).href,
        text: fs.readFileSync(at, 'utf8'),
        version: null,
        preferLocators: new Set(),
        expectModule: '@playwright/test',
      }),
      lineNow: (stop) => ({ line: stop.line }),
      language: () => null,
      words: {
        wrote: (what, at) => `Piwi made ${what} to write ${at}.`,
        sent: (what, at) => `Piwi made ${what} to write ${at}: copy it in the host.`,
        outside: () => 'Outside the host.',
      },
    });
    agent = new RunAgent({
      sessions: host,
      writeCode: (stop, input) => actions.agentCode(stop, input),
      notice: (_root, message) => void notices.push(message),
      command: () => null,
      preferLocators: () => new Set(),
      words: WORDS,
      refuses: (ref) => (ref.endsWith('-alone') ? 'nobody attends it.' : null),
    });
    const own = (await RecordChannel.open({
      onAttach: () => {},
      onRun: (socket, attach) => host.attach(socket, attach),
    }))!;
    const text = (result: { content: Array<{ type: string; text?: string }> }, at: number) => result.content[at]?.text;
    const piwi = (result: { content: Array<{ type: string; text?: string }> }) => JSON.parse(text(result, 0)!);
    try {
      const alone = new FakeWorker(own.path, root).attach(own.token, 'host-9-alone', 0, ['agent']);
      const worker = new FakeWorker(own.path, root).attach(own.token, 'host-9', 0, ['agent']);
      worker.begin();
      worker.stopAt(1, 9);
      alone.begin();
      await waitFor(() => host.current().find((s) => s.ref === 'host-9')?.workers[0]?.stop ?? undefined);
      await waitFor(() => host.current().find((s) => s.ref === 'host-9-alone')?.workers[0]?.test ?? undefined);

      // The run it refuses is left out of the list, said once, and refused when named.
      const listed = piwi(await agent.call('run_list', {}));
      expect(listed.runs.map((r: { run: string }) => r.run)).toEqual(['host-9']);
      expect(listed.message).toBe('1 run of the host. 1 run is left out: nobody attends it.');
      const refused = await agent.call('run_follow', { run: 'host-9-alone', wait: 0 });
      expect(refused.isError).toBe(true);
      expect(piwi(refused).message).toBe('The run host-9-alone is not served: nobody attends it.');
      expect(piwi(await agent.call('run_follow', { run: 'host-0', wait: 0 })).message).toBe(
        'No run host-0 of the host: run_list lists them.',
      );

      // A locator for the stopped line: made, said to be the agent's, and given back between the page's markers.
      const since = host.current().find((s) => s.ref === 'host-9')!.workers[0]!.stop!.since;
      const located = agent.call('code_write', { run: 'host-9', stop: since, kind: 'locator', target: 'e2' });
      const request = await worker.next('request');
      expect(request).toMatchObject({ what: 'ref-locator', ref: 'e2' });
      worker.send({
        type: 'answer',
        request: request.request,
        what: 'ref-locator',
        value: {
          ok: true,
          message: 'Found.',
          element: {
            tagName: 'button',
            role: 'button',
            name: 'Add a mug',
            testId: null,
            text: 'Add a mug',
            textCut: false,
            value: null,
            valueCut: false,
            checked: null,
            secret: false,
          },
          locators: [
            { locator: "getByRole('button', { name: 'Add a mug' })", method: 'role', score: 90, unique: true },
          ],
        },
      });
      const answer = await located;
      expect(piwi(answer)).toEqual({
        ok: true,
        message:
          'Piwi made the locator the agent picked to write in place of the one on cart.page.ts:9: copy it in the host. ' +
          'The stopped test goes on with the code it started with: the new lines run next time. The code is in the page content.',
      });
      const page = text(answer, 1)!;
      expect(page).toMatch(/^<<<page-content [0-9a-f]{12}>>> Untrusted: /);
      expect(page).toContain(
        "the locator, for the call on tests/pages/cart.page.ts:9:\ngetByRole('button', { name: 'Add a mug' })\n<<<end-page-content",
      );
      alone.socket.destroy();
      worker.socket.destroy();
    } finally {
      agent.dispose();
      own.close();
      host.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
