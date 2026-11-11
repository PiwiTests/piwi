import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITOR_CHALLENGE_HEADER, EDITOR_PROOF_HEADER, editorTokenProof } from '@piwitests/core/editor-send';
import { HUB_CLOSE, type HubSession, type HubWorker, type LiveHub } from '@piwitests/core/run-hub';
import type { HubSocket } from '../../src/background/hub-connection.js';
import { RunHubs, type RunHubsDeps, type RunsViewer } from '../../src/background/run-hubs.js';
import type { RunsFrame, RunsLane, RunsLaneFrame, RunsView } from '../../src/shared/runs.js';

/**
 * The worker's hub client against a stub: the editor's live endpoint as a fetch that answers what a test says (a
 * request with a challenge alone is answered as the editor answers it, with the proof, refused), and each hub as a
 * socket the test plays the hub's side of, message by message.
 */

const PAIRING = { url: 'http://127.0.0.1:47211/piwi/send', token: 'pairing_token_0123456789' };
const HUB: LiveHub = {
  url: 'ws://127.0.0.1:50123/piwi/hub',
  token: 'hub_token_abcdefghijklmnop',
  pid: 4242,
  version: '0.60.0',
  client: 'Visual Studio Code',
  roots: ['/home/me/shop'],
  startedAt: '2026-10-27T10:00:00.000Z',
};
const OTHER_HUB: LiveHub = {
  ...HUB,
  url: 'ws://127.0.0.1:50124/piwi/hub',
  token: 'other_token_abcdefghijkl',
  pid: 4243,
};

/** The paired desktop app's hub, which its server is, with the app's token. */
const DESKTOP_HUB: LiveHub = {
  url: 'ws://127.0.0.1:50200/piwi/hub',
  token: 'pd_desktop_token_0123456789',
  pid: 5151,
  version: '0.62.0',
  client: 'Piwi desktop app',
  roots: ['/home/me/shop'],
  startedAt: '2026-10-28T10:00:00.000Z',
};

const RUNNING: HubWorker = {
  worker: 0,
  parallelIndex: 0,
  state: 'running',
  pausing: false,
  intents: ['pick', 'record'],
  test: {
    id: 't1',
    title: ['cart', 'adds a mug'],
    uri: 'file:///home/me/shop/tests/cart.spec.ts',
    line: 2,
    project: 'chromium',
    retry: 0,
    cannotPause: null,
  },
  stop: null,
};
const STOPPED: HubWorker = {
  ...RUNNING,
  worker: 1,
  parallelIndex: 1,
  state: 'stopped',
  stop: {
    reason: 'breakpoint',
    title: "Click getByRole('button', { name: 'Add' })",
    uri: 'file:///home/me/shop/tests/pages/cart.page.ts',
    line: 12,
    character: 4,
    locator: "getByRole('button', { name: 'Add' })",
    bar: true,
    since: 's7',
  },
};

function session(workers: HubWorker[], extra: Partial<HubSession> = {}): HubSession {
  return {
    ref: 'r1',
    root: '/home/me/shop',
    label: 'shop',
    command: 'npx playwright test tests/cart.spec.ts',
    project: 'Shop',
    workers,
    ended: false,
    ...extra,
  };
}

/** A hub's socket, played by the test: what the extension sent, and the hub's side. */
class FakeSocket implements HubSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  opened = false;
  onopen: HubSocket['onopen'] = null;
  onmessage: HubSocket['onmessage'] = null;
  onclose: HubSocket['onclose'] = null;
  onerror: HubSocket['onerror'] = null;

  constructor(readonly url: string) {}

  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }

  close(code = 1000): void {
    if (this.closedWith !== null) return;
    this.closedWith = code;
    this.onclose?.({ code });
  }

  /** The hub: the socket opens. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.onopen?.({});
  }

  /** The hub: sends a message. */
  hear(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  /** The hub: closes the connection with `code`. */
  hangUp(code: number): void {
    this.closedWith = code;
    this.onclose?.({ code });
  }

  last(type: string): Record<string, unknown> | undefined {
    return this.sent.filter((m) => m.type === type).pop();
  }
}

/** How the program on the paired port answers a challenge: as the editor, with a wrong proof, with none, or not. */
type Prover = 'editor' | 'wrong' | 'none' | 'none-404' | 'unreachable';

async function proofAnswer(prover: Prover, challenge: string): Promise<Response> {
  if (prover === 'unreachable') throw new TypeError('Failed to fetch');
  const headers: Record<string, string> = {};
  if (prover === 'editor') headers[EDITOR_PROOF_HEADER] = await editorTokenProof(PAIRING.token, 47211, challenge);
  if (prover === 'wrong')
    headers[EDITOR_PROOF_HEADER] = await editorTokenProof('another_token_0123456789', 47211, challenge);
  if (prover === 'none-404') return Response.json({ error: 'not found' }, { status: 404, headers });
  return Response.json({ error: 'not paired' }, { status: 401, headers });
}

function setup(over: Partial<RunHubsDeps> = {}) {
  const sockets: FakeSocket[] = [];
  const stored = { hubs: [] as LiveHub[] };
  /** The requests that carried the pairing's token. */
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const challenges: string[] = [];
  let prover: Prover = 'editor';
  let respond: () => Promise<Response> = async () => Response.json({ hubs: [HUB] });
  const deps: RunHubsDeps = {
    pairing: async () => PAIRING,
    granted: async () => true,
    fetch: async (url, init) => {
      const challenge = (init.headers as Record<string, string> | undefined)?.[EDITOR_CHALLENGE_HEADER];
      if (challenge) {
        expect(init.headers).toEqual({ [EDITOR_CHALLENGE_HEADER]: challenge });
        challenges.push(challenge);
        return proofAnswer(prover, challenge);
      }
      fetches.push({ url, init });
      return respond();
    },
    open: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    readHubs: async () => stored.hubs,
    writeHubs: async (hubs) => {
      stored.hubs = hubs;
    },
    timings: { answerMs: 1000, welcomeMs: 2000, silenceSlackMs: 500 },
    ...over,
  };
  return {
    hubs: new RunHubs(deps),
    sockets,
    stored,
    fetches,
    challenges,
    answer(next: () => Promise<Response>) {
      respond = next;
    },
    prove(next: Prover) {
      prover = next;
    },
  };
}

/**
 * The hub's side of the handshake: open, welcome (with the `features` it lists, none for a hub that predates them),
 * answer `subscribe`, then send `sessions`.
 */
async function welcome(
  socket: FakeSocket,
  sessions: HubSession[] = [],
  keepaliveMs = 20_000,
  features?: string[],
): Promise<void> {
  socket.open();
  socket.hear({
    type: 'welcome',
    pid: 4242,
    version: '0.60.0',
    client: 'Visual Studio Code',
    roots: [],
    keepaliveMs,
    ...(features ? { features } : {}),
  });
  const subscribe = socket.last('subscribe')!;
  socket.hear({ type: 'answer', id: subscribe.id, ok: true, message: `Following ${sessions.length} runs.` });
  for (const s of sessions) socket.hear({ type: 'session', session: s });
  await vi.advanceTimersByTimeAsync(60);
}

/**
 * Lets the work the timers do not drive finish: the proof's HMAC (`crypto.subtle`) resolves outside them. Until
 * `check` holds, for five seconds at most of real time, which the fake timers leave alone.
 */
async function until(check: () => boolean): Promise<void> {
  const start = performance.now();
  while (!check() && performance.now() - start < 5000) await new Promise((resolve) => setImmediate(resolve));
}

