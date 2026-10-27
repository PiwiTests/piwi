import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  editorOriginPattern,
  getEditorPairing,
  moveLegacyEditorPairing,
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

describe('postToEditor', () => {
  it('posts the payload with the token as a bearer credential, once the editor proved it holds it', async () => {
    const fetchMock = editorEndpoint(
      async () => new Response(JSON.stringify({ inserted: true, file: null }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await postToEditor(PAIRING, { kind: 'steps', steps: { v: 1 } });
    expect(result).toEqual({ ok: true, file: null });
    const [challengeUrl, challenge] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(challengeUrl).toBe(PAIRING.url);
    expect(challenge.headers).toEqual({ [EDITOR_CHALLENGE_HEADER]: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(PAIRING.url);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${PAIRING.token}`);
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'steps', steps: { v: 1 } });
  });

  it('sends nothing to a program on the paired port that cannot prove it holds the token', async () => {
    for (const fetchMock of [
      editorEndpoint(async () => new Response('{}'), 'another_token_0123456789'),
      vi.fn(async () => new Response('{}', { status: 200 })),
      vi.fn(async () => new Response('not found', { status: 404 })),
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
