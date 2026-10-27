import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITOR_CHALLENGE_HEADER, EDITOR_PROOF_HEADER, editorTokenProof } from '@piwitests/core/editor-send';
import { HUB_CLOSE, type HubSession, type HubWorker, type LiveHub } from '@piwitests/core/run-hub';
import type { HubSocket } from '../../src/background/hub-connection.js';
import { RunHubs, type RunHubsDeps } from '../../src/background/run-hubs.js';

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

/** The hub's side of the handshake: open, welcome, answer `subscribe`, then send `sessions`. */
async function welcome(socket: FakeSocket, sessions: HubSession[] = [], keepaliveMs = 20_000): Promise<void> {
  socket.open();
  socket.hear({ type: 'welcome', pid: 4242, version: '0.60.0', client: 'Visual Studio Code', roots: [], keepaliveMs });
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

  it('takes an endpoint that answers 404 with no proof as an editor older than the live endpoint', async () => {
    const { hubs, fetches, prove } = setup();
    prove('none-404');
    await hubs.find();
    expect(hubs.state().discovery).toBe('outdated');
    expect(fetches).toEqual([]);
  });

  it('leaves out an entry it cannot read', async () => {
    const { hubs, answer, sockets } = setup();
    answer(async () => Response.json({ hubs: [{ ...HUB, url: 'ws://evil.example/piwi/hub' }, HUB] }));
    await hubs.find();
    expect(sockets.map((s) => s.url)).toEqual([HUB.url]);
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

  it('passes each command on and hands back the answer of its id', async () => {
    const { hubs, sockets } = setup();
    await hubs.find();
    const socket = sockets[0]!;
    await welcome(socket, [session([STOPPED])]);
    const step = hubs.command({ hub: HUB.url, ref: 'r1', worker: 1, since: 's7', what: 'step' });
    const image = hubs.command({ hub: HUB.url, ref: 'r1', worker: 1, since: 's7', what: 'image' });
    const pick = hubs.command({ hub: HUB.url, ref: 'r1', worker: null, since: 's7', what: 'pick' });
    expect(socket.sent.slice(2)).toEqual([
      { type: 'runControl', id: 2, ref: 'r1', worker: 1, action: 'step', since: 's7' },
      { type: 'pausedPage', id: 3, ref: 'r1', worker: 1 },
      { type: 'pick', id: 4, ref: 'r1', worker: null, since: 's7' },
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

describe('connections that fail', () => {
  it('finds the hubs again after a hub closes, waiting longer after each failure in a row', async () => {
    const { hubs, sockets, fetches } = setup();
    hubs.listen(() => {});
    await hubs.find();
    await welcome(sockets[0]!, [session([RUNNING])]);
    sockets[0]!.hangUp(1006);
    expect(hubs.state().runs).toEqual([]);
    expect(hubs.state().hubs).toEqual([{ id: HUB.url, connected: false, client: 'Visual Studio Code' }]);
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
    expect(hubs.state()).toEqual({ discovery: 'unpaired', hubs: [], runs: [] });
    expect(stored.hubs).toEqual([]);
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
    expect(await done).toEqual([
      { ok: true, message: 'Pausing.' },
      { ok: true, message: 'Pausing.' },
    ]);
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
    expect(await hubs.shortcut()).toEqual([]);
    expect(sockets[0]!.last('runControl')).toBeUndefined();
  });
});
