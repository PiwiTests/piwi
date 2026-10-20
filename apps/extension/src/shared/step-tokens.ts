import { scanLocatorChain } from '@piwitests/core/locator-chain';
import type { BugPhrases } from '@piwitests/core/bug-phrases';
import type { RecordedStep } from '@piwitests/core/recording';

/**
 * A step's words, or any sentence, cut into the parts a reader looks for:
 * addresses, locators, other code, the key of a press, and the quoted names
 * and values. The pure half of `step-view.ts`, which draws them.
 */

export type WordToken = {
  kind: 'text' | 'url' | 'locator' | 'code' | 'key' | 'name' | 'value' | 'quote';
  text: string;
};

/** One line of text, as core writes a quoted name or value. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * `text` as tokens: its Markdown code spans, locators and addresses as code,
 * and in what remains the quoted names and values (`step`'s value told apart,
 * any quote of a sentence that is no step a `quote`), and the key of a press.
 */
export function wordTokens(text: string, step: RecordedStep | null, phrases: BugPhrases): WordToken[] {
  const tokens: WordToken[] = [];
  for (const part of splitCode(text)) {
    if (part.code) {
      tokens.push({ kind: codeKind(part.text), text: part.text });
      continue;
    }
    for (const piece of splitInlineCode(part.text)) {
      if (piece.code) tokens.push({ kind: codeKind(piece.text), text: piece.text });
      else tokens.push(...quotedTokens(piece.text, step, phrases));
    }
  }
  return tokens;
}

const INLINE_LOCATOR = /\b(?:getBy(?:Role|Text|Label|Placeholder|AltText|Title|TestId)|locator|frameLocator)\(/g;
const INLINE_URL = /\bhttps?:\/\/[^\s"'«»„“”<>]+/g;

/** Splits the locator expressions and the http addresses written in plain text out of it. */
function splitInlineCode(text: string): { text: string; code: boolean }[] {
  const found: { start: number; end: number }[] = [];
  for (const match of text.matchAll(INLINE_LOCATOR)) {
    if (found.some((f) => match.index < f.end)) continue;
    const scanned = scanLocatorChain(text.slice(match.index));
    if (scanned && scanned.end > 0) found.push({ start: match.index, end: match.index + scanned.end });
  }
  for (const match of text.matchAll(INLINE_URL)) {
    const end = match.index + match[0].replace(/[.,;:!?)]+$/, '').length;
    if (!found.some((f) => match.index < f.end && end > f.start)) found.push({ start: match.index, end });
  }
  found.sort((a, b) => a.start - b.start);
  const parts: { text: string; code: boolean }[] = [];
  let last = 0;
  for (const { start, end } of found) {
    if (start > last) parts.push({ text: text.slice(last, start), code: false });
    parts.push({ text: text.slice(start, end), code: true });
    last = end;
  }
  if (last < text.length) parts.push({ text: text.slice(last), code: false });
  return parts;
}

/** Splits Markdown inline code spans (any fence length) out of `text`. */
function splitCode(text: string): { text: string; code: boolean }[] {
  const parts: { text: string; code: boolean }[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      plain += text[i++];
      continue;
    }
    let fence = 0;
    while (text[i + fence] === '`') fence++;
    const marker = '`'.repeat(fence);
    let close = text.indexOf(marker, i + fence);
    while (close !== -1 && text[close + fence] === '`') {
      let run = 0;
      while (text[close + run] === '`') run++;
      close = text.indexOf(marker, close + run);
    }
    if (close === -1) {
      plain += text.slice(i, i + fence);
      i += fence;
      continue;
    }
    let inner = text.slice(i + fence, close);
    if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim()) inner = inner.slice(1, -1);
    if (plain) parts.push({ text: plain, code: false });
    plain = '';
    parts.push({ text: inner, code: true });
    i = close + fence;
  }
  if (plain) parts.push({ text: plain, code: false });
  return parts;
}

const LOCATOR_START = /^(?:page\.|this\.page\.)?(?:getBy[A-Z]\w*|locator|frameLocator|internal:)\s*\(/;

/** What a code span holds: an address, a locator, or other code (a test id, a file name). */
function codeKind(text: string): 'url' | 'locator' | 'code' {
  if (/^[a-z][\w+.-]*:\/\//i.test(text) || text.startsWith('/')) return 'url';
  return LOCATOR_START.test(text) ? 'locator' : 'code';
}

/** The quotes the phrasebook puts around a name or a value: `"…"`, `«…»`, `„…“`, without the spaces inside. */
function quoteMarks(phrases: BugPhrases): [string, string] {
  const [open = '"', close = '"'] = phrases.quote('\u0000').split('\u0000');
  return [open.trim() || '"', close.trim() || '"'];
}

/** The key a press step names, as the phrasebook writes it (`Ctrl+A`), or null. */
function pressedKey(step: RecordedStep, phrases: BugPhrases): string | null {
  if (step.action !== 'press' || !step.value) return null;
  const [before = '', after = ''] = phrases.steps.press('\u0000', null).split('\u0000');
  const full = phrases.steps.press(step.value, null);
  if (!full.startsWith(before) || !full.endsWith(after)) return null;
  return full.slice(before.length, full.length - after.length) || null;
}

function quotedTokens(text: string, step: RecordedStep | null, phrases: BugPhrases): WordToken[] {
  const [open, close] = quoteMarks(phrases);
  const value = step?.value != null && !step.redacted ? oneLine(step.value) : null;
  const key = step ? pressedKey(step, phrases) : null;
  const tokens: WordToken[] = [];
  let rest = text;
  while (rest) {
    const start = rest.indexOf(open);
    const end = start === -1 ? -1 : rest.indexOf(close, start + open.length);
    if (start === -1 || end === -1) break;
    tokens.push(...keyTokens(rest.slice(0, start), key));
    const inner = rest.slice(start + open.length, end);
    const kind = !step ? 'quote' : value !== null && oneLine(inner) === value ? 'value' : 'name';
    tokens.push({ kind, text: rest.slice(start, end + close.length) });
    rest = rest.slice(end + close.length);
  }
  tokens.push(...keyTokens(rest, key));
  return tokens;
}

function keyTokens(text: string, key: string | null): WordToken[] {
  const at = key ? text.indexOf(key) : -1;
  if (!key || at === -1) return text ? [{ kind: 'text', text }] : [];
  const tokens: WordToken[] = [];
  if (at > 0) tokens.push({ kind: 'text', text: text.slice(0, at) });
  tokens.push({ kind: 'key', text: key });
  if (at + key.length < text.length) tokens.push({ kind: 'text', text: text.slice(at + key.length) });
  return tokens;
}

/** An address split into its origin, its path, and its query and fragment; text that is no address is all path. */
export function urlParts(address: string): { origin: string; path: string; rest: string } {
  const match = /^([a-z][\w+.-]*:\/\/[^/?#]*)?([^?#]*)(.*)$/is.exec(address);
  if (!match) return { origin: '', path: address, rest: '' };
  return { origin: match[1] ?? '', path: match[2] ?? '', rest: match[3] ?? '' };
}
