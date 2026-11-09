/**
 * How Piwi Picker, and the shells of the desktop app and of Piwi Runner, check that the program at the desktop app's
 * address is that app before they send its token there. The caller sends `/api/health` a random challenge in
 * {@link DESKTOP_CHALLENGE_HEADER}; the app answers in {@link DESKTOP_PROOF_HEADER} with {@link desktopTokenProof}:
 * an HMAC of the challenge keyed by its token, for the loopback port it answers on. Another program on that port
 * holds no token, and one that relays the challenge to the app on another port gets a proof for that other port.
 * {@link proveDesktopServer} is that check, for every client that sends the token.
 */
import { hmacSha256Hex, randomHex } from './hmac';

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
  return randomHex(32);
}

/** The proof, hex: HMAC-SHA256 keyed by `token` over `piwi-desktop-proof:<port>:<challenge>`. */
export function desktopTokenProof(token: string, port: number, challenge: string): Promise<string> {
  return hmacSha256Hex(token, `piwi-desktop-proof:${port}:${challenge}`);
}

/** What {@link proveDesktopServer} found at an address: the app proved it holds the token, did not, or did not answer. */
export type DesktopProof = 'proven' | 'unproven' | 'unreachable';

/** The part of a response the check reads. */
export interface ProofResponse {
  status: number;
  headers: { get(name: string): string | null };
}

/** Sends the challenge request; `fetch` with redirects refused by default. */
export type ProofRequest = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<ProofResponse>;

const PROOF_TIMEOUT_MS = 5_000;

/** Whether two hex strings are equal, comparing every character. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether the program at `baseUrl` is the app that holds `token`: its `/api/health` answers a new random challenge
 * with 200 and the proof for the port of `baseUrl`. Sends no credential. A client calls this before its first request
 * that carries the token, and sends the token only on `'proven'`.
 */
export async function proveDesktopServer(
  baseUrl: string,
  token: string,
  options: { request?: ProofRequest; timeoutMs?: number } = {},
): Promise<DesktopProof> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'unreachable';
  }
  const request: ProofRequest = options.request ?? ((target, init) => fetch(target, { ...init, redirect: 'error' }));
  const challenge = newDesktopChallenge();
  let res: ProofResponse;
  try {
    res = await request(new URL('/api/health', url).href, {
      headers: { [DESKTOP_CHALLENGE_HEADER]: challenge },
      signal: AbortSignal.timeout(options.timeoutMs ?? PROOF_TIMEOUT_MS),
    });
  } catch {
    return 'unreachable';
  }
  const proof = res.headers.get(DESKTOP_PROOF_HEADER);
  if (res.status !== 200 || !proof) return 'unproven';
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return sameHex(proof, await desktopTokenProof(token, port, challenge)) ? 'proven' : 'unproven';
}

/**
 * A function that runs `check` for `key` and hands every caller that arrives while it is running the same answer. An
 * answer that has arrived is not kept: the next call runs `check` again, so each request that carries the token follows
 * its own proof.
 */
export function shareInFlight<T>(): (key: string, check: () => Promise<T>) => Promise<T> {
  const running = new Map<string, Promise<T>>();
  return (key, check) => {
    const existing = running.get(key);
    if (existing) return existing;
    const started = check().finally(() => {
      if (running.get(key) === started) running.delete(key);
    });
    running.set(key, started);
    return started;
  };
}
