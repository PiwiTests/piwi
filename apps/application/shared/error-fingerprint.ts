/**
 * Error fingerprinting for failure clustering.
 *
 * Normalizes raw Playwright error text into a stable fingerprint so that
 * failures sharing a root cause can be grouped into `failure_clusters` rows:
 * volatile tokens (timeouts, ids, received/expected values, URLs, emails,
 * hashes, timestamps, machine paths, dynamic locator options) are masked,
 * while the discriminating signals (error category, message shape, locator
 * target) are kept.
 *
 * The top stack frame is hashed only for a generic failure
 * ({@link isGenericFailure}): its message tells it from no unrelated failure,
 * so the file it failed in does. Any other failure keeps it out of the hash, so
 * one root cause reached from several spec files, through a shared helper or
 * page object, groups into a single cluster.
 *
 * The signature itself (`extractErrorSignature` and its masking) lives in
 * `@piwitests/core/error-signature`, shared with the reporter's flake mode;
 * this module hashes it. Lives in `shared/` because demo mode runs API handlers
 * in the browser — everything here must work in Node and service-worker
 * contexts, so hashing uses Web Crypto instead of node:crypto.
 */
import {
  extractLeafSelector,
  extractMessageHead,
  extractSelector,
  extractTopFrameFile,
  stripAnsi,
} from '@piwitests/core/error-parse';
import {
  extractErrorSignature,
  maskPaths,
  maskSelector,
  maskVolatile,
  type ErrorSignature,
} from '@piwitests/core/error-signature';
import { sha256Hex } from './utils/hash';

export { extractLeafSelector, extractMessageHead, extractSelector, extractTopFrameFile, stripAnsi };
export { extractErrorSignature, maskSelector, maskVolatile };
export type { ErrorSignature };

/**
 * Bump when the normalization algorithm changes. The version is part of the
 * hashed input, so old and new fingerprints can never collide silently.
 * Existing clusters, their merge aliases and their per-test routes are migrated
 * in place by re-fingerprinting their immutable samples on startup (see
 * shared/handlers/failure-cluster-recluster.ts), so triage status, notes,
 * diagnoses and merges survive an algorithm change.
 */
export const FINGERPRINT_VERSION = 5;

export interface ErrorFingerprint extends ErrorSignature {
  /**
   * SHA-256 hex over version + error type + normalized message + masked
   * selector, and the top frame's file for a generic failure
   */
  fingerprint: string;
}

/** The matcher line of an `expect(…)` failure: `expect(received).toBe(expected) // Object.is equality`. */
const MATCHER_LINE_RE =
  /^(?:Error: )?expect(?:\.soft|\.poll)?\(\w+\)(?:\.not)?\.to\w+\(\w*\)(?: failed)?(?: \/\/ .*)?$/;
/** A line of an `expect(…)` failure whose value the masks took out: `Received: <VALUE>`, `Timeout: <N>ms`. */
const MASKED_VALUE_LINE_RE = /^(?:(?:Expected|Received)[^:]*: <VALUE>|Timeout: <N>ms)$/;
const TEST_TIMEOUT_RE = /^Test timeout of <N>ms exceeded\b/;
const BARE_ERROR_RE = /^(?:TypeError|ReferenceError): /;

/**
 * Whether a failure's signature tells it from no unrelated failure: it names
 * no locator, and its masked message head is an `expect(…)` matcher whose
 * values are all masked, a test timeout, or a bare `TypeError` or
 * `ReferenceError` line. Its fingerprint also hashes the file it failed in.
 */
export function isGenericFailure(sig: ErrorSignature): boolean {
  if (sig.selector) return false;
  const [head = '', ...rest] = sig.normalizedMessage.split('\n');
  if (TEST_TIMEOUT_RE.test(head)) return true;
  if (BARE_ERROR_RE.test(head)) return rest.length === 0;
  return MATCHER_LINE_RE.test(head) && rest.every((line) => MASKED_VALUE_LINE_RE.test(line));
}

export async function computeErrorFingerprint(rawError: string): Promise<ErrorFingerprint> {
  const sig = extractErrorSignature(rawError);
  const key = [
    `v${FINGERPRINT_VERSION}`,
    sig.errorType,
    sig.normalizedMessage,
    sig.selector ? maskSelector(sig.selector) : '',
  ];
  if (isGenericFailure(sig)) key.push(sig.topFrameFile ? maskPaths(sig.topFrameFile) : '');
  return { ...sig, fingerprint: await sha256Hex(key.join('\u0000')) };
}

/**
 * Condense a Playwright error for AI context: keep the message head, call log
 * and user-file stack frames; collapse consecutive `node_modules`/`node:`
 * internal frames to a `… (N internal frames)` placeholder. Apply an optional
 * character budget (truncating from the stack tail first). Use this anywhere a
 * flat `slice(0, N)` currently dominates — the message + call log carries the
 * diagnostic signal; 200 internal frames carry none.
 */
export function condenseErrorText(text: string, maxChars?: number): string {
  const stackStart = text.search(/\n    at /);
  if (stackStart === -1) {
    return maxChars !== undefined && text.length > maxChars ? text.slice(0, maxChars) + '\n[truncated]' : text;
  }

  const preStack = text.slice(0, stackStart);
  const stackBlock = text.slice(stackStart);

  const frameLines = stackBlock.split('\n');
  const userFrames: string[] = [];
  let internalCount = 0;

  const flushInternal = () => {
    if (internalCount > 0) {
      userFrames.push(`\u2026 (${internalCount} internal frame${internalCount > 1 ? 's' : ''})`);
      internalCount = 0;
    }
  };

  for (const line of frameLines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('at ')) {
      const isInternal = line.includes('node_modules') || trimmed.startsWith('at node:');
      if (isInternal) {
        internalCount++;
      } else {
        flushInternal();
        userFrames.push(line);
      }
    } else if (trimmed === '') {
      // Pass blank lines through (between stack segments); don't flush internal group yet
      userFrames.push(line);
    } else {
      // Non-stack content inside the stack block (e.g. additional error messages)
      flushInternal();
      userFrames.push(line);
    }
  }
  flushInternal();

  let result = preStack + '\n' + userFrames.join('\n');
  if (maxChars !== undefined && result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n[truncated]';
  }
  return result;
}
