/**
 * Hashing helpers, safe to import from shared/browser code: the server hashes
 * with Node's `crypto` module, the browser and the demo's service worker with
 * the Web Crypto API.
 */

/** The part of Node's `crypto` module the helpers use. */
interface NodeCrypto {
  createHash(algorithm: string): { update(data: string): { digest(encoding: 'hex'): string } };
}

/**
 * Node's `crypto` module on the server, reached without an import the browser
 * build would have to resolve; undefined in the browser.
 */
const nodeCrypto = (
  globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
).process?.getBuiltinModule?.('node:crypto') as NodeCrypto | undefined;

/**
 * SHA-256 hex digest of a UTF-8 string. The server hashes in place: Web Crypto
 * sends each digest to the thread pool and back, which costs more than hashing
 * a short string.
 */
export async function sha256Hex(input: string): Promise<string> {
  if (nodeCrypto) return nodeCrypto.createHash('sha256').update(input).digest('hex');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A git object id: 40 hex characters (SHA-1) or 64 (SHA-256). */
export function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

/**
 * The git blob id of a text file's content, as `git hash-object` gives it for
 * the file stored as its UTF-8 bytes: the SHA-1 of `blob <byte length>\0`
 * followed by the content, or its SHA-256 for a repository that hashes with
 * SHA-256 (`format: 'sha256'`, whose ids have 64 hex characters).
 */
export async function gitBlobId(content: string, format: 'sha1' | 'sha256' = 'sha1'): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const object = `blob ${bytes.length}\0${content}`;
  if (nodeCrypto) return nodeCrypto.createHash(format).update(object).digest('hex');
  const digest = await globalThis.crypto.subtle.digest(
    format === 'sha256' ? 'SHA-256' : 'SHA-1',
    new TextEncoder().encode(object),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
