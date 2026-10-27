import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  canonicalEditorUrl,
  editorOriginPattern,
  getEditorPairing,
  moveLegacyEditorPairing,
  parseEditorPairing,
  setEditorPairing,
} from '../../src/shared/editor-pairing.js';
import { memorySecretArea } from './memory-secret-area.js';
import { sendToEditor } from '../../src/shared/editor-send.js';
import { postToEditor } from '../../src/shared/piwi-client.js';
import { t } from '../../src/shared/i18n.js';
import { EDITOR_CHALLENGE_HEADER, EDITOR_PROOF_HEADER, editorTokenProof } from '@piwitests/core/editor-send';

const PAIRING = { url: 'http://127.0.0.1:47211/piwi/send', token: 'abcdefghijklmnop_1234' };
let store: Record<string, unknown> = {};
let sent: unknown[] = [];

beforeEach(() => {
  store = {};
  sent = [];
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (items: Record<string, unknown>) => Object.assign(store, items),
        remove: async (key: string) => void delete store[key],
      },
    },
    runtime: {
      sendMessage: async (msg: unknown) => {
        sent.push(msg);
        return { ok: true, file: '/w/tests/a.spec.ts' };
      },
    },
  };
});

afterEach(() => vi.unstubAllGlobals());

describe('the editor pairing', () => {
  it('is kept in the secret area until unpaired', async () => {
    const area = memorySecretArea();
    expect(await getEditorPairing(area)).toBeNull();
    await setEditorPairing(PAIRING, area);
    expect(await getEditorPairing(area)).toEqual(PAIRING);
    await setEditorPairing(null, area);
    expect(await getEditorPairing(area)).toBeNull();
    expect(store).toEqual({});
  });

  it('leaves only the address where content scripts read, which tells them an editor is paired', async () => {
    const area = memorySecretArea();
    await setEditorPairing(PAIRING, area);
    expect(JSON.stringify(store)).not.toContain(PAIRING.token);
    // A content script: not the extension's origin, so no secret area.
    expect(await getEditorPairing()).toEqual({ url: PAIRING.url, token: '' });
  });

  it('a token left in chrome.storage.local moves to the secret area, keeping the address there', async () => {
    const area = memorySecretArea();
    store.piwiEditorPairing = { ...PAIRING };
    await moveLegacyEditorPairing(area);
    expect(store.piwiEditorPairing).toEqual({ url: PAIRING.url });
    expect(await getEditorPairing(area)).toEqual(PAIRING);
  });

  it('a token written into chrome.storage.local later never replaces the one kept', async () => {
    const area = memorySecretArea();
    await setEditorPairing(PAIRING, area);
    store.piwiEditorPairing = { url: 'http://127.0.0.1:9/x', token: 'planted_token_0000' };
    expect(await getEditorPairing(area)).toEqual(PAIRING);
    expect(store.piwiEditorPairing).toEqual({ url: 'http://127.0.0.1:9/x' });
  });

  it('asks only for the editor’s origin', () => {
    expect(editorOriginPattern(PAIRING)).toBe('http://127.0.0.1:47211/*');
  });

  it('marks each pairing with its time, so pairing again at the same address is a change the worker hears', async () => {
    const area = memorySecretArea();
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    try {
      await setEditorPairing(PAIRING, area);
      expect(store.piwiEditorPairing).toEqual({ url: PAIRING.url, at: 1000 });
      await setEditorPairing({ ...PAIRING, token: 'another_token_0123456789' }, area);
      expect(store.piwiEditorPairing).toEqual({ url: PAIRING.url, at: 2000 });
    } finally {
      now.mockRestore();
    }
    expect(await getEditorPairing(area)).toEqual({ ...PAIRING, token: 'another_token_0123456789' });
  });

  it('keeps an address typed with another loopback name on 127.0.0.1, where the editors listen', async () => {
    expect(parseEditorPairing(`http://localhost:47211/piwi/send#${PAIRING.token}`)).toEqual(PAIRING);
    expect(parseEditorPairing(`http://[::1]:47211/piwi/send#${PAIRING.token}`)).toEqual(PAIRING);
    expect(parseEditorPairing(`http://LocalHost:63342/api/piwi/send#${PAIRING.token}`)).toEqual({
      url: 'http://127.0.0.1:63342/api/piwi/send',
      token: PAIRING.token,
    });
    expect(parseEditorPairing('http://example.com:47211/piwi/send#abcdefghijklmnop_1234')).toBeNull();
    expect(canonicalEditorUrl('not an address')).toBe('not an address');

    // Stored, and read back, on 127.0.0.1: what an older version kept under `localhost` too.
    const area = memorySecretArea();
    await setEditorPairing({ ...PAIRING, url: 'http://localhost:47211/piwi/send' }, area);
    expect(await getEditorPairing(area)).toEqual(PAIRING);
    expect(store.piwiEditorPairing).toMatchObject({ url: PAIRING.url });
    await area.set('editor', { ...PAIRING, url: 'http://localhost:47211/piwi/send' });
    expect(await getEditorPairing(area)).toEqual(PAIRING);
    store.piwiEditorPairing = { url: 'http://localhost:47211/piwi/send' };
    expect(await getEditorPairing()).toEqual({ url: PAIRING.url, token: '' });
  });
});

