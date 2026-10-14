/**
 * The one syntax-highlighting setup, shared by the dashboard components and
 * the offline export. Add a language here and every surface gets it.
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** C#, for a path or fence that names it only: auto-detection keeps to the languages it always chose from. */
const csharpNamed: typeof csharp = (api) => ({ ...csharp(api), disableAutodetect: true });

const LANGUAGES = {
  bash,
  csharp: csharpNamed,
  css,
  diff,
  javascript,
  json,
  powershell,
  python,
  typescript,
  xml,
  yaml,
} as const;

for (const [name, language] of Object.entries(LANGUAGES)) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language);
}
// Aliases the codebase actually writes in fences and `lang` props.
if (!hljs.getLanguage('sh')) hljs.registerLanguage('sh', bash);
if (!hljs.getLanguage('ts')) hljs.registerLanguage('ts', typescript);
if (!hljs.getLanguage('js')) hljs.registerLanguage('js', javascript);
if (!hljs.getLanguage('yml')) hljs.registerLanguage('yml', yaml);
if (!hljs.getLanguage('html')) hljs.registerLanguage('html', xml);
if (!hljs.getLanguage('pwsh')) hljs.registerLanguage('pwsh', powershell);
if (!hljs.getLanguage('cs')) hljs.registerLanguage('cs', csharpNamed);

/**
 * Auto-detection walks every registered grammar, which is far too slow for a
 * multi-megabyte ARIA snapshot or trace payload.
 */
const MAX_AUTO_DETECT_CHARS = 100_000;

export interface HighlightResult {
  /** HTML with `hljs-*` spans. highlight.js escapes the source, so this is safe to inject. */
  html: string;
  /** The language actually used, or '' when the text was left plain. */
  language: string;
}

export function isKnownLanguage(lang: string | null | undefined): boolean {
  return Boolean(lang && hljs.getLanguage(lang));
}

/**
 * Highlight `code`, honoring an explicit language and falling back to
 * auto-detection. Never throws: an unhighlightable block returns escaped text.
 */
export function highlightCode(code: string, lang?: string | null): HighlightResult {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return { html: hljs.highlight(code, { language: lang, ignoreIllegals: true }).value, language: lang };
    }
    if (code.length <= MAX_AUTO_DETECT_CHARS) {
      const result = hljs.highlightAuto(code);
      return { html: result.value, language: result.language ?? '' };
    }
  } catch {
    // Fall through to plain escaped text.
  }
  return { html: escapeForPre(code), language: '' };
}

function escapeForPre(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  py: 'python',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  ps1: 'powershell',
  diff: 'diff',
  patch: 'diff',
};

/**
 * The registered language for a source path (`tests/a.spec.ts`, also with a
 * `:line` or `:line:col` suffix), or null when its extension has none.
 */
export function languageForPath(path: string | null | undefined): string | null {
  const match = /\.([a-z0-9]+)(?::\d+)*$/i.exec(path ?? '');
  return (match && EXTENSION_LANGUAGES[match[1]!.toLowerCase()]) ?? null;
}

const BLOCK_COMMENT_LANGUAGES = new Set(['typescript', 'ts', 'javascript', 'js', 'css']);

/**
 * Whether an excerpt opens inside a block comment: its first line continues a
 * comment (it starts with `*`) and a line closing a comment comes before any
 * line opening one.
 */
function opensInsideBlockComment(lines: string[]): boolean {
  const first = lines.find((line) => line.trim() !== '')?.trim() ?? '';
  if (!first.startsWith('*')) return false;
  for (const line of lines) {
    if (line.includes('/*')) return false;
    if (line.includes('*/')) return true;
  }
  return false;
}

/**
 * Highlight consecutive source lines as one block and return each line's HTML.
 * A span crossing a line break is closed at the end of the line and reopened on
 * the next, so every entry is balanced markup and a multi-line construct (a
 * block comment, a template literal) keeps its color on every line. An excerpt
 * that starts inside a block comment is read as one. An unknown language gives
 * escaped plain lines: a few lines are too little to auto-detect from.
 */
export function highlightLines(lines: string[], lang?: string | null): string[] {
  if (lines.length === 0) return [];
  if (!lang || !isKnownLanguage(lang)) return lines.map(escapeForPre);
  const lead = BLOCK_COMMENT_LANGUAGES.has(lang) && opensInsideBlockComment(lines) ? ['/*'] : [];
  const { html } = highlightCode([...lead, ...lines].join('\n'), lang);
  return splitHtmlLines(html).slice(lead.length);
}

