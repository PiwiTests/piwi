/**
 * Error signatures: raw Playwright error text reduced to a category and a
 * normalized first line, with volatile tokens (timeouts, ids, received and
 * expected values, URLs, emails, hashes, timestamps, machine paths, a
 * strict-mode violation's element list, dynamic locator options) masked. Two
 * failures with the same root cause share a signature. The dashboard hashes a
 * signature into a failure-cluster fingerprint; flake mode compares signatures
 * to decide whether a lab failure is the one seen in history.
 */
import { extractMessageHead, extractSelector, extractTopFrameFile, stripAnsi } from './error-parse';

export type ErrorType = 'timeout' | 'assertion' | 'strict-mode' | 'navigation' | 'crash' | 'unknown';

export interface ErrorSignature {
  /** Heuristic category derived from the error text */
  errorType: ErrorType;
  /** Normalized first error line — the human-readable cluster name */
  signature: string;
  /** Normalized message head (up to 5 lines, volatile tokens and locator options masked) — the main fingerprint input */
  normalizedMessage: string;
  /** Playwright locator extracted from the error, if any (unmasked, for display) */
  selector: string | null;
  /**
   * First stack frame outside node_modules (file path only, no line number).
   * Kept for display; a fingerprint hashes it only for a message that names
   * nothing specific, so the same root cause groups across spec files.
   */
  topFrameFile: string | null;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Long pure-hex runs (hashes) and shorter mixed hex+digit tokens (git short SHAs, random ids)
const LONG_HEX_RE = /\b[0-9a-f]{8,}\b/gi;
const SHORT_HEX_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{6,7}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s'"`)]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;
// A strict-mode violation's element list: a line per element under "resolved
// to N elements:", and "..." for the rest. It varies with the page.
const STRICT_MODE_ELEMENTS_RE = /(resolved to \d+ elements?:)(?:\n[ \t]*(?:\d+\) [^\n]*|\.\.\.))+/g;
// An ISO 8601 timestamp with its time of day (`2024-05-01T10:30:00.000Z`).
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;
// An absolute path whose folders differ between machines: under a home folder
// (`/home/<user>`, `/Users/<user>`, `/root`), a CI job's workspace (`/__w`,
// `/builds`, `/github/workspace`), macOS's per-user temporary folder
// (`/var/folders`), or on a Windows drive. Its folders up to its last segment.
const ABSOLUTE_PATH_RE =
  /(^|[^\w.~-])(?:\/(?:home|Users|root|__w|builds|github\/workspace|(?:private\/)?var\/folders)\/|[A-Za-z]:[\\/])(?:[^\s'"`()<>,;]*[\\/])?/gm;
// The six random letters and digits `mkdtemp` ends a temporary folder's name
// with (`playwright_chromiumdev_profile-Xo8n2p`), after a dash or an
// underscore, at the end of a path segment, with a capital or a digit.
const TEMP_SUFFIX_RE = /([\\/][^\\/\s'"`()<>,;]*?[-_])(?=[a-z]{0,5}[A-Z0-9])[A-Za-z0-9]{6}(?![\w.-])/g;
// Letters and digits glued after an underscore: an id when it is long and
// mixes them (`order_5f3a9c1e2b`, `cus_4QFJrkXyZ`), see `maskUnderscoreId`.
const UNDERSCORE_TOKEN_RE = /_([A-Za-z0-9]{8,})/g;
// Dynamic values inside locator option objects: { name: '…' }, { hasText: '…' }, etc.
// The primary positional arg (testid/text/role) is left intact so
// getByTestId('login-button') and getByTestId('logout-button') stay distinct.
const SELECTOR_OPTION_KEY_RE = /\b(name|hasText|hasNotText|has|placeholder|label|title|alt|exact)\s*:\s*(['"`])/gi;

const LINE_TERMINATORS = new Set(['\n', '\r', '\u2028', '\u2029']);

/**
 * For each position of `text`, the index of the quote that closes a quoted value
 * starting there, or -1: the answer of `(?:\\.|(?!q)[\s\S])*?q`, computed in
 * one backward pass instead of by backtracking, which is exponential on a run of
 * backslash pairs with no closing quote. At each position the lazy regex ends on
 * the quote, else tries an escape pair (a backslash and any character but a line
 * terminator), else the character alone; each position has one answer.
 */
function closingQuoteIndex(text: string, quote: string): Int32Array {
  const close = new Int32Array(text.length + 1).fill(-1);
  for (let p = text.length - 1; p >= 0; p--) {
    const ch = text[p]!;
    if (ch === quote) {
      close[p] = p;
      continue;
    }
    const escaped = ch === '\\' && p + 1 < text.length && !LINE_TERMINATORS.has(text[p + 1]!) ? close[p + 2]! : -1;
    close[p] = escaped !== -1 ? escaped : close[p + 1]!;
  }
  return close;
}

/** Blank out the dynamic option values (row names, hasText, …) of every locator expression in `text`. */
export function maskSelectorOptions(text: string): string {
  const closers = new Map<string, Int32Array>();
  let out = '';
  let copied = 0;
  SELECTOR_OPTION_KEY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SELECTOR_OPTION_KEY_RE.exec(text))) {
    const quote = match[2]!;
    let close = closers.get(quote);
    if (!close) closers.set(quote, (close = closingQuoteIndex(text, quote)));
    const end = close[SELECTOR_OPTION_KEY_RE.lastIndex]!;
    if (end === -1) {
      SELECTOR_OPTION_KEY_RE.lastIndex = match.index + 1;
      continue;
    }
    out += `${text.slice(copied, match.index)}${match[1]}: <STR>`;
    copied = end + 1;
    SELECTOR_OPTION_KEY_RE.lastIndex = copied;
  }
  return out + text.slice(copied);
}

function classifyError(text: string): ErrorType {
  // Order matters: an expect() that timed out is still an assertion failure
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

/**
 * The token after an underscore as `maskVolatile` writes it: `<ID>` when it
 * holds a digit and a letter and is not a word ending in a number
 * (`field_label12` stays, an identifier with its index).
 */
function maskUnderscoreId(whole: string, token: string): string {
  return /\d/.test(token) && /[A-Za-z]/.test(token) && !/^[A-Za-z]+\d+$/.test(token) ? '_<ID>' : whole;
}

/**
 * Mask the folders of an absolute path that differ between machines, keeping
 * its last segment (`/home/runner/work/app/fixtures/user.json` →
 * `<PATH>/user.json`), and the random suffix of a temporary folder's name.
 */
export function maskPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH_RE, '$1<PATH>/').replace(TEMP_SUFFIX_RE, '$1<TMP>');
}

/**
 * Mask tokens that vary between occurrences of the same root cause:
 * received/expected values in assertions, a strict-mode violation's element
 * list, URLs, emails, timestamps, machine paths ({@link maskPaths}), UUIDs, ids
 * glued to an underscore, hashes, and standalone numbers (timeouts, ports, ids,
 * durations). Order matters — structured tokens are masked before the
 * catch-all number pass so their digits don't leak through.
 *
 * A digit run is only masked when it is NOT glued to a preceding letter, so
 * numbers-with-units (`30000ms`) and delimited indices (`row-5`) collapse, while
 * digits that are part of an identifier/parameter name (`p1`, `field2`, `utf8`)
 * are preserved — those discriminate genuinely different failures. (Capture-group
 * form rather than a lookbehind, for Safari < 16.4 compatibility in demo mode.)
 */
export function maskVolatile(text: string): string {
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

/**
 * Normalize a locator for the fingerprint: blank out dynamic option values
 * (row names, hasText, …) that carry per-row data, then apply the standard
 * volatile masking. The primary positional target is preserved.
 */
export function maskSelector(selector: string): string {
  return maskVolatile(maskSelectorOptions(selector));
}

/** Reduce raw error text to its {@link ErrorSignature}. */
export function extractErrorSignature(rawError: string): ErrorSignature {
  const text = stripAnsi(rawError);
  const errorType = classifyError(text);
  const normalizedMessage = maskVolatile(maskSelectorOptions(extractMessageHead(text)));
  const selector = extractSelector(text);
  const topFrameFile = extractTopFrameFile(text);
  const signature = (normalizedMessage.split('\n')[0] || '').slice(0, 200) || 'Unknown error';
  return { errorType, signature, normalizedMessage, selector, topFrameFile };
}