/** A few turns of the event loop, for a check that nothing more happened. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('finding the hubs through the pairing', () => {
  it('asks the live endpoint beside send with the pairing’s token, keeps the hubs in the secret area, connects', async () => {
    const { hubs, fetches, stored, sockets, challenges } = setup();
    await hubs.find();
    // A challenge alone first, a new one each time.
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url).toBe('http://127.0.0.1:47211/piwi/live');
    expect(fetches[0]!.init.headers).toEqual({ Authorization: `Bearer ${PAIRING.token}` });
    expect(fetches[0]!.init.redirect).toBe('error');
    expect(stored.hubs).toEqual([HUB]);
    expect(sockets.map((s) => s.url)).toEqual([HUB.url]);
    expect(hubs.state()).toMatchObject({ discovery: 'found', hubs: [{ id: HUB.url, connected: false }] });
  });

  it('asks nothing without a pairing, or without the grant for the editor’s address', async () => {
    const unpaired = setup({ pairing: async () => null });
    await unpaired.hubs.find();
    expect(unpaired.fetches).toEqual([]);
    expect(unpaired.hubs.state().discovery).toBe('unpaired');

    const denied = setup({ granted: async () => false });
    await denied.hubs.find();
    expect(denied.fetches).toEqual([]);
    expect(denied.hubs.state().discovery).toBe('no-access');
  });

  it('says why the editor gave no hubs: a refused token drops the hubs kept, an older editor has none', async () => {
    const { hubs, stored, answer, sockets } = setup();
    await hubs.find();
    answer(async () => Response.json({ error: 'not paired' }, { status: 401 }));
    await hubs.find();
    expect(hubs.state()).toMatchObject({ discovery: 'refused', hubs: [], runs: [] });
    expect(stored.hubs).toEqual([]);
    expect(sockets[0]!.closedWith).toBe(1000);

    answer(async () => Response.json({ error: 'not found' }, { status: 404 }));
    await hubs.find();
    expect(hubs.state().discovery).toBe('outdated');
  });

  it('connects to the hubs found last when the editor’s endpoint does not answer', async () => {
    const { hubs, stored, prove, sockets } = setup();
    stored.hubs = [OTHER_HUB];
    prove('unreachable');
    await hubs.find();
    expect(hubs.state().discovery).toBe('unreachable');
    expect(sockets.map((s) => s.url)).toEqual([OTHER_HUB.url]);
  });

  it('connects to none of the hubs found last while the program on the paired port cannot prove it', async () => {
    const { hubs, stored, prove, sockets } = setup();
    await hubs.find();
    expect(sockets.map((s) => s.url)).toEqual([HUB.url]);
    prove('wrong');
    await hubs.find();
    expect(hubs.state()).toMatchObject({ discovery: 'unproven', hubs: [] });
    // The connection made while the editor proved itself is closed, and no other is opened.
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(sockets).toHaveLength(1);
    // The hubs stay kept for an editor that proves itself, or does not answer, later.
    expect(stored.hubs).toEqual([HUB]);
  });

  it('sends the token nowhere the program on the paired port cannot prove it holds it', async () => {
    const { hubs, fetches, prove, challenges } = setup();
    for (const prover of ['wrong', 'none'] as const) {
      prove(prover);
      await hubs.find();
      expect(hubs.state().discovery).toBe('unproven');
    }
    expect(challenges).toHaveLength(2);
    expect(new Set(challenges).size).toBe(2);
    expect(fetches).toEqual([]);
    // And asks again a moment later.
    prove('editor');
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => hubs.state().discovery === 'found');
    expect(hubs.state().discovery).toBe('found');
    expect(fetches).toHaveLength(1);
  });

  it('takes an endpoint that answers 404 with no proof as no editor, and sends it nothing', async () => {
    const { hubs, fetches, prove } = setup();
    prove('none-404');
    await hubs.find();
    expect(hubs.state().discovery).toBe('not-editor');
    expect(fetches).toEqual([]);
  });

  it('asks a program that cannot prove it holds the token again a few times in a row, then once a minute', async () => {
    const { hubs, prove, challenges } = setup();
    /** Whether a look for the hubs is under way: its proof runs outside the fake timers. */
    const finding = () => (hubs as unknown as { finding: Promise<void> | null }).finding !== null;
    hubs.listen(() => {});
    prove('wrong');
    await hubs.find();
    // The backoff asks again at 1, 3, 7 and 15 s, then no more: the minute's look again alone.
    for (let second = 1; second <= 55; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      await until(() => !finding());
    }
    expect(challenges).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(5000);
    await until(() => challenges.length === 6);
    expect(challenges).toHaveLength(6);
    // Proven again, it is found.
    prove('editor');
    await until(() => !finding());
    await hubs.find();
    await until(() => hubs.state().discovery === 'found');
    expect(hubs.state().discovery).toBe('found');
  });

  it('leaves out an entry it cannot read', async () => {
    const { hubs, answer, sockets } = setup();
    answer(async () => Response.json({ hubs: [{ ...HUB, url: 'ws://evil.example/piwi/hub' }, HUB] }));
    await hubs.find();
    expect(sockets.map((s) => s.url)).toEqual([HUB.url]);
  });
});

describe('the desktop app’s hub', () => {
  it('is connected beside the editor’s with the app’s token, its runs shown apart, and never kept', async () => {
    const { hubs, sockets, stored } = setup({ desktopHubs: async () => ({ discovery: 'found', hubs: [DESKTOP_HUB] }) });
    await hubs.find();
    expect(sockets.map((s) => s.url)).toEqual([HUB.url, DESKTOP_HUB.url]);
    // Only the editor's hubs go to the secret area: the app names its own each time.
    expect(stored.hubs).toEqual([HUB]);
    const desktop = sockets[1]!;
    desktop.open();
    expect(desktop.sent).toEqual([{ type: 'hello', token: DESKTOP_HUB.token }]);
    await welcome(desktop, [session([STOPPED], { ref: 'desktop-7', command: null })]);
    const state = hubs.state();
    expect(state).toMatchObject({
      discovery: 'found',
      desktop: 'found',
      hubs: [
        { id: HUB.url, desktop: false },
        { id: DESKTOP_HUB.url, desktop: true, connected: true },
      ],
    });
    expect(state.runs.map((run) => [run.hub, run.session.ref])).toEqual([[DESKTOP_HUB.url, 'desktop-7']]);
    expect(JSON.stringify(state)).not.toContain(DESKTOP_HUB.token);
  });

  it('shows its runs with no editor paired, and is asked again while it does not answer', async () => {
    let answer: () => Promise<{ discovery: 'found' | 'unreachable'; hubs: LiveHub[] }> = async () => ({
      discovery: 'unreachable',
      hubs: [],
    });
    const { hubs, sockets, fetches } = setup({ pairing: async () => null, desktopHubs: () => answer() });
    await hubs.find();
    expect(hubs.state()).toMatchObject({ discovery: 'unpaired', desktop: 'unreachable', hubs: [] });
    expect(fetches).toEqual([]);
    answer = async () => ({ discovery: 'found', hubs: [DESKTOP_HUB] });
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => sockets.length === 1);
    await welcome(sockets[0]!, [session([RUNNING], { ref: 'desktop-7' })]);
    expect(hubs.state()).toMatchObject({ discovery: 'unpaired', desktop: 'found' });
    expect(hubs.connected()).toBe(true);
    expect(hubs.state().runs).toHaveLength(1);
  });

  it('is let go with the pairing, and dropped when it refuses the token, the editor’s hubs kept', async () => {
    let desktop: { discovery: 'found' | 'unpaired'; hubs: LiveHub[] } = { discovery: 'found', hubs: [DESKTOP_HUB] };
    const { hubs, sockets, stored } = setup({ desktopHubs: async () => desktop });
    await hubs.find();
    await welcome(sockets[1]!, [session([RUNNING], { ref: 'desktop-7' })]);
    sockets[1]!.hear({ type: 'session', session: session([], { ref: 'desktop-7', ended: true }) });
    expect(hubs.state().runs).toHaveLength(1);
    // Unpaired: its connection closes and its ended run goes with it.
    desktop = { discovery: 'unpaired', hubs: [] };
    await hubs.find();
    expect(sockets[1]!.closedWith).toBe(1000);
    expect(hubs.state()).toMatchObject({ desktop: 'unpaired', hubs: [{ id: HUB.url }], runs: [] });

    // Paired again, then refused: the app's hub is dropped, the editor's stay kept.
    desktop = { discovery: 'found', hubs: [DESKTOP_HUB] };
    await hubs.find();
    const again = sockets[2]!;
    expect(again.url).toBe(DESKTOP_HUB.url);
    again.open();
    again.hangUp(HUB_CLOSE.unauthorized);
    expect(hubs.state().hubs.map((h) => h.id)).toEqual([HUB.url]);
    await settle();
    expect(stored.hubs).toEqual([HUB]);
  });
});

