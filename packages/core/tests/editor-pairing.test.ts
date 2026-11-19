import { describe, expect, test } from 'vitest';
import {
  EDITOR_PAIRING_TTL_MS,
  EditorPairingRequests,
  allowEditorPairing,
  editorPairingProof,
  normalizeEditorPairingCode,
  JETBRAINS_PAIRING_PORTS,
  MAX_WAITING_EDITOR_PAIRINGS,
  VSCODE_PAIRING_PORTS,
  editorHello,
  editorPairingBaseOf,
  editorPairingBases,
  editorPairingClient,
  editorPairingIdOf,
  newEditorPairingCode,
  parseEditorHello,
  type EditorPairingPoll,
  type EditorPairingStart,
} from '../src/editor-pairing';

const CHROME = `chrome-extension://${'a'.repeat(32)}`;
const JSON_TYPE = 'application/json; charset=utf-8';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function started(requests: EditorPairingRequests, body: unknown = { browser: 'Chrome', os: 'macOS' }) {
  const answer = requests.start(CHROME, JSON_TYPE, body);
  expect(answer.status).toBe(201);
  return answer.body as EditorPairingStart;
}

describe('where Piwi Picker looks', () => {
  test('asks VS Code’s ports first, then the JetBrains built-in server’s', () => {
    const bases = editorPairingBases();
    expect(bases[0]).toBe('http://127.0.0.1:7247/piwi');
    expect(bases).toContain('http://127.0.0.1:63342/api/piwi');
    expect(bases).toContain('http://127.0.0.1:63361/api/piwi');
    expect(bases).toHaveLength(VSCODE_PAIRING_PORTS.length + JETBRAINS_PAIRING_PORTS.length);
  });

  test('finds the base beside a Send to editor address', () => {
    expect(editorPairingBaseOf('http://127.0.0.1:7247/piwi/send')).toBe('http://127.0.0.1:7247/piwi');
    expect(editorPairingBaseOf('http://127.0.0.1:63342/api/piwi/send')).toBe('http://127.0.0.1:63342/api/piwi');
    expect(editorPairingBaseOf('http://127.0.0.1:63342/api/piwi/live')).toBeNull();
  });
});

describe('the hello', () => {
  test('reads an editor’s names, without control characters, cut to their limits', () => {
    expect(parseEditorHello({ editor: 'vscode', product: 'Visual Studio Code', windows: ['shop', 'api'] })).toEqual({
      editor: 'vscode',
      product: 'Visual Studio Code',
      windows: ['shop', 'api'],
    });
    const hello = parseEditorHello({
      editor: 'jetbrains',
      product: 'Web\u0007Storm',
      windows: [...Array.from({ length: 12 }, (_, i) => `p${i}`), 'x'.repeat(200), 42],
    });
    expect(hello?.product).toBe('Web Storm');
    expect(hello?.windows).toHaveLength(8);
    expect(editorHello('vscode', 'y'.repeat(200), ['a']).product).toHaveLength(80);
  });

  test('refuses anything but a VS Code or JetBrains hello with a product', () => {
    expect(parseEditorHello(null)).toBeNull();
    expect(parseEditorHello({ editor: 'emacs', product: 'Emacs', windows: [] })).toBeNull();
    expect(parseEditorHello({ editor: 'vscode', product: '  ', windows: [] })).toBeNull();
    expect(parseEditorHello({ editor: 'vscode', product: 'Code' })).toEqual({
      editor: 'vscode',
      product: 'Code',
      windows: [],
    });
  });
});

