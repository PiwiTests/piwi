/**
 * How Piwi Picker checks that the program at the desktop app's paired address
 * is that app before it sends the app's token there. The extension sends
 * `/api/health` a random challenge in {@link DESKTOP_CHALLENGE_HEADER}; the
 * app answers in {@link DESKTOP_PROOF_HEADER} with {@link desktopTokenProof}:
 * an HMAC of the challenge keyed by its token, for the loopback port it
 * answers on. Another program on that port holds no token, and one that relays
 * the challenge to the app on another port gets a proof for that other port.
 */

/** The request header carrying the challenge. */
export const DESKTOP_CHALLENGE_HEADER = 'x-piwi-desktop-challenge';

/** The response header carrying the proof. */
export const DESKTOP_PROOF_HEADER = 'x-piwi-desktop-proof';

/** Whether `value` is a challenge: 32 to 128 lowercase hex characters. */
export function isDesktopChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32,128}$/.test(value);
}

/** A new challenge: 32 random bytes, hex. */
export function newDesktopChallenge(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

/** The proof, hex: HMAC-SHA256 keyed by `token` over `piwi-desktop-proof:<port>:<challenge>`. */
export async function desktopTokenProof(token: string, port: number, challenge: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`piwi-desktop-proof:${port}:${challenge}`));
  return hex(new Uint8Array(mac));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