describe('a hub’s connection', () => {
  it('says hello with the hub’s token, subscribes once welcomed, and keeps the runs it pushes', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    const socket = sockets[0]!;
    socket.open();
    expect(socket.sent).toEqual([{ type: 'hello', token: HUB.token }]);
    await welcome(socket, [session([RUNNING])]);
    expect(socket.sent[1]).toEqual({ type: 'subscribe', id: 1 });
    expect(hubs.connected()).toBe(true);
    expect(hubs.state().runs).toEqual([{ hub: HUB.url, session: session([RUNNING]) }]);

    socket.hear({ type: 'session', session: session([STOPPED]) });
    expect(hubs.state().runs[0]!.session.workers).toEqual([STOPPED]);
    // No token reaches the window's state.
    expect(JSON.stringify(hubs.state())).not.toContain(HUB.token);
  });

  it('keeps an ended run with the tests it ran last, out of the live runs', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    await welcome(sockets[0]!, [session([RUNNING])]);
    sockets[0]!.hear({ type: 'session', session: session([], { ended: true }) });
    const { runs } = hubs.state();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.session).toMatchObject({ ended: true, workers: [RUNNING] });
    // Ten minutes later, it is gone.
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(hubs.state().runs).toEqual([]);
  });

  it('shows a run of a ref that runs again as the live one alone, not the one of that ref that ended', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    await welcome(sockets[0]!, [session([RUNNING])]);
    sockets[0]!.hear({ type: 'session', session: session([], { ended: true }) });
    expect(hubs.state().runs.map((run) => run.session.ended)).toEqual([true]);
    sockets[0]!.hear({ type: 'session', session: session([RUNNING]) });
    expect(hubs.state().runs).toEqual([{ hub: HUB.url, session: session([RUNNING]) }]);
  });

  it('ignores a message it cannot read, and anything before the welcome', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    const socket = sockets[0]!;
    socket.open();
    socket.hear({ type: 'session', session: session([RUNNING]) });
    expect(hubs.state().runs).toEqual([]);
    await welcome(socket);
    socket.hear('not json');
    socket.hear({ type: 'session', session: { ...session([RUNNING]), ref: '../../etc' } });
    socket.hear({ type: 'news', text: 'a newer hub’s message' });
    expect(hubs.state().runs).toEqual([]);
    expect(socket.closedWith).toBeNull();
  });

  it('tells each listener what a code written at a stop came to, with its hub, and never its code', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    const socket = sockets[0]!;
    await welcome(socket, [session([STOPPED])]);
    const heard: unknown[] = [];
    const changes = vi.fn();
    const unlisten = hubs.listen(changes, (code) => heard.push(code));
    const written = {
      type: 'code',
      ref: 'r1',
      worker: 1,
      since: 's7',
      action: 'assert',
      ok: true,
      message: 'Piwi sent the check to Visual Studio Code to write above cart.page.ts:13.',
    };
    socket.hear({ ...written, code: "await expect(page.getByTestId('total')).toHaveText('72');" });
    socket.hear({
      ...written,
      action: 'mock',
      message: 'Piwi sent the mock to Visual Studio Code to write above cart.page.ts:13.',
      warnings: ['A value named or shaped like a credential is written as <hidden>.'],
    });
    // One it cannot read is left aside.
    socket.hear({ ...written, worker: 'all' });
    socket.hear({ ...written, warnings: 'none' });
    expect(heard).toEqual([
      {
        hub: HUB.url,
        ref: 'r1',
        worker: 1,
        since: 's7',
        action: 'assert',
        ok: true,
        message: 'Piwi sent the check to Visual Studio Code to write above cart.page.ts:13.',
        warnings: [],
      },
      {
        hub: HUB.url,
        ref: 'r1',
        worker: 1,
        since: 's7',
        action: 'mock',
        ok: true,
        message: 'Piwi sent the mock to Visual Studio Code to write above cart.page.ts:13.',
        warnings: ['A value named or shaped like a credential is written as <hidden>.'],
      },
    ]);
    expect(JSON.stringify(heard)).not.toContain('toHaveText');
    // It changes no run: the state stays as it was.
    expect(changes).not.toHaveBeenCalled();
    unlisten();
    socket.hear(written);
    expect(heard).toHaveLength(2);
  });

  it('tells each hub the runs are followed while a Runs window is open, and again after it connects anew', async () => {
    const { hubs, sockets, answer } = setup();
    answer(async () => Response.json({ hubs: [HUB, OTHER_HUB] }));
    await hubs.find();
    const [first, second] = sockets;
    await welcome(first!);
    await welcome(second!);
    const follows = (socket: FakeSocket) => socket.sent.filter((m) => m.type === 'follow').map((m) => m.on);
    // Paired, no window open: the background worker subscribes and says nothing more, so no failure waits for it.
    expect(follows(first!)).toEqual([]);
    const closeFirst = hubs.listen(() => {});
    expect(follows(first!)).toEqual([true]);
    expect(follows(second!)).toEqual([true]);
    expect(first!.last('follow')).toMatchObject({ id: expect.any(Number) });
    // A second window says nothing more; the last one to close says the runs are no longer followed.
    const closeSecond = hubs.listen(() => {});
    closeFirst();
    closeFirst();
    expect(follows(first!)).toEqual([true]);
    closeSecond();
    expect(follows(first!)).toEqual([true, false]);
    expect(follows(second!)).toEqual([true, false]);
    // A window open while a hub's connection is lost and made again: the new connection says so as it opens.
    hubs.listen(() => {});
    first!.hangUp(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => sockets.length === 3);
    const again = sockets[2]!;
    expect(follows(again)).toEqual([]);
    await welcome(again);
    expect(follows(again)).toEqual([true]);
    expect(again.sent.map((m) => m.type)).toEqual(['hello', 'subscribe', 'follow']);
  });

  it('passes each command on and hands back the answer of its id', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    const socket = sockets[0]!;
    await welcome(socket, [session([STOPPED])]);
    const step = hubs.command({ hub: HUB.url, ref: 'r1', worker: 1, since: 's7', what: 'step' });
    const image = hubs.command({ hub: HUB.url, ref: 'r1', worker: 1, since: 's7', what: 'image' });
    const pick = hubs.command({ hub: HUB.url, ref: 'r1', worker: null, since: 's7', what: 'pick' });
    void hubs.command({ hub: HUB.url, ref: 'r1', worker: 1, since: 's7', what: 'end' });
    expect(socket.sent.slice(2)).toEqual([
      { type: 'runControl', id: 2, ref: 'r1', worker: 1, action: 'step', since: 's7' },
      { type: 'pausedPage', id: 3, ref: 'r1', worker: 1 },
      { type: 'pick', id: 4, ref: 'r1', worker: null, since: 's7' },
      { type: 'runControl', id: 5, ref: 'r1', worker: 1, action: 'end', since: 's7' },
    ]);
    socket.hear({ type: 'answer', id: 4, ok: false, message: 'Pick needs the pause bar.' });
    socket.hear({
      type: 'answer',
      id: 3,
      ok: true,
      message: 'The stopped page.',
      image: { mime: 'image/jpeg', data: 'AAAA' },
    });
    socket.hear({ type: 'answer', id: 99, ok: true, message: 'Not ours.' });
    socket.hear({ type: 'answer', id: 2, ok: true, message: 'Stepped.' });
    expect(await step).toEqual({ ok: true, message: 'Stepped.' });
    // The hub's own id stays with the connection.
    expect(await image).toEqual({
      ok: true,
      message: 'The stopped page.',
      image: { mime: 'image/jpeg', data: 'AAAA' },
    });
    expect(await pick).toEqual({ ok: false, message: 'Pick needs the pause bar.' });
  });

  it('passes Share live on for the run it names, and hands back its answer', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    const socket = sockets[0]!;
    await welcome(socket, [session([STOPPED])]);
    const shared = hubs.command({ hub: HUB.url, ref: 'r1', worker: null, since: null, what: 'share', on: true });
    void hubs.command({ hub: HUB.url, ref: 'r1', worker: null, since: null, what: 'share', on: false });
    expect(socket.sent.slice(2)).toEqual([
      { type: 'share', id: 2, ref: 'r1', on: true },
      { type: 'share', id: 3, ref: 'r1', on: false },
    ]);
    socket.hear({ type: 'answer', id: 2, ok: true, message: 'Sharing the run live on piwi.example.com.' });
    expect(await shared).toEqual({ ok: true, message: 'Sharing the run live on piwi.example.com.' });
  });

  it('passes the code a stop can write on, each naming its stop, and hands back the requests the test kept', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    const socket = sockets[0]!;
    await welcome(socket, [session([{ ...STOPPED, intents: ['pick', 'record', 'assert', 'assert-region', 'mock'] }])]);
    expect(hubs.state().runs[0]!.session.workers[0]!.intents).toEqual([
      'pick',
      'record',
      'assert',
      'assert-region',
      'mock',
    ]);
    const at = { hub: HUB.url, ref: 'r1', worker: 1, since: 's7' };
    const assert = hubs.command({ ...at, what: 'assert' });
    const region = hubs.command({ ...at, what: 'assert-region' });
    const listed = hubs.command({ ...at, what: 'requests' });
    const mock = hubs.command({ ...at, what: 'mock', request: 2 });
    expect(socket.sent.slice(2)).toEqual([
      { type: 'assert', id: 2, ref: 'r1', worker: 1, since: 's7' },
      { type: 'assert-region', id: 3, ref: 'r1', worker: 1, since: 's7' },
      { type: 'requests', id: 4, ref: 'r1', worker: 1, since: 's7' },
      { type: 'mock', id: 5, ref: 'r1', worker: 1, since: 's7', request: 2 },
    ]);
    const kept = {
      id: 2,
      method: 'GET',
      url: 'http://localhost:3000/api/cart',
      status: 200,
      type: 'application/json',
      size: 12,
      time: 840,
    };
    socket.hear({ type: 'answer', id: 2, ok: true, message: 'Check an element in the test’s window.' });
    socket.hear({ type: 'answer', id: 3, ok: false, message: 'The test went on.' });
    socket.hear({ type: 'answer', id: 4, ok: true, message: 'The test kept 1 response.', requests: [kept] });
    socket.hear({
      type: 'answer',
      id: 5,
      ok: true,
      message: 'Piwi sent the mock to Visual Studio Code to write above cart.spec.ts:5.',
    });
    expect(await assert).toEqual({ ok: true, message: 'Check an element in the test’s window.' });
    expect(await region).toEqual({ ok: false, message: 'The test went on.' });
    expect(await listed).toEqual({ ok: true, message: 'The test kept 1 response.', requests: [kept] });
    expect(await mock).toEqual({
      ok: true,
      message: 'Piwi sent the mock to Visual Studio Code to write above cart.spec.ts:5.',
    });
  });

  it('reads the requests an answer lists field by field: one it cannot read leaves the answer unread', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    const socket = sockets[0]!;
    await welcome(socket, [session([STOPPED])]);
    const kept = { id: 1, method: 'GET', url: 'http://x/a', status: 200, type: 'text/plain', size: 1, time: 1 };
    const bad = [
      [{ ...kept, url: 'x'.repeat(8193) }],
      [{ ...kept, status: 99 }],
      [{ ...kept, method: '<b>' }],
      [{ ...kept, id: 0 }],
      [{ ...kept, type: 'x'.repeat(201) }],
      Array.from({ length: 51 }, (_, i) => ({ ...kept, id: i + 1 })),
      'none',
    ];
    const asked = bad.map(() => hubs.command({ hub: HUB.url, ref: 'r1', worker: 1, since: 's7', what: 'requests' }));
    bad.forEach((requests, i) => socket.hear({ type: 'answer', id: i + 2, ok: true, message: 'Kept.', requests }));
    await vi.advanceTimersByTimeAsync(1000);
    for (const answer of await Promise.all(asked))
      expect(answer).toEqual({ ok: false, message: '', failure: 'timeout' });
  });

  it('reads a worker of an older hub, which names no intents, as one that takes none', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    const { intents: _intents, ...older } = STOPPED;
    await welcome(sockets[0]!, [session([older as HubWorker])]);
    expect(hubs.state().runs[0]!.session.workers[0]!.intents).toEqual([]);
    // An action this version does not know is left out.
    sockets[0]!.hear({ type: 'session', session: session([{ ...STOPPED, intents: ['dance', 'mock'] as never }]) });
    expect(hubs.state().runs[0]!.session.workers[0]!.intents).toEqual(['mock']);
  });

  it('answers a command itself when the hub is silent, closed or not connected', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    const notYet = await hubs.command({ hub: HUB.url, ref: 'r1', worker: null, since: null, what: 'pause' });
    expect(notYet).toMatchObject({ ok: false, failure: 'offline' });
    const socket = sockets[0]!;
    await welcome(socket);
    const slow = hubs.command({ hub: HUB.url, ref: 'r1', worker: null, since: null, what: 'pause' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await slow).toMatchObject({ ok: false, failure: 'timeout' });
    const cut = hubs.command({ hub: HUB.url, ref: 'r1', worker: null, since: null, what: 'pause' });
    socket.hangUp(1006);
    expect(await cut).toMatchObject({ ok: false, failure: 'offline' });
    const unknown = await hubs.command({
      hub: 'ws://127.0.0.1:1/piwi/hub',
      ref: 'r1',
      worker: 0,
      since: null,
      what: 'resume',
    });
    expect(unknown).toMatchObject({ ok: false, failure: 'offline' });
  });
});