/** {@link highlightLines} as token spans, one list per line — the form the PDF export draws. */
export function highlightLinesToSpans(lines: string[], lang?: string | null): HighlightSpan[][] {
  return highlightLines(lines, lang).map(spansFromHtml);
}

function splitHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  for (const match of html.matchAll(SPAN_TOKEN)) {
    if (match[1] !== undefined) {
      open.push(match[0]);
      line += match[0];
    } else if (match[2] !== undefined) {
      const [head, ...rest] = match[2].split('\n');
      line += head;
      for (const part of rest) {
        lines.push(line + '</span>'.repeat(open.length));
        line = open.join('') + part;
      }
    } else {
      open.pop();
      line += match[0];
    }
  }
  lines.push(line);
  return lines;
}

/** A row of a unified diff, typed as `parsePatchLines` types it. */
export interface DiffRow {
  type: 'add' | 'remove' | 'hunk' | 'context';
  text: string;
}

/**
 * Highlight the source inside a unified diff. Returns one entry per row: the
 * HTML of the code after the row's `+`, `-` or space prefix, or null for a row
 * that is not code (a hunk or file header) and for every row when the language
 * is unknown. Within a hunk the old side (context and removed lines) and the
 * new side (context and added lines) are highlighted as separate blocks, so
 * neither reads a half-edited line.
 */
export function highlightDiffRows(rows: DiffRow[], lang?: string | null): (string | null)[] {
  const out: (string | null)[] = rows.map(() => null);
  if (!lang || !isKnownLanguage(lang)) return out;

  let oldSide: number[] = [];
  let newSide: number[] = [];
  const paint = (indexes: number[]) => {
    const html = highlightLines(
      indexes.map((i) => rows[i]!.text.slice(1)),
      lang,
    );
    indexes.forEach((rowIndex, k) => {
      out[rowIndex] = html[k] ?? '';
    });
  };
  const flush = () => {
    paint(oldSide);
    paint(newSide);
    oldSide = [];
    newSide = [];
  };

  rows.forEach((row, i) => {
    const isCode = row.type === 'add' || row.type === 'remove' || (row.type === 'context' && /^( |$)/.test(row.text));
    if (!isCode) {
      flush();
      return;
    }
    if (row.type !== 'add') oldSide.push(i);
    if (row.type !== 'remove') newSide.push(i);
  });
  flush();
  return out;
}

/** A run of source text sharing one highlight.js scope, or none for plain text. */
export interface HighlightSpan {
  text: string;
  /** The innermost highlight.js scope, e.g. `keyword` or `string`; `''` when unstyled. */
  scope: string;
}

/**
 * Highlight `code` into a flat run of scoped spans — the token form a non-HTML
 * consumer (the PDF export) draws, where the HTML export takes
 * {@link highlightCode}'s markup. Newlines are preserved inside the span text so
 * the caller can lay out lines. Never throws.
 */
export function highlightToSpans(code: string, lang?: string | null): { spans: HighlightSpan[]; language: string } {
  const { html, language } = highlightCode(code, lang);
  return { spans: spansFromHtml(html), language };
}

// highlight.js output is only `<span class="…">`, `</span>` and escaped text, so
// a scanner over those three shapes recovers the token stream without a DOM.
const SPAN_TOKEN = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" };

function unescapeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (whole, name: string) => ENTITIES[name] ?? whole);
}

/** The scope a nested span stack resolves to, mirroring the dashboard's CSS. */
function scopeOf(stack: string[]): string {
  const top = stack[stack.length - 1];
  if (!top) return '';
  const inner = (top.split(/\s+/)[0] ?? '').replace(/^hljs-/, '');
  // highlight.js nests a title inside `class` for class and constructor names;
  // the dashboard paints that as a built-in via `.hljs-class .hljs-title`.
  if (inner === 'title' && stack.some((s) => /\bhljs-class\b/.test(s))) return 'built_in';
  return inner;
}

function spansFromHtml(html: string): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  const stack: string[] = [];
  for (const match of html.matchAll(SPAN_TOKEN)) {
    if (match[1] !== undefined) stack.push(match[1]);
    else if (match[2] !== undefined) spans.push({ text: unescapeEntities(match[2]), scope: scopeOf(stack) });
    else stack.pop();
  }
  return spans;
}
