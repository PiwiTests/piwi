import { describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { desktopTokenProof, isDesktopChallenge, newDesktopChallenge } from '../src/desktop-proof';

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