describe('a connection that opens', () => {
  it('reads as connected only once the hub told its runs, so a window forgets none on a reconnection', async () => {
    const { hubs, sockets } = setup();
    const seen: Array<{ connected: boolean; runs: number }> = [];
    hubs.listen(() => {
      const state = hubs.state();
      seen.push({ connected: state.hubs[0]?.connected ?? false, runs: state.runs.length });
    });
    for (const reconnection of [false, true]) {
      await hubs.find();
      const socket = sockets[sockets.length - 1]!;
      socket.open();
      socket.hear({
        type: 'welcome',
        pid: 4242,
        version: '0.60.0',
        client: 'Visual Studio Code',
        roots: [],
        keepaliveMs: 20_000,
      });
      expect(hubs.state().hubs[0]?.connected, `welcomed, reconnection: ${reconnection}`).toBe(false);
      socket.hear({ type: 'answer', id: socket.last('subscribe')!.id, ok: true, message: 'Following 1 run.' });
      socket.hear({ type: 'session', session: session([STOPPED]) });
      expect(hubs.state().hubs[0]?.connected).toBe(false);
      await vi.advanceTimersByTimeAsync(60);
      expect(hubs.state()).toMatchObject({ hubs: [{ connected: true }], runs: [{ session: { ref: 'r1' } }] });
      if (!reconnection) socket.hangUp(1006);
    }
    // A window never saw the hub connected without its run.
    expect(seen.filter((s) => s.connected && s.runs === 0)).toEqual([]);
    expect(seen.some((s) => s.connected)).toBe(true);
  });
});