describe('sendToEditor', () => {
  it('asks the background worker, which holds the token, to post', async () => {
    const result = await sendToEditor({ kind: 'locator', text: "page.getByRole('button')" });
    expect(sent).toEqual([
      { type: 'piwi-send-to-editor', payload: { kind: 'locator', text: "page.getByRole('button')" } },
    ]);
    expect(result).toEqual({ ok: true, file: '/w/tests/a.spec.ts' });
  });
});

/**
 * The editor's endpoint: a request with a challenge alone gets the proof that the program holds `token` (the
 * pairing's, unless another), refused; any other request `answer`.
 */
function editorEndpoint(answer: () => Promise<Response>, token = PAIRING.token) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const challenge = (init.headers as Record<string, string>)[EDITOR_CHALLENGE_HEADER];
    if (!challenge) return answer();
    const proof = await editorTokenProof(token, 47211, challenge);
    return new Response('{"error":"not paired"}', { status: 401, headers: { [EDITOR_PROOF_HEADER]: proof } });
  });
}

const JETBRAINS = { url: 'http://127.0.0.1:63342/api/piwi/send', token: PAIRING.token };

/**
 * A JetBrains IDE's built-in server, as `PiwiSendHandler.isSupported` routes it: `…/send` takes POST and OPTIONS,
 * `…/live` GET and OPTIONS; anything else never reaches the handler, and the platform answers 404 without the proof.
 */
function jetbrainsEndpoint() {
  return vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname;
    const handled =
      (path === '/api/piwi/send' && (method === 'POST' || method === 'OPTIONS')) ||
      (path === '/api/piwi/live' && (method === 'GET' || method === 'OPTIONS'));
    if (!handled) return new Response('{"error":"Not Found"}', { status: 404 });
    const headers = init.headers as Record<string, string>;
    const challenge = headers[EDITOR_CHALLENGE_HEADER];
    const proof: Record<string, string> = {};
    if (challenge) proof[EDITOR_PROOF_HEADER] = await editorTokenProof(PAIRING.token, 63342, challenge);
    if (headers.Authorization !== `Bearer ${PAIRING.token}`) {
      return new Response('{"error":"not paired"}', { status: 401, headers: proof });
    }
    return new Response(JSON.stringify({ inserted: true, file: '/work/shop/tests/cart.spec.ts' }), { status: 200 });
  });
}

describe('postToEditor', () => {
  it('posts the payload with the token as a bearer credential, once the editor proved it holds it', async () => {
    const fetchMock = editorEndpoint(
      async () => new Response(JSON.stringify({ inserted: true, file: null }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await postToEditor(PAIRING, { kind: 'steps', steps: { v: 1 } });
    expect(result).toEqual({ ok: true, file: null });
    // Asked on the live endpoint beside send, which answers a request without a body in both editors.
    const [challengeUrl, challenge] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(challengeUrl).toBe('http://127.0.0.1:47211/piwi/live');
    expect(challenge.headers).toEqual({ [EDITOR_CHALLENGE_HEADER]: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(PAIRING.url);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${PAIRING.token}`);
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'steps', steps: { v: 1 } });
  });

  it('posts to a JetBrains IDE, whose send endpoint takes a POST alone, once its live endpoint proved it', async () => {
    const fetchMock = jetbrainsEndpoint();
    vi.stubGlobal('fetch', fetchMock);
    expect(await postToEditor(JETBRAINS, { kind: 'locator', text: "getByRole('button')" })).toEqual({
      ok: true,
      file: '/work/shop/tests/cart.spec.ts',
    });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => `${init.method ?? 'GET'} ${new URL(url).pathname}`)).toEqual([
      'GET /api/piwi/live',
      'POST /api/piwi/send',
    ]);
    expect(JSON.stringify(calls[0]![1].headers)).not.toContain(PAIRING.token);
  });

  it('sends nothing to a program on the paired port that cannot prove it holds the token', async () => {
    for (const fetchMock of [
      editorEndpoint(async () => new Response('{}'), 'another_token_0123456789'),
      vi.fn(async () => new Response('{}', { status: 200 })),
    ]) {
      vi.stubGlobal('fetch', fetchMock);
      expect(await postToEditor(PAIRING, { kind: 'locator', text: 'x' })).toEqual({
        ok: false,
        error: t('common_editorNotProven'),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.stringify(init.headers)).not.toContain(PAIRING.token);
    }
  });

  it('asks to update the editor’s Piwi extension or plugin when it answers as one older than the proof', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await postToEditor(PAIRING, { kind: 'locator', text: 'x' })).toEqual({
      ok: false,
      error: t('common_editorOutdated'),
    });
    expect(t('common_editorOutdated')).toContain('update Piwi');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the editor’s reason when it refuses', async () => {
    vi.stubGlobal(
      'fetch',
      editorEndpoint(async () => new Response(JSON.stringify({ error: 'no editor is open in shop' }), { status: 422 })),
    );
    expect(await postToEditor(PAIRING, { kind: 'locator', text: 'x' })).toEqual({
      ok: false,
      error: 'no editor is open in shop',
    });
  });

  it('reports an editor that is not running', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await postToEditor(PAIRING, { kind: 'locator', text: 'x' })).toEqual({
      ok: false,
      error: t('common_editorUnreachable'),
    });
  });
});
