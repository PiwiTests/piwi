/**
 * The failure fingerprint `FINGERPRINT_VERSION` 4 computed, kept for
 * `backfillAliasSamples`: the merge aliases stored before aliases kept their
 * sample hold version 4 fingerprints, and each finds its sample among the
 * errors whose version 4 fingerprint is its own.
 *
 * Version 4 masked fewer volatile tokens and never hashed the top frame. It
 * read the error type and the locator as `extractErrorSignature` reads them
 * (`classifyError`, `extractSelector`) and the message head as
 * `extractMessageHead` cuts it.
 */
import { extractMessageHead, stripAnsi } from '@piwitests/core/error-parse';
import { extractErrorSignature, maskSelectorOptions } from '@piwitests/core/error-signature';
import { sha256Hex } from './utils/hash';

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX_RE = /\b[0-9a-f]{8,}\b/gi;
const SHORT_HEX_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{6,7}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s'"`)]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;

/** The volatile tokens version 4 masked, in its order. */
function maskVolatileV4(text: string): string {
  return text
    .replace(/^(\s*(?:Received|Expected)[^:\n]*:).*$/gm, '$1 <VALUE>')
    .replace(URL_RE, '<URL>')
    .replace(EMAIL_RE, '<EMAIL>')
    .replace(UUID_RE, '<UUID>')
    .replace(LONG_HEX_RE, '<HASH>')
    .replace(SHORT_HEX_RE, '<HASH>')
    .replace(/([A-Za-z])?(\d+)/g, (whole, letter) => (letter ? whole : '<N>'));
}

/** The fingerprint version 4 computed for `rawError`. */
export async function errorFingerprintV4(rawError: string): Promise<string> {
  const { errorType, selector } = extractErrorSignature(rawError);
  const normalizedMessage = maskVolatileV4(maskSelectorOptions(extractMessageHead(stripAnsi(rawError))));
  const maskedSelector = selector ? maskVolatileV4(maskSelectorOptions(selector)) : '';
  return sha256Hex(['v4', errorType, normalizedMessage, maskedSelector].join('\u0000'));
}