describe('connections that fail', () => {
  it('finds the hubs again after a hub closes, waiting longer after each failure in a row', async () => {
    const { hubs, sockets, fetches } = setup();
    hubs.listen(() => {});
    await hubs.find();
    await welcome(sockets[0]!, [session([RUNNING])]);
    sockets[0]!.hangUp(1006);
    // Its runs stay as last heard while it does not answer.
    expect(hubs.state().runs).toEqual([{ hub: HUB.url, session: session([RUNNING]) }]);
    expect(hubs.state().hubs).toEqual([
      {
        id: HUB.url,
        connected: false,
        client: 'Visual Studio Code',
        desktop: false,
        lanes: false,
        presence: false,
        holds: false,
        stops: false,
      },
    ]);
    expect(fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => sockets.length === 2);
    expect(fetches).toHaveLength(2);
    expect(sockets).toHaveLength(2);
    // The new socket never opens: the next try waits twice as long.
    sockets[1]!.hangUp(1006);
    await vi.advanceTimersByTimeAsync(1999);
    await settle();
    expect(fetches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => sockets.length === 3);
    expect(fetches).toHaveLength(3);
    // A welcome starts the count again.
    await welcome(sockets[2]!);
    sockets[2]!.hangUp(HUB_CLOSE.goingAway);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => fetches.length === 4);
    expect(fetches).toHaveLength(4);
  });

  it('waits longer for a hub that keeps failing while another one’s runs change', async () => {
    const { hubs, sockets, fetches, answer } = setup();
    hubs.listen(() => {});
    answer(async () => Response.json({ hubs: [HUB, OTHER_HUB] }));
    await hubs.find();
    await welcome(sockets[0]!, [session([RUNNING])]);
    const failing = () => sockets.filter((s) => s.url === OTHER_HUB.url);
    let tests = 0;
    /** The first hub's run goes on: a test begins every 100 ms. */
    const busy = async (ms: number) => {
      for (let waited = 0; waited < ms; waited += 100) {
        sockets[0]!.hear({
          type: 'session',
          session: session([{ ...RUNNING, test: { ...RUNNING.test!, id: `t${tests++}` } }]),
        });
        await vi.advanceTimersByTimeAsync(100);
        await settle();
      }
    };
    // The other hub fails each time: 1 s, then 2 s, then 4 s before the editor is asked again.
    for (const wait of [1000, 2000, 4000]) {
      const before = fetches.length;
      failing().pop()!.hangUp(1006);
      await busy(wait - 100);
      expect(fetches).toHaveLength(before);
      await busy(200);
      await until(() => fetches.length === before + 1);
      expect(fetches).toHaveLength(before + 1);
    }
    // The first hub's connection was kept all along, and says the window follows it.
    expect(sockets.filter((s) => s.url === HUB.url)).toHaveLength(1);
    expect(hubs.connected()).toBe(true);
  });

  it('drops a hub that refuses its token from the hubs kept, and asks the editor again', async () => {
    const { hubs, sockets, stored, fetches, answer } = setup();
    await hubs.find();
    answer(async () => Response.json({ hubs: [] }));
    sockets[0]!.open();
    sockets[0]!.hangUp(HUB_CLOSE.unauthorized);
    await vi.advanceTimersByTimeAsync(0);
    expect(stored.hubs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => fetches.length === 2);
    expect(fetches).toHaveLength(2);
    expect(hubs.state().hubs).toEqual([]);
  });

  it('closes a hub that stays silent past two keepalives, and finds the hubs again', async () => {
    const { hubs, sockets, fetches } = setup();
    await hubs.find();
    await welcome(sockets[0]!, [], 1000);
    sockets[0]!.hear({ type: 'keepalive' });
    await vi.advanceTimersByTimeAsync(2499);
    expect(sockets[0]!.closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(hubs.connected()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => fetches.length === 2);
    expect(fetches).toHaveLength(2);
  });

  it('closes a socket the hub never welcomes', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets[0]!.closedWith).toBe(1000);
  });

  it('stops trying after a few failures while no Runs window is open', async () => {
    const { hubs, challenges, prove } = setup();
    prove('unreachable');
    await hubs.find();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(challenges).toHaveLength(5);
    // A window opens: it asks, and the tries go on while it is open.
    hubs.listen(() => {});
    await hubs.find();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(challenges.length).toBeGreaterThan(20);
  });

  it('closes every connection once the editor is unpaired', async () => {
    let pairing: typeof PAIRING | null = PAIRING;
    const { hubs, sockets, stored } = setup({ pairing: async () => pairing });
    await hubs.find();
    await welcome(sockets[0]!, [session([RUNNING])]);
    pairing = null;
    await hubs.find();
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(hubs.state()).toEqual({ discovery: 'unpaired', desktop: 'unpaired', hubs: [], runs: [] });
    expect(stored.hubs).toEqual([]);
  });
});

describe('the hubs of windows opened since', () => {
  const { token: _token, ...OTHER_PEER } = OTHER_HUB;

  it('are found as a hub names them, the editor asked once for each, and connected', async () => {
    const { hubs, sockets, fetches, answer } = setup();
    hubs.listen(() => {});
    await hubs.find();
    await welcome(sockets[0]!, [session([RUNNING])]);
    expect(fetches).toHaveLength(1);
    // A hub names one this side knows: nothing to ask.
    const { token: _own, ...ownPeer } = HUB;
    sockets[0]!.hear({ type: 'peers', hubs: [ownPeer] });
    await settle();
    expect(fetches).toHaveLength(1);
    // A window opened since: the editor names it with its token.
    answer(async () => Response.json({ hubs: [HUB, OTHER_HUB] }));
    sockets[0]!.hear({ type: 'peers', hubs: [OTHER_PEER] });
    await until(() => sockets.length === 2);
    expect(fetches).toHaveLength(2);
    expect(sockets.map((socket) => socket.url)).toEqual([HUB.url, OTHER_HUB.url]);
    // Named again, it is known: nothing more to ask.
    sockets[0]!.hear({ type: 'peers', hubs: [OTHER_PEER] });
    await settle();
    expect(fetches).toHaveLength(2);
  });

  it('are asked of the editor once while it does not name them, however often a hub names them', async () => {
    const { hubs, sockets, fetches } = setup();
    hubs.listen(() => {});
    await hubs.find();
    await welcome(sockets[0]!, [session([RUNNING])]);
    sockets[0]!.hear({ type: 'peers', hubs: [OTHER_PEER] });
    await until(() => fetches.length === 2);
    sockets[0]!.hear({ type: 'peers', hubs: [OTHER_PEER] });
    await settle();
    expect(fetches).toHaveLength(2);
    expect(sockets).toHaveLength(1);
  });

  it('are looked for every minute while a Runs window is open, for a hub that names none', async () => {
    const { hubs, sockets, fetches } = setup();
    const leave = hubs.listen(() => {});
    await hubs.find();
    // A hub whose keepalive is far apart stays connected meanwhile.
    await welcome(sockets[0]!, [session([RUNNING])], 600_000);
    await vi.advanceTimersByTimeAsync(59_000);
    await settle();
    expect(fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => fetches.length === 2);
    expect(fetches).toHaveLength(2);
    expect(sockets).toHaveLength(1);
    leave();
    await vi.advanceTimersByTimeAsync(180_000);
    await settle();
    expect(fetches).toHaveLength(2);
  });
});

describe('a hub whose connection was lost', () => {
  it('keeps its runs as last heard, the hub not connected, until it tells them again', async () => {
    const { hubs, sockets } = setup();
    hubs.listen(() => {});
    await hubs.find();
    await welcome(sockets[0]!, [session([STOPPED])]);
    sockets[0]!.hangUp(1006);
    expect(hubs.state()).toMatchObject({
      hubs: [{ id: HUB.url, connected: false }],
      runs: [{ hub: HUB.url, session: session([STOPPED]) }],
    });
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => sockets.length === 2);
    // Connected again, its runs are those it tells: the test went on meanwhile.
    await welcome(sockets[1]!, [session([RUNNING])]);
    expect(hubs.state()).toMatchObject({
      hubs: [{ id: HUB.url, connected: true }],
      runs: [{ hub: HUB.url, session: session([RUNNING]) }],
    });
  });

  it('takes no command from the run shortcut, and keeps none once its service said it stopped', async () => {
    const { hubs, sockets, answer } = setup();
    hubs.listen(() => {});
    answer(async () => Response.json({ hubs: [HUB, OTHER_HUB] }));
    await hubs.find();
    await welcome(sockets[0]!, [session([STOPPED])]);
    await welcome(sockets[1]!, [session([RUNNING], { ref: 'r2' })]);
    sockets[0]!.hangUp(1006);
    expect(hubs.state().runs).toHaveLength(2);
    // The stopped test of the lost hub is no reason to resume: the shortcut pauses the run that answers.
    const sent = hubs.shortcut();
    await vi.advanceTimersByTimeAsync(10);
    const pause = sockets[1]!.last('runControl')!;
    expect(pause).toMatchObject({ ref: 'r2', action: 'pause' });
    sockets[1]!.hear({ type: 'answer', id: pause.id, ok: true, message: 'Pausing.' });
    expect(await sent).toEqual({ action: 'pause', answers: [{ ok: true, message: 'Pausing.' }] });
    expect(hubs.answeringRuns().map((run) => run.session.ref)).toEqual(['r2']);
    // A hub whose service stopped starts again elsewhere: its runs go.
    sockets[1]!.hangUp(HUB_CLOSE.goingAway);
    expect(hubs.state().runs.map((run) => run.session.ref)).toEqual(['r1']);
  });

  it('drops them once the hub refuses its token, or the editor no longer names it', async () => {
    const { hubs, sockets, answer } = setup();
    hubs.listen(() => {});
    await hubs.find();
    await welcome(sockets[0]!, [session([RUNNING])]);
    sockets[0]!.hangUp(HUB_CLOSE.unauthorized);
    expect(hubs.state().runs).toEqual([]);

    answer(async () => Response.json({ hubs: [HUB] }));
    await hubs.find();
    await welcome(sockets[1]!, [session([RUNNING])]);
    sockets[1]!.hangUp(1006);
    expect(hubs.state().runs).toHaveLength(1);
    answer(async () => Response.json({ hubs: [] }));
    await hubs.find();
    expect(hubs.state().runs).toEqual([]);
  });
});

