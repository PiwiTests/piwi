/**
 * The HMAC and the random challenge the token proofs share
 * (`desktop-proof.ts`, `editor-send.ts`), on WebCrypto, which the browser,
 * Node 20 and later, and the editors' runtimes all have.
 */

/** HMAC-SHA256 of `message` keyed by `key`, both UTF-8, as lowercase hex. */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message))));
}

/** `byteCount` random bytes as lowercase hex. */
export function randomHex(byteCount: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
