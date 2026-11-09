/**
 * Node-importable mirror of `shared/error-fingerprint.ts` and the signature it
 * hashes (`packages/core/src/error-signature.ts`, `error-parse.ts`) for the demo seed
 * generator (`scripts/generate-demo-seed.mjs` runs under plain Node, which
 * cannot resolve the TypeScript module or its `@piwitests/core` import).
 *
 * The logic below MUST stay regex-for-regex identical to the real module —
 * `tests/unit/demo-seed-consistency.test.ts` asserts byte-equal fingerprints,
 * error types and signatures for every seeded error, so any drift fails CI.
 * Hashing uses the same Web Crypto API (available in Node ≥ 19).
 *
 * Do NOT bump the version here independently — `FINGERPRINT_VERSION` lives in
 * `shared/error-fingerprint.ts`; mirror its value.
 */

const FINGERPRINT_VERSION = 5;

// eslint-disable-next-line no-control-regex -- intentionally matches the ESC byte to strip ANSI color codes
const ANSI_RE = new RegExp('\\u001B\\[[0-9;]*m', 'g');
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX_RE = /\b[0-9a-f]{8,}\b/gi;
const SHORT_HEX_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{6,7}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s'"`)]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;
const STRICT_MODE_ELEMENTS_RE = /(resolved to \d+ elements?:)(?:\n[ \t]*(?:\d+\) [^\n]*|\.\.\.))+/g;
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;
const ABSOLUTE_PATH_RE =
  /(^|[^\w.~-])(?:\/(?:home|Users|root|__w|builds|github\/workspace|(?:private\/)?var\/folders)\/|[A-Za-z]:[\\/])(?:[^\s'"`()<>,;]*[\\/])?/gm;
const TEMP_SUFFIX_RE = /([\\/][^\\/\s'"`()<>,;]*?[-_])(?=[a-z]{0,5}[A-Z0-9])[A-Za-z0-9]{6}(?![\w.-])/g;
const UNDERSCORE_TOKEN_RE = /_([A-Za-z0-9]{8,})/g;
const MATCHER_LINE_RE =
  /^(?:Error: )?expect(?:\.soft|\.poll)?\(\w+\)(?:\.not)?\.to\w+\(\w*\)(?: failed)?(?: \/\/ .*)?$/;
const MASKED_VALUE_LINE_RE = /^(?:(?:Expected|Received)[^:]*: <VALUE>|Timeout: <N>ms)$/;
const TEST_TIMEOUT_RE = /^Test timeout of <N>ms exceeded\b/;
const BARE_ERROR_RE = /^(?:TypeError|ReferenceError): /;
const SELECTOR_OPTION_RE =
  /\b(name|hasText|hasNotText|has|placeholder|label|title|alt|exact)\s*:\s*(['"`])(?:\\.|(?!\2)[\s\S])*?\2/gi;
const SELECTOR_FN_RE =
  /\b(?:locator|frameLocator|getByRole|getByTestId|getByText|getByLabel|getByPlaceholder|getByAltText|getByTitle)\(/;

/** @param {string} text */
export function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

/** @param {string} text @returns {'timeout' | 'assertion' | 'strict-mode' | 'navigation' | 'crash' | 'unknown'} */
export function classifyError(text) {
  if (/strict mode violation/i.test(text)) return 'strict-mode';
  if (
    /\bexpect\(|\bexpect\.|Expected (?:string|substring|pattern|value)|\.toHave|\.toBe|\.toContain|\.toEqual/.test(text)
  )
    return 'assertion';
  if (/Target page, context or browser has been closed|Target closed|browser has been closed|Page crashed/i.test(text))
    return 'crash';
  if (/net::ERR_|NS_ERROR_|Navigation failed/i.test(text)) return 'navigation';
  if (/Timeout \d+m?s exceeded|TimeoutError|Timed out \d+m?s/i.test(text)) return 'timeout';
  return 'unknown';
}

/** @param {string} text */
export function extractMessageHead(text) {
  let head = text;
  const callLogIdx = head.indexOf('\nCall log:');
  if (callLogIdx !== -1) head = head.slice(0, callLogIdx);
  const stackIdx = head.search(/\n\s+at /);
  if (stackIdx !== -1) head = head.slice(0, stackIdx);
  const lines = head
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.slice(0, 5).join('\n');
}

/** @param {string} whole @param {string} token */
function maskUnderscoreId(whole, token) {
  return /\d/.test(token) && /[A-Za-z]/.test(token) && !/^[A-Za-z]+\d+$/.test(token) ? '_<ID>' : whole;
}

/** @param {string} text */
export function maskPaths(text) {
  return text.replace(ABSOLUTE_PATH_RE, '$1<PATH>/').replace(TEMP_SUFFIX_RE, '$1<TMP>');
}

/** @param {string} text */
export function maskVolatile(text) {
  const structured = text
    .replace(STRICT_MODE_ELEMENTS_RE, '$1')
    .replace(/^(\s*(?:Received|Expected)[^:\n]*:).*$/gm, '$1 <VALUE>')
    .replace(URL_RE, '<URL>')
    .replace(EMAIL_RE, '<EMAIL>')
    .replace(ISO_TIMESTAMP_RE, '<TIMESTAMP>');
  return maskPaths(structured)
    .replace(UUID_RE, '<UUID>')
    .replace(UNDERSCORE_TOKEN_RE, maskUnderscoreId)
    .replace(LONG_HEX_RE, '<HASH>')
    .replace(SHORT_HEX_RE, '<HASH>')
    .replace(/([A-Za-z])?(\d+)/g, (whole, letter) => (letter ? whole : '<N>'));
}

/** @param {string} text */
function maskSelectorOptions(text) {
  return text.replace(SELECTOR_OPTION_RE, (_m, key) => `${key}: <STR>`);
}

/** @param {string} selector */
export function maskSelector(selector) {
  return maskVolatile(maskSelectorOptions(selector));
}

/** @param {string} text @returns {string | null} */
export function extractSelector(text) {
  const match = SELECTOR_FN_RE.exec(text);
  if (!match) return null;
  const start = match.index;
  let depth = 0;
  for (let i = start; i < Math.min(text.length, start + 200); i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    } else if (ch === '\n') {
      break;
    }
  }
  return text.slice(start, start + 80);
}

/** @param {string} text @returns {string | null} */
export function extractTopFrameFile(text) {
  const frameRe = /^[ \t]+at (?:.*? \()?([^()\s][^()\n]*?):(\d+):(\d+)\)?[ \t]*$/gm;
  let m;
  while ((m = frameRe.exec(text)) !== null) {
    const file = m[1].replace(/\\/g, '/');
    if (file.includes('node_modules') || file.startsWith('node:')) continue;
    return file;
  }
  return null;
}

/** @param {string} input */
async function sha256Hex(input) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {string} rawError
 * @returns {{ errorType: string, signature: string, normalizedMessage: string, selector: string | null, topFrameFile: string | null }}
 */
export function extractErrorSignature(rawError) {
  const text = stripAnsi(rawError);
  const errorType = classifyError(text);
  const normalizedMessage = maskVolatile(maskSelectorOptions(extractMessageHead(text)));
  const selector = extractSelector(text);
  const topFrameFile = extractTopFrameFile(text);
  const signature = (normalizedMessage.split('\n')[0] || '').slice(0, 200) || 'Unknown error';
  return { errorType, signature, normalizedMessage, selector, topFrameFile };
}

/** @param {{ normalizedMessage: string, selector: string | null }} sig */
export function isGenericFailure(sig) {
  if (sig.selector) return false;
  const [head = '', ...rest] = sig.normalizedMessage.split('\n');
  if (TEST_TIMEOUT_RE.test(head)) return true;
  if (BARE_ERROR_RE.test(head)) return rest.length === 0;
  return MATCHER_LINE_RE.test(head) && rest.every((line) => MASKED_VALUE_LINE_RE.test(line));
}

/**
 * @param {string} rawError
 * @returns {Promise<{ fingerprint: string, errorType: string, signature: string, normalizedMessage: string, selector: string | null, topFrameFile: string | null }>}
 */
export async function computeDemoFingerprint(rawError) {
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