describe('the global shortcut', () => {
  it('pauses every run with a worker when no test is stopped', async () => {
    const { hubs, answer, sockets } = setup();
    answer(async () => Response.json({ hubs: [HUB, OTHER_HUB] }));
    const done = hubs.shortcut();
    await until(() => sockets.length === 2);
    await welcome(sockets[0]!, [session([RUNNING])]);
    await welcome(sockets[1]!, [
      session([], { ref: 'r2' }),
      session([{ ...RUNNING, state: 'between', test: null }], { ref: 'r3' }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.last('runControl')).toMatchObject({ ref: 'r1', worker: null, action: 'pause', since: null });
    expect(sockets[1]!.sent.filter((m) => m.type === 'runControl')).toEqual([
      expect.objectContaining({ ref: 'r3', worker: null, action: 'pause' }),
    ]);
    for (const socket of sockets) {
      const sent = socket.last('runControl');
      if (sent) socket.hear({ type: 'answer', id: sent.id, ok: true, message: 'Pausing.' });
    }
    expect(await done).toEqual({
      action: 'pause',
      answers: [
        { ok: true, message: 'Pausing.' },
        { ok: true, message: 'Pausing.' },
      ],
    });
  });

  it('resumes every stopped test at the stop it stands at, and pauses nothing then', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    await welcome(sockets[0]!, [session([RUNNING, STOPPED])]);
    void hubs.shortcut();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.sent.filter((m) => m.type === 'runControl')).toEqual([
      { type: 'runControl', id: 2, ref: 'r1', worker: 1, action: 'resume', since: 's7' },
    ]);
  });

  it('does nothing without a run', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    await welcome(sockets[0]!, [session([], { ended: true })]);
    expect(await hubs.shortcut()).toEqual({ action: null, answers: [] });
    expect(sockets[0]!.last('runControl')).toBeUndefined();
  });
});

describe('a stop’s live view', () => {
  /** A headless stop, whose worker takes the view: what the hub tells a connection that watches it, and one that does not. */
  const HEADLESS: HubWorker = {
    ...STOPPED,
    intents: ['pick', 'record', 'mock', 'view', 'input', 'pick-at'],
    stop: { ...STOPPED.stop!, bar: false, intents: ['pick', 'record', 'mock', 'view', 'input', 'pick-at'] },
  };
  const AT = { hub: HUB.url, ref: 'r1', worker: 1, since: 's7' };

  function viewer(): RunsViewer & { frames: RunsFrame[]; ended: ReturnType<typeof vi.fn<(view: RunsView) => void>> } {
    const frames: RunsFrame[] = [];
    return {
      frames,
      frame: (frame) => void frames.push(frame),
      ended: vi.fn<(view: RunsView) => void>(),
      laneFrame: () => {},
      laneEnded: () => {},
    };
  }

  const frame = (data: string, since = 's7') => ({
    type: 'frame',
    ref: 'r1',
    worker: 1,
    since,
    width: 1280,
    height: 800,
    data,
  });

  async function watched() {
    const { hubs, sockets } = setup();
    await hubs.find();
    const socket = sockets[0]!;
    await welcome(socket, [session([HEADLESS])]);
    return { hubs, socket };
  }

  /** The hub answers the latest command of `type`. */
  function answerLast(socket: FakeSocket, type: string, answer: Record<string, unknown> = {}): void {
    const sent = socket.last(type)!;
    socket.hear({ type: 'answer', id: sent.id, ok: true, message: 'Done.', ...answer });
  }

  it('asks the hub for a view as the first window watches, sends its frames to the windows that watch alone, the latest at once to one that comes', async () => {
    const { hubs, socket } = await watched();
    const [a, b, c] = [viewer(), viewer(), viewer()];
    const onA = hubs.command({ ...AT, what: 'view', on: true }, a);
    expect(socket.last('view')).toEqual({ type: 'view', id: 2, ref: 'r1', worker: 1, since: 's7', on: true });
    // A frame before the hub's answer goes to the window already: a still page sends one alone.
    socket.hear(frame('AAAA'));
    answerLast(socket, 'view', { message: 'The live view is on.' });
    expect(await onA).toEqual({ ok: true, message: 'The live view is on.' });
    const onB = hubs.command({ ...AT, what: 'view', on: true }, b);
    answerLast(socket, 'view');
    await onB;
    await vi.advanceTimersByTimeAsync(200);
    socket.hear(frame('BBBB'));
    // A frame of another stop, or another worker, goes to nobody.
    socket.hear(frame('CCCC', 's8'));
    socket.hear({ ...frame('DDDD'), worker: 0 });
    const expected = (data: string) => ({
      hub: HUB.url,
      ref: 'r1',
      worker: 1,
      since: 's7',
      width: 1280,
      height: 800,
      data,
    });
    expect(a.frames).toEqual([expected('AAAA'), expected('BBBB')]);
    // The second window got the frame before it at once: a still page sends no other.
    expect(b.frames).toEqual([expected('AAAA'), expected('BBBB')]);
    expect(c.frames).toEqual([]);
  });

  it('sends each window the latest frame alone, at most ten a second', async () => {
    const { hubs, socket } = await watched();
    const a = viewer();
    const on = hubs.command({ ...AT, what: 'view', on: true }, a);
    answerLast(socket, 'view');
    await on;
    for (let i = 0; i < 30; i++) socket.hear(frame(`AA${String(i).padStart(2, '0')}`));
    const data = () => a.frames.map((f) => ('data' in f ? f.data : f.refused));
    expect(data()).toEqual(['AA00']);
    await vi.advanceTimersByTimeAsync(100);
    expect(data()).toEqual(['AA00', 'AA29']);
    await vi.advanceTimersByTimeAsync(500);
    expect(a.frames).toHaveLength(2);
  });

  it('passes on why a view sends no frame, as a frame of it goes', async () => {
    const { hubs, socket } = await watched();
    const a = viewer();
    const on = hubs.command({ ...AT, what: 'view', on: true }, a);
    answerLast(socket, 'view');
    await on;
    const refused = 'This page is too heavy for the live view.';
    socket.hear({ type: 'frame', ref: 'r1', worker: 1, since: 's7', refused });
    // One without its sentence is no refusal, nor a frame.
    socket.hear({ type: 'frame', ref: 'r1', worker: 1, since: 's7', refused: '' });
    expect(a.frames).toEqual([{ ...AT, refused }]);
  });

  it('stops the view as the last window stops watching or closes, and refuses input from one that does not watch', async () => {
    const { hubs, socket } = await watched();
    const [a, b] = [viewer(), viewer()];
    const events = [
      { type: 'mouse' as const, action: 'click' as const, x: 1, y: 2, button: 'left' as const, clickCount: 1 },
    ];
    expect(await hubs.command({ ...AT, what: 'input', events }, a)).toEqual({
      ok: false,
      message: '',
      failure: 'unwatched',
    });
    for (const watcher of [a, b]) {
      const on = hubs.command({ ...AT, what: 'view', on: true }, watcher);
      answerLast(socket, 'view');
      await on;
    }
    const views = () => socket.sent.filter((m) => m.type === 'view').map((m) => m.on);
    expect(views()).toEqual([true, true]);
    // Input from a window that watches goes on; Pick on the image, from any window.
    const played = hubs.command({ ...AT, what: 'input', events }, a);
    expect(socket.last('input')).toEqual({ type: 'input', id: 4, ref: 'r1', worker: 1, since: 's7', events });
    answerLast(socket, 'input', { message: 'Played 1 event.' });
    expect(await played).toEqual({ ok: true, message: 'Played 1 event.' });
    const picked = hubs.command({ ...AT, what: 'pick-at', x: 20, y: 90 }, viewer());
    expect(socket.last('pick-at')).toEqual({ type: 'pick-at', id: 5, ref: 'r1', worker: 1, since: 's7', x: 20, y: 90 });
    answerLast(socket, 'pick-at', { message: 'Sent.', locator: "getByRole('button')" });
    expect(await picked).toEqual({ ok: true, message: 'Sent.', locator: "getByRole('button')" });

    // One window stops: the hub hears nothing, the other one still watches; the last one closes: the hub stops it.
    expect(await hubs.command({ ...AT, what: 'view', on: false }, a)).toEqual({ ok: true, message: '' });
    expect(views()).toEqual([true, true]);
    expect(await hubs.command({ ...AT, what: 'input', events }, a)).toMatchObject({ failure: 'unwatched' });
    hubs.unwatchAll(b);
    expect(views()).toEqual([true, true, false]);
    socket.hear(frame('AAAA'));
    expect([...a.frames, ...b.frames]).toEqual([]);
  });

  it('tells a window that stops watching what the stop takes from it then, and refuses it the actions in the test’s window', async () => {
    const { hubs, socket } = await watched();
    const changed = vi.fn();
    hubs.listen(changed);
    const [a, b] = [viewer(), viewer()];
    for (const window of [a, b]) {
      const on = hubs.command({ ...AT, what: 'view', on: true }, window);
      answerLast(socket, 'view');
      await on;
    }
    changed.mockClear();
    await hubs.command({ ...AT, what: 'view', on: false }, a);
    // The hub hears nothing, the other window still watching: the windows get the state again all the same.
    expect(changed).toHaveBeenCalled();
    const intents = (window: RunsViewer) => hubs.state(window).runs[0]!.session.workers[0]!.stop!.intents;
    expect(intents(a)).toEqual(['mock', 'view', 'pick-at']);
    const sent = socket.sent.length;
    expect(await hubs.command({ ...AT, what: 'pick' }, a)).toMatchObject({ failure: 'unwatched' });
    expect(socket.sent).toHaveLength(sent);
    void hubs.command({ ...AT, what: 'pick' }, b);
    expect(socket.last('pick')).toMatchObject({ type: 'pick', ref: 'r1', worker: 1, since: 's7' });
  });

  it('takes a window off a view the hub refused, and tells each window what its stop takes from it', async () => {
    const { hubs, socket } = await watched();
    const [a, b] = [viewer(), viewer()];
    const refused = hubs.command({ ...AT, what: 'view', on: true }, a);
    socket.hear({ type: 'answer', id: socket.last('view')!.id, ok: false, message: 'This stop has no page to show.' });
    expect(await refused).toEqual({ ok: false, message: 'This stop has no page to show.' });
    socket.hear(frame('AAAA'));
    expect(a.frames).toEqual([]);
    const on = hubs.command({ ...AT, what: 'view', on: true }, a);
    answerLast(socket, 'view');
    await on;
    const intents = (watcher: RunsViewer) => hubs.state(watcher).runs[0]!.session.workers[0]!.stop!.intents;
    expect(intents(a)).toEqual(['pick', 'record', 'mock', 'view', 'input', 'pick-at']);
    expect(intents(b)).toEqual(['mock', 'view', 'pick-at']);
  });

  it('forgets a view whose stop ended, asking the hub nothing, and sends none of its frames', async () => {
    const { hubs, socket } = await watched();
    const a = viewer();
    const on = hubs.command({ ...AT, what: 'view', on: true }, a);
    answerLast(socket, 'view');
    await on;
    socket.hear({ type: 'session', session: session([{ ...HEADLESS, state: 'running', stop: null }]) });
    socket.hear(frame('AAAA'));
    expect(a.frames).toEqual([]);
    hubs.unwatchAll(a);
    expect(socket.sent.filter((m) => m.type === 'view').map((m) => m.on)).toEqual([true]);
    expect(await hubs.command({ ...AT, what: 'input', events: [{ type: 'text', text: 'a' }] }, a)).toMatchObject({
      failure: 'unwatched',
    });
  });

  it('tells each window watching a view that it ended as the hub’s connection is lost', async () => {
    const { hubs, socket } = await watched();
    const a = viewer();
    const on = hubs.command({ ...AT, what: 'view', on: true }, a);
    answerLast(socket, 'view');
    await on;
    socket.hangUp(1006);
    expect(a.ended).toHaveBeenCalledWith(AT);
    expect(await hubs.command({ ...AT, what: 'input', events: [{ type: 'text', text: 'a' }] }, a)).toMatchObject({
      failure: 'offline',
    });
  });

  it('asks nothing of the view without the window, its worker or its stop', async () => {
    const { hubs, socket } = await watched();
    const sent = socket.sent.length;
    expect(await hubs.command({ ...AT, what: 'view', on: true })).toMatchObject({ failure: 'offline' });
    expect(await hubs.command({ ...AT, worker: null, what: 'view', on: true }, viewer())).toMatchObject({
      failure: 'offline',
    });
    expect(await hubs.command({ ...AT, since: null, what: 'pick-at', x: 1, y: 1 }, viewer())).toMatchObject({
      failure: 'offline',
    });
    expect(socket.sent).toHaveLength(sent);
  });
});

