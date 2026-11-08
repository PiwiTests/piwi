import { describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  DESKTOP_CHALLENGE_HEADER,
  desktopTokenProof,
  isDesktopChallenge,
  newDesktopChallenge,
  proveDesktopServer,
  type ProofRequest,
} from '../src/desktop-proof';

describe('the desktop token proof', () => {
  test('is the HMAC-SHA256 of the port and the challenge, keyed by the token', async () => {
    const challenge = 'ab'.repeat(32);
    const expected = createHmac('sha256', 'pd_token').update(`piwi-desktop-proof:3000:${challenge}`).digest('hex');
    expect(await desktopTokenProof('pd_token', 3000, challenge)).toBe(expected);
  });

  test('differs for another token or another port', async () => {
    const challenge = newDesktopChallenge();
    const proof = await desktopTokenProof('pd_token', 3000, challenge);
    expect(await desktopTokenProof('pd_other', 3000, challenge)).not.toBe(proof);
    expect(await desktopTokenProof('pd_token', 3001, challenge)).not.toBe(proof);
  });

  test('takes only a hex challenge of 32 to 128 characters', () => {
    expect(isDesktopChallenge(newDesktopChallenge())).toBe(true);
    expect(newDesktopChallenge()).not.toBe(newDesktopChallenge());
    for (const value of ['ab'.repeat(15), 'AB'.repeat(16), 'g'.repeat(32), 'a'.repeat(129), 42, null]) {
      expect(isDesktopChallenge(value)).toBe(false);
    }
  });
});

describe('proving the desktop server', () => {
  const token = 'pd_token';

  /** A server on `port` answering the challenge it is sent with the proof of `holds`, and the given status. */
  function answering(port: number, holds: string | null, status = 200): ProofRequest {
    return async (_url, init) => {
      const challenge = init.headers[DESKTOP_CHALLENGE_HEADER]!;
      const proof = holds === null ? null : await desktopTokenProof(holds, port, challenge);
      return { status, headers: { get: (name) => (name === 'x-piwi-desktop-proof' ? proof : null) } };
    };
  }

  test('proves a server that holds the token', async () => {
    expect(await proveDesktopServer('http://127.0.0.1:3000', token, { request: answering(3000, token) })).toBe(
      'proven',
    );
  });

  test('asks /api/health with a new challenge and no credential', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const request: ProofRequest = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return answering(3000, token)(url, init);
    };
    await proveDesktopServer('http://127.0.0.1:3000/some/path', token, { request });
    await proveDesktopServer('http://127.0.0.1:3000', token, { request });
    expect(seen.map((s) => s.url)).toEqual(['http://127.0.0.1:3000/api/health', 'http://127.0.0.1:3000/api/health']);
    expect(Object.keys(seen[0]!.headers)).toEqual([DESKTOP_CHALLENGE_HEADER]);
    expect(isDesktopChallenge(seen[0]!.headers[DESKTOP_CHALLENGE_HEADER])).toBe(true);
    expect(seen[0]!.headers[DESKTOP_CHALLENGE_HEADER]).not.toBe(seen[1]!.headers[DESKTOP_CHALLENGE_HEADER]);
  });

  test.each([
    ['another token', answering(3000, 'pd_other')],
    ['a proof for another port', answering(3001, token)],
    ['no proof header', answering(3000, null)],
    ['a status that is not 200', answering(3000, token, 503)],
  ])('does not prove %s', async (_name, request) => {
    expect(await proveDesktopServer('http://127.0.0.1:3000', token, { request })).toBe('unproven');
  });

  test('says unreachable when nothing answers or the address is not a URL', async () => {
    const refused: ProofRequest = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await proveDesktopServer('http://127.0.0.1:3000', token, { request: refused })).toBe('unreachable');
    expect(await proveDesktopServer('not a url', token, { request: refused })).toBe('unreachable');
  });
});
