import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { desktopTokenProof } from '../src/desktop-proof';
import {
  EDITOR_CHALLENGE_HEADER,
  EDITOR_PROOF_HEADER,
  editorTokenProof,
  formatPairing,
  isEditorChallenge,
  newEditorChallenge,
  parsePairing,
  parseSendPayload,
  sendAuthorized,
} from '../src/editor-send';

const TOKEN = 'abcdefghijklmnop_1234';

describe('pairing', () => {
  test('round-trips through the address an editor shows', () => {
    const pairing = { url: 'http://127.0.0.1:47211/piwi/send', token: TOKEN };
    expect(parsePairing(`  ${formatPairing(pairing)} `)).toEqual(pairing);
    expect(parsePairing(`http://localhost:63342/api/piwi/send#${TOKEN}`)).toEqual({
      url: 'http://localhost:63342/api/piwi/send',
      token: TOKEN,
    });
  });

  test('refuses anything but a loopback http URL with a port and a token', () => {
    expect(parsePairing(`http://127.0.0.1:47211/piwi/send`)).toBeNull();
    expect(parsePairing(`http://127.0.0.1:47211/piwi/send#short`)).toBeNull();
    expect(parsePairing(`https://127.0.0.1:47211/piwi/send#${TOKEN}`)).toBeNull();
    expect(parsePairing(`http://example.com:47211/piwi/send#${TOKEN}`)).toBeNull();
    expect(parsePairing(`http://127.0.0.1/piwi/send#${TOKEN}`)).toBeNull();
    expect(parsePairing(`not a url#${TOKEN}`)).toBeNull();
  });
});

describe('parseSendPayload', () => {
  test('reads a locator line and a steps document', () => {
    expect(parseSendPayload({ kind: 'locator', text: "page.getByRole('button')" })).toEqual({
      kind: 'locator',
      text: "page.getByRole('button')",
    });
    expect(parseSendPayload({ kind: 'steps', steps: { v: 1 } })).toEqual({ kind: 'steps', steps: { v: 1 } });
  });

  test('reads the line a picked locator belongs to', () => {
    const at = { file: 'tests/login.spec.ts', line: 42 };
    expect(parseSendPayload({ kind: 'locator', text: "getByRole('button')", at })).toEqual({
      kind: 'locator',
      text: "getByRole('button')",
      at,
    });
    expect(parseSendPayload({ kind: 'locator', text: "getByRole('button')", at: null })).toEqual({
      kind: 'locator',
      text: "getByRole('button')",
    });
  });

  test('refuses a place outside the run or on no line', () => {
    const refusedFile = { error: 'at.file must be a path relative to the run, without ..' };
    const refusedLine = { error: 'at.line must be a positive integer' };
    const send = (at: unknown) => parseSendPayload({ kind: 'locator', text: 'getByText("x")', at });
    expect(send({ file: '../secrets.ts', line: 1 })).toEqual(refusedFile);
    expect(send({ file: 'tests/../../x.ts', line: 1 })).toEqual(refusedFile);
    expect(send({ file: '/etc/passwd', line: 1 })).toEqual(refusedFile);
    expect(send({ file: 'C:\\work\\a.ts', line: 1 })).toEqual(refusedFile);
    expect(send({ file: '', line: 1 })).toEqual(refusedFile);
    expect(send('tests/a.ts:1')).toEqual(refusedFile);
    expect(send({ file: 'tests/a.ts', line: 0 })).toEqual(refusedLine);
    expect(send({ file: 'tests/a.ts', line: 1.5 })).toEqual(refusedLine);
    expect(send({ file: 'tests/a.ts', line: '3' })).toEqual(refusedLine);
    expect(parseSendPayload({ kind: 'locator', text: 'x'.repeat(4001), at: { file: 'a.ts', line: 1 } })).toEqual({
      error: 'text is at most 4000 characters',
    });
  });

  test('says why a body is refused', () => {
    expect(parseSendPayload(null)).toEqual({ error: 'the body must be a JSON object' });
    expect(parseSendPayload({ kind: 'locator', text: ' ' })).toEqual({ error: 'text must be a non-empty string' });
    expect(parseSendPayload({ kind: 'locator', text: 'x'.repeat(4001) })).toEqual({
      error: 'text is at most 4000 characters',
    });
    expect(parseSendPayload({ kind: 'steps' })).toEqual({ error: 'steps must be a steps document' });
    expect(parseSendPayload({ kind: 'file' })).toEqual({ error: "kind must be 'locator' or 'steps'" });
  });
});

describe('sendAuthorized', () => {
  test('accepts the bearer token only', () => {
    expect(sendAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(sendAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(sendAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(sendAuthorized(TOKEN, TOKEN)).toBe(false);
    expect(sendAuthorized(undefined, TOKEN)).toBe(false);
    expect(sendAuthorized('Bearer ', '')).toBe(false);
  });
});

describe('the editor token proof', () => {
  test('is the HMAC-SHA256 of the port and the challenge, keyed by the pairing token', async () => {
    const challenge = 'cd'.repeat(32);
    const expected = createHmac('sha256', TOKEN).update(`piwi-editor-proof:47211:${challenge}`).digest('hex');
    expect(await editorTokenProof(TOKEN, 47211, challenge)).toBe(expected);
    expect([EDITOR_CHALLENGE_HEADER, EDITOR_PROOF_HEADER]).toEqual(['x-piwi-editor-challenge', 'x-piwi-editor-proof']);
  });

  test('differs for another token, another port, and the desktop app’s proof of the same challenge', async () => {
    const challenge = newEditorChallenge();
    const proof = await editorTokenProof(TOKEN, 47211, challenge);
    expect(await editorTokenProof(`${TOKEN}x`, 47211, challenge)).not.toBe(proof);
    expect(await editorTokenProof(TOKEN, 47212, challenge)).not.toBe(proof);
    expect(await desktopTokenProof(TOKEN, 47211, challenge)).not.toBe(proof);
  });

  test('takes only a hex challenge of 32 to 128 characters', () => {
    expect(isEditorChallenge(newEditorChallenge())).toBe(true);
    expect(isEditorChallenge('a'.repeat(128))).toBe(true);
    expect(newEditorChallenge()).not.toBe(newEditorChallenge());
    for (const value of [
      'ab'.repeat(15),
      'AB'.repeat(16),
      'g'.repeat(32),
      'a'.repeat(129),
      ` ${'a'.repeat(32)}`,
      42,
      null,
    ]) {
      expect(isEditorChallenge(value)).toBe(false);
    }
  });
});