describe('a lane watched while it runs', () => {
  /** A worker whose reporter shows its lane, running its test, then stopped headless in the same lane. */
  const LANE_RUNNING: HubWorker = { ...RUNNING, worker: 2, parallelIndex: 1, intents: ['view', 'input', 'watch'] };
  const LANE_STOPPED: HubWorker = {
    ...LANE_RUNNING,
    state: 'stopped',
    stop: { ...STOPPED.stop!, bar: false, since: 's9', intents: ['view', 'input', 'pick-at'] },
  };
  const LANE: RunsLane = { hub: HUB.url, ref: 'r1', lane: 1 };

  function viewer(): RunsViewer & {
    frames: RunsLaneFrame[];
    laneEnded: ReturnType<typeof vi.fn<(lane: RunsLane) => void>>;
  } {
    const frames: RunsLaneFrame[] = [];
    return {
      frames,
      frame: () => {},
      ended: () => {},
      laneFrame: (frame) => void frames.push(frame),
      laneEnded: vi.fn<(lane: RunsLane) => void>(),
    };
  }

  const laneFrame = (data: string, since: string | null = null, lane = 1) => ({
    type: 'lane-frame',
    ref: 'r1',
    lane,
    worker: 2,
    test: 't1',
    since,
    width: 1280,
    height: 800,
    data,
  });

  async function watched(workers: HubWorker[] = [LANE_RUNNING]) {
    const { hubs, sockets } = setup();
    await hubs.find();
    const socket = sockets[0]!;
    await welcome(socket, [session(workers)], 20_000, ['peers', 'lanes']);
    return { hubs, socket };
  }

  /** The hub answers the latest command of `type`. */
  function answerLast(socket: FakeSocket, type: string, answer: Record<string, unknown> = {}): void {
    const sent = socket.last(type)!;
    socket.hear({ type: 'answer', id: sent.id, ok: true, message: 'Done.', ...answer });
  }

  async function watch(hubs: RunHubs, socket: FakeSocket, window: RunsViewer, on = true): Promise<unknown> {
    const answer = hubs.command({ ...LANE, worker: null, since: null, what: 'watch', on }, window);
    if (on) answerLast(socket, 'watch', { message: 'The live view is on.' });
    return answer;
  }

  it('says which hubs show a lane, as their welcome lists it, while they are away too', async () => {
    const { hubs, socket } = await watched();
    expect(hubs.state().hubs).toMatchObject([{ id: HUB.url, lanes: true }]);
    socket.hangUp(1006);
    expect(hubs.state().hubs).toMatchObject([{ id: HUB.url, connected: false, lanes: true }]);
    const { hubs: older, sockets } = setup();
    await older.find();
    await welcome(sockets[0]!, [session([RUNNING])]);
    expect(older.state().hubs).toMatchObject([{ id: HUB.url, lanes: false }]);
  });

  it('asks the hub to watch a lane as each window does, its frames to the windows that watch it alone, the latest at once to one that comes', async () => {
    const { hubs, socket } = await watched();
    const [a, b, c] = [viewer(), viewer(), viewer()];
    const onA = hubs.command({ ...LANE, worker: null, since: null, what: 'watch', on: true }, a);
    expect(socket.last('watch')).toEqual({ type: 'watch', id: 2, ref: 'r1', lane: 1, on: true });
    // A frame before the hub's answer goes to the window already.
    socket.hear(laneFrame('AAAA'));
    answerLast(socket, 'watch', { message: 'The live view is on.' });
    expect(await onA).toEqual({ ok: true, message: 'The live view is on.' });
    expect(await watch(hubs, socket, b)).toEqual({ ok: true, message: 'The live view is on.' });
    await vi.advanceTimersByTimeAsync(200);
    socket.hear(laneFrame('BBBB', 's9'));
    // A frame of another lane goes to nobody, nor does one it cannot read.
    socket.hear(laneFrame('CCCC', null, 0));
    socket.hear({ ...laneFrame('DDDD'), test: null });
    const expected = (data: string, since: string | null = null) => ({
      hub: HUB.url,
      ref: 'r1',
      lane: 1,
      worker: 2,
      test: 't1',
      since,
      width: 1280,
      height: 800,
      data,
    });
    expect(a.frames).toEqual([expected('AAAA'), expected('BBBB', 's9')]);
    expect(b.frames).toEqual([expected('AAAA'), expected('BBBB', 's9')]);
    expect(c.frames).toEqual([]);
    expect(socket.sent.filter((m) => m.type === 'watch').map((m) => m.on)).toEqual([true, true]);
  });

  it('sends each window the latest frame alone, at most ten a second, and why none comes as a frame goes', async () => {
    const { hubs, socket } = await watched();
    const a = viewer();
    await watch(hubs, socket, a);
    for (let i = 0; i < 30; i++) socket.hear(laneFrame(`AA${String(i).padStart(2, '0')}`));
    const data = () => a.frames.map((f) => ('data' in f ? f.data : f.refused));
    expect(data()).toEqual(['AA00']);
    await vi.advanceTimersByTimeAsync(100);
    expect(data()).toEqual(['AA00', 'AA29']);
    await vi.advanceTimersByTimeAsync(200);
    const refused = 'This test has no page to show.';
    socket.hear({ type: 'lane-frame', ref: 'r1', lane: 1, worker: 2, test: null, since: null, refused });
    expect(a.frames[a.frames.length - 1]).toEqual({ ...LANE, worker: 2, test: null, since: null, refused });
  });

  it('stops watching as the last window stops or closes, and takes input at a stop from a window that watches the lane alone', async () => {
    const { hubs, socket } = await watched([LANE_STOPPED]);
    const [a, b] = [viewer(), viewer()];
    const at = { hub: HUB.url, ref: 'r1', worker: 2, since: 's9' };
    const events = [{ type: 'text' as const, text: 'a' }];
    expect(await hubs.command({ ...at, what: 'input', events }, a)).toMatchObject({ failure: 'unwatched' });
    for (const window of [a, b]) await watch(hubs, socket, window);
    // The window that watches the lane is a viewer of its stop: its input goes on, and the stop keeps it for it.
    const played = hubs.command({ ...at, what: 'input', events }, a);
    expect(socket.last('input')).toEqual({ type: 'input', id: 4, ref: 'r1', worker: 2, since: 's9', events });
    answerLast(socket, 'input', { message: 'Played 1 event.' });
    expect(await played).toEqual({ ok: true, message: 'Played 1 event.' });
    const intents = (window: RunsViewer) => hubs.state(window).runs[0]!.session.workers[0]!.stop!.intents;
    expect(intents(a)).toEqual(['view', 'input', 'pick-at']);
    expect(intents(viewer())).toEqual(['view', 'pick-at']);

    const watches = () => socket.sent.filter((m) => m.type === 'watch').map((m) => m.on);
    expect(await hubs.command({ ...LANE, worker: null, since: null, what: 'watch', on: false }, a)).toEqual({
      ok: true,
      message: '',
    });
    expect(watches()).toEqual([true, true]);
    expect(await hubs.command({ ...at, what: 'input', events }, a)).toMatchObject({ failure: 'unwatched' });
    hubs.unwatchAll(b);
    expect(socket.last('watch')).toEqual({ type: 'watch', id: 5, ref: 'r1', lane: 1, on: false });
    socket.hear(laneFrame('AAAA'));
    expect([...a.frames, ...b.frames]).toEqual([]);
  });

  it('takes a window off a lane the hub refused to watch', async () => {
    const { hubs, socket } = await watched();
    const a = viewer();
    const refused = hubs.command({ ...LANE, worker: null, since: null, what: 'watch', on: true }, a);
    const message = 'Update the reporter to watch a running test: this one shows a stopped test alone.';
    socket.hear({ type: 'answer', id: socket.last('watch')!.id, ok: false, message });
    expect(await refused).toEqual({ ok: false, message });
    socket.hear(laneFrame('AAAA'));
    expect(a.frames).toEqual([]);
    hubs.unwatchAll(a);
    expect(socket.sent.filter((m) => m.type === 'watch').map((m) => m.on)).toEqual([true]);
  });

  it('forgets a lane whose run ended, asking the hub nothing, and tells each window watching one that the connection was lost', async () => {
    const { hubs, socket } = await watched();
    const [a, b] = [viewer(), viewer()];
    await watch(hubs, socket, a);
    socket.hear({ type: 'session', session: session([LANE_RUNNING], { ended: true }) });
    hubs.unwatchAll(a);
    expect(socket.sent.filter((m) => m.type === 'watch').map((m) => m.on)).toEqual([true]);
    expect(a.laneEnded).not.toHaveBeenCalled();

    socket.hear({ type: 'session', session: { ...session([LANE_RUNNING]), ref: 'r2' } });
    const lane = { ...LANE, ref: 'r2' };
    const on = hubs.command({ ...lane, worker: null, since: null, what: 'watch', on: true }, b);
    answerLast(socket, 'watch');
    await on;
    socket.hangUp(1006);
    expect(b.laneEnded).toHaveBeenCalledWith(lane);
  });

  it('tells a window that stops watching what the stop takes from it then, and refuses it the actions in the test’s window', async () => {
    const stopped: HubWorker = {
      ...LANE_STOPPED,
      stop: { ...LANE_STOPPED.stop!, intents: ['pick', 'record', 'view', 'input', 'pick-at'] },
    };
    const { hubs, socket } = await watched([stopped]);
    const changed = vi.fn();
    hubs.listen(changed);
    const [a, b] = [viewer(), viewer()];
    for (const window of [a, b]) await watch(hubs, socket, window);
    const at = { hub: HUB.url, ref: 'r1', worker: 2, since: 's9' };
    changed.mockClear();
    await hubs.command({ ...LANE, worker: null, since: null, what: 'watch', on: false }, a);
    expect(socket.sent.filter((m) => m.type === 'watch').map((m) => m.on)).toEqual([true, true]);
    expect(changed).toHaveBeenCalled();
    const intents = (window: RunsViewer) => hubs.state(window).runs[0]!.session.workers[0]!.stop!.intents;
    expect(intents(a)).toEqual(['view', 'pick-at']);
    expect(intents(b)).toEqual(['pick', 'record', 'view', 'input', 'pick-at']);
    const sent = socket.sent.length;
    expect(await hubs.command({ ...at, what: 'pick' }, a)).toMatchObject({ failure: 'unwatched' });
    expect(await hubs.command({ ...at, what: 'record' }, viewer())).toMatchObject({ failure: 'unwatched' });
    expect(socket.sent).toHaveLength(sent);
    void hubs.command({ ...at, what: 'pick' }, b);
    expect(socket.last('pick')).toMatchObject({ type: 'pick', ref: 'r1', worker: 2, since: 's9' });
  });

  it('makes no viewer of a stop outside a test, which no lane shows', async () => {
    const outside: HubWorker = { ...LANE_STOPPED, test: null };
    const { hubs, socket } = await watched([outside]);
    const a = viewer();
    await watch(hubs, socket, a);
    const at = { hub: HUB.url, ref: 'r1', worker: 2, since: 's9' };
    expect(await hubs.command({ ...at, what: 'input', events: [{ type: 'text', text: 'a' }] }, a)).toMatchObject({
      failure: 'unwatched',
    });
    expect(hubs.state(a).runs[0]!.session.workers[0]!.stop!.intents).toEqual(['view', 'pick-at']);
  });

  it('stops the hub watching a lane for a window whose ask it did not answer in time, with no other window on it', async () => {
    const { hubs, socket } = await watched();
    const a = viewer();
    const on = hubs.command({ ...LANE, worker: null, since: null, what: 'watch', on: true }, a);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await on).toMatchObject({ ok: false, failure: 'timeout' });
    expect(socket.sent.filter((m) => m.type === 'watch').map((m) => m.on)).toEqual([true, false]);
    socket.hear(laneFrame('AAAA'));
    expect(a.frames).toEqual([]);
  });

  it('asks nothing of a lane without the window or the lane', async () => {
    const { hubs, socket } = await watched();
    const sent = socket.sent.length;
    expect(await hubs.command({ ...LANE, worker: null, since: null, what: 'watch', on: true })).toMatchObject({
      failure: 'offline',
    });
    const { lane: _lane, ...noLane } = LANE;
    expect(
      await hubs.command({ ...noLane, worker: null, since: null, what: 'watch', on: true }, viewer()),
    ).toMatchObject({ failure: 'offline' });
    expect(socket.sent).toHaveLength(sent);
  });
});