describe('a code and a client', () => {
  test('reads a code as typed, in any case, with spaces or a dash, and nothing else', () => {
    expect(normalizeEditorPairingCode('BCDF-GHJK')).toBe('BCDFGHJK');
    expect(normalizeEditorPairingCode(' bcdf ghjk ')).toBe('BCDFGHJK');
    expect(normalizeEditorPairingCode('BCDFGHJ')).toBeNull();
    expect(normalizeEditorPairingCode('BCDF-GHJA')).toBeNull();
    expect(normalizeEditorPairingCode('')).toBeNull();
  });

  test('proves the code typed for one request and one token, as both editors compute it', async () => {
    const proof = '9dce09ed2dabb72ba5e238052afa36fcc0c563abfc4b2814d7c8684c2e966e1b';
    expect(await editorPairingProof('bcdf-ghjk', '0123456789abcdef', 'the-token-1234567890')).toBe(proof);
    expect(await editorPairingProof('BCDF-GHJL', '0123456789abcdef', 'the-token-1234567890')).not.toBe(proof);
    expect(await editorPairingProof('BCDF-GHJK', '0123456789abcdee', 'the-token-1234567890')).not.toBe(proof);
    expect(await editorPairingProof('nope', '0123456789abcdef', 'the-token-1234567890')).toBeNull();
  });

  test('a code is eight consonants in two groups', () => {
    for (let i = 0; i < 50; i++)
      expect(newEditorPairingCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  });

  test('names the browser and its system, and nothing else', () => {
    expect(editorPairingClient({ browser: 'Chrome', os: 'macOS' })).toBe('Chrome on macOS');
    expect(editorPairingClient({ browser: 'Firefox' })).toBe('Firefox');
    expect(editorPairingClient({ browser: '<b>Edge</b>', os: 'Windows\n11' })).toBe('bEdgeb on Windows11');
    expect(editorPairingClient('nope')).toBe('a browser');
  });
});

describe('EditorPairingRequests', () => {
  test('hands the token with the proof of the code typed, once, on the first poll after it', async () => {
    const time = clock();
    const requests = new EditorPairingRequests({ now: time.now });
    const start = started(requests);
    // The editor never makes the code: Piwi Picker shows its own.
    expect(start).not.toHaveProperty('code');
    expect(start.interval).toBe(2);
    expect(start.expiresIn).toBe(300);
    expect(requests.waiting()).toEqual([expect.objectContaining({ id: start.id, client: 'Chrome on macOS' })]);
    expect(requests.poll(start.id, start.secret).body).toEqual({ status: 'waiting' });

    // A typed text that is no code leaves the request waiting.
    expect(await allowEditorPairing(requests, start.id, 'the-token-1234567890', 'hello')).toBe('not-a-code');
    expect(requests.waiting()).toHaveLength(1);
    expect(await allowEditorPairing(requests, start.id, 'the-token-1234567890', 'bcdf ghjk')).toBe('allowed');
    expect(requests.waiting()).toEqual([]);
    expect(requests.poll(start.id, start.secret).body).toEqual({
      status: 'allowed',
      token: 'the-token-1234567890',
      proof: await editorPairingProof('BCDF-GHJK', start.id, 'the-token-1234567890'),
    });
    expect(requests.poll(start.id, start.secret).body).toEqual({ status: 'claimed' });
    expect(await allowEditorPairing(requests, start.id, 'another-token-123456', 'BCDF-GHJK')).toBe('gone');
  });

  test('says no to a request the person denied, and hands no token', () => {
    const requests = new EditorPairingRequests();
    const start = started(requests);
    expect(requests.answer(start.id, null)).toBe(true);
    expect(requests.poll(start.id, start.secret).body).toEqual({ status: 'denied' });
  });

  test('answers a wrong secret or an unknown id as no request at all', () => {
    const requests = new EditorPairingRequests();
    const start = started(requests);
    requests.answer(start.id, { token: 'the-token-1234567890', proof: 'p' });
    expect(requests.poll(start.id, 'f'.repeat(64)).status).toBe(404);
    expect(requests.poll(start.id, undefined).status).toBe(404);
    expect(requests.poll('0123456789abcdef', start.secret).status).toBe(404);
    // The token is still there for the right secret.
    expect((requests.poll(start.id, start.secret).body as EditorPairingPoll).token).toBe('the-token-1234567890');
  });

  test('expires a request nobody answered, then forgets it', () => {
    const time = clock();
    let changes = 0;
    const requests = new EditorPairingRequests({ now: time.now, changed: () => changes++ });
    const start = started(requests);
    expect(changes).toBe(1);
    time.advance(EDITOR_PAIRING_TTL_MS);
    expect(requests.expire()).toBe(true);
    expect(changes).toBe(2);
    expect(requests.waiting()).toEqual([]);
    expect(requests.answer(start.id, { token: 'late-token-12345678', proof: 'p' })).toBe(false);
    expect(requests.poll(start.id, start.secret).body).toEqual({ status: 'expired' });
    time.advance(61_000);
    expect(requests.poll(start.id, start.secret).status).toBe(404);
  });

  test('starts a request only for an extension’s JSON object, and only a few at once', () => {
    const requests = new EditorPairingRequests();
    expect(requests.start('https://example.com', JSON_TYPE, {}).status).toBe(403);
    expect(requests.start(null, JSON_TYPE, {}).status).toBe(403);
    expect(requests.start(CHROME, 'text/plain', {}).status).toBe(415);
    for (const body of [undefined, null, 'text', 3, []])
      expect(requests.start(CHROME, JSON_TYPE, body).status).toBe(400);
    const extension = (i: number) => `chrome-extension://${'abcdefghijklmnop'[i]!.repeat(32)}`;
    for (let i = 0; i < MAX_WAITING_EDITOR_PAIRINGS; i++)
      expect(requests.start(extension(i), JSON_TYPE, {}).status).toBe(201);
    expect(requests.start(extension(9), JSON_TYPE, {}).status).toBe(429);
    requests.answer(requests.waiting()[0]!.id, { token: 'the-token-1234567890', proof: 'p' });
    expect(requests.start(extension(9), JSON_TYPE, {}).status).toBe(201);
  });

  test('takes the place of the request the same extension made before', () => {
    const requests = new EditorPairingRequests();
    const first = started(requests);
    const second = started(requests);
    expect(requests.waiting().map((r) => r.id)).toEqual([second.id]);
    expect(requests.poll(first.id, first.secret).body).toEqual({ status: 'expired' });
    expect(requests.answer(first.id, { token: 'the-token-1234567890', proof: 'p' })).toBe(false);
  });

  test('lets an extension the person denied ask again only a minute later', () => {
    const time = clock();
    const requests = new EditorPairingRequests({ now: time.now });
    requests.answer(started(requests).id, null);
    expect(requests.start(CHROME, JSON_TYPE, {}).status).toBe(429);
    // Another extension asks meanwhile.
    expect(requests.start('moz-extension://0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', JSON_TYPE, {}).status).toBe(201);
    time.advance(61_000);
    expect(requests.start(CHROME, JSON_TYPE, {}).status).toBe(201);
  });

  test('hands over nothing a request was allowed before Unpair', () => {
    const requests = new EditorPairingRequests();
    const start = started(requests);
    requests.answer(start.id, { token: 'the-old-token-123456', proof: 'p' });
    requests.forgetTokens();
    expect(requests.poll(start.id, start.secret).body).toEqual({ status: 'expired' });
  });
});

describe('editorPairingIdOf', () => {
  test('reads the id of a poll under its base alone', () => {
    expect(editorPairingIdOf('/piwi/pairings/0123456789abcdef', '/piwi')).toBe('0123456789abcdef');
    expect(editorPairingIdOf('/api/piwi/pairings/0123456789abcdef', '/api/piwi')).toBe('0123456789abcdef');
    expect(editorPairingIdOf('/piwi/pairings/0123456789ABCDEF', '/piwi')).toBeNull();
    expect(editorPairingIdOf('/piwi/pairings/../send', '/piwi')).toBeNull();
    expect(editorPairingIdOf('/piwi/pairings', '/piwi')).toBeNull();
  });
});
