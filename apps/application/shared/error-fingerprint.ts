/**
 * Error fingerprinting for failure clustering.
 *
 * Normalizes raw Playwright error text into a stable fingerprint so that
 * failures sharing a root cause can be grouped into `failure_clusters` rows:
 * volatile tokens (timeouts, ids, received/expected values, URLs, emails,
 * hashes, dynamic locator options) are masked, while the discriminating
 * signals (error category, message shape, locator target) are kept.
 *
 * The fingerprint is deliberately call-site agnostic: the top stack frame is
 * still extracted for display, but is NOT part of the hash, so the same root
 * cause reached from different spec files groups into a single cluster instead
 * of splitting per file.
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
 * Existing clusters are migrated in place by re-fingerprinting their immutable
 * `fingerprintSample` on startup (see shared/handlers/failure-cluster-recluster.ts),
 * so triage status, notes and diagnoses survive an algorithm change.
 */
export const FINGERPRINT_VERSION = 4;

export interface ErrorFingerprint extends ErrorSignature {
  /** SHA-256 hex over version + error type + normalized message + masked selector */
  fingerprint: string;
}

export async function computeErrorFingerprint(rawError: string): Promise<ErrorFingerprint> {
  const sig = extractErrorSignature(rawError);
  const input = [
    `v${FINGERPRINT_VERSION}`,
    sig.errorType,
    sig.normalizedMessage,
    sig.selector ? maskSelector(sig.selector) : '',
  ].join('\u0000');
  return { ...sig, fingerprint: await sha256Hex(input) };
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
